// The one place the app talks to the Anthropic API.
//
// callExtractionTool() sends a system prompt and one user message, asks for a
// structured output shaped by a Zod schema, parses the text block with that
// schema (twice: the SDK helper's parse, then the schema itself, so anything the
// helper treated loosely still fails here), and writes an activity_log row with
// action "llm_call" for every call, success or failure (PRD section 13: input
// hash, model, tokens, latency, stop reason). No other module imports
// @anthropic-ai/sdk.
//
// Why structured outputs and not forced tool use: tool_choice {type: "tool"} and
// {type: "any"} return HTTP 400 on claude-sonnet-5-5 and claude-opus-5-5, so the
// PRD's "forced tool use" is implemented as output_config.format with
// zodOutputFormat. The schema must be a closed object (every property present,
// nullable rather than optional, arrays of {key, value} pairs instead of
// records, no unions of objects, enums via z.enum). No thinking, temperature,
// top_p, top_k, or tool_choice parameters are sent.
//
// Why messages.create() and not messages.parse(): parse() runs the format's
// JSON parse on every text block before it returns the message, so on a
// truncated output (stop_reason max_tokens or model_context_window_exceeded)
// or a refusal that carries text it throws the SDK's JSON error and the caller
// never sees message.usage or stop_reason. create() returns the message as is;
// the usage and stop reason are read first, the clear errors for a refusal or
// a cut-off come next, and only a complete output is parsed. The llm_call row
// therefore carries the token counts and stop reason of a failed call too.
//
// new Anthropic() reads ANTHROPIC_API_KEY from the environment. Tests pass a
// fake client through args.client; nothing else does. Fixture tests never reach
// this module; they run on recordings under fixtures/recorded/.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { z } from "zod";
import type { Db } from "@/lib/db/client";

export const PARSE_MODEL_DEFAULT = "claude-sonnet-5-5";

/** Output budget per call. A refusal or a cut-off at this limit is an error, never a partial result. */
export const MAX_OUTPUT_TOKENS = 16000;

/**
 * The slice of the Anthropic client this module uses. An Anthropic instance
 * satisfies it; tests pass an object that returns canned messages.
 */
export type ExtractionClient = {
  messages: { create(params: MessageCreateParamsNonStreaming): Promise<Message> };
};

export type ExtractionCallArgs<T> = {
  supabase: Db;
  brokerId: string;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  toolName: string;
  system: string;
  userContent: string;
  schema: z.ZodType<T>;
  model?: string;
  /** Tests only: stands in for new Anthropic(). */
  client?: ExtractionClient;
};

export type ExtractionCallResult<T> = {
  output: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

/** The model to call: an explicit argument, else PARSE_MODEL from the environment, else the default. */
export function resolveParseModel(explicit?: string): string {
  const fromArg = explicit?.trim();
  if (fromArg) return fromArg;
  const fromEnv = process.env.PARSE_MODEL?.trim();
  return fromEnv ? fromEnv : PARSE_MODEL_DEFAULT;
}

/** sha256 hex of system + userContent: the input hash logged with every call. */
export function inputSha256(system: string, userContent: string): string {
  return createHash("sha256").update(system).update(userContent).digest("hex");
}

type LlmCallPayload = {
  tool: string;
  model: string;
  input_sha256: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  stop_reason: string | null;
  error?: string;
};

/** The text of the first text block, or null when the message holds none. */
function firstText(message: Message): string | null {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  return null;
}

export async function callExtractionTool<T>(args: ExtractionCallArgs<T>): Promise<ExtractionCallResult<T>> {
  const model = resolveParseModel(args.model);
  const input_sha256 = inputSha256(args.system, args.userContent);
  const started = Date.now();

  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;
  let outcome: { ok: true; output: T } | { ok: false; error: unknown };

  try {
    const client: ExtractionClient = args.client ?? new Anthropic();
    const format = zodOutputFormat(args.schema);
    const message = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: args.system,
      messages: [{ role: "user", content: args.userContent }],
      output_config: { format },
    });

    inputTokens = message.usage.input_tokens;
    outputTokens = message.usage.output_tokens;
    stopReason = message.stop_reason;

    if (message.stop_reason === "refusal") {
      throw new Error(`The model (${model}) refused this extraction request. Nothing was parsed.`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error(
        `The model (${model}) hit the ${MAX_OUTPUT_TOKENS} output token limit before finishing. The document is too long for one call; nothing was parsed.`,
      );
    }
    if (message.stop_reason === "model_context_window_exceeded") {
      throw new Error(
        `The model (${model}) ran out of context window before finishing. The document is too long for one call; nothing was parsed.`,
      );
    }

    const text = firstText(message);
    if (text === null) {
      throw new Error(
        `The model (${model}) returned no structured output (stop_reason ${message.stop_reason ?? "unknown"}).`,
      );
    }

    // format.parse: JSON.parse plus the schema (the SDK's own helper). Then the
    // schema again, so a schema the helper treated loosely still fails here
    // rather than downstream.
    outcome = { ok: true, output: args.schema.parse(format.parse(text)) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const latencyMs = Date.now() - started;
  const payload: LlmCallPayload = {
    tool: args.toolName,
    model,
    input_sha256,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    latency_ms: latencyMs,
    stop_reason: stopReason,
  };

  if (outcome.ok) {
    await logLlmCall(args, payload);
    return { output: outcome.output, model, inputTokens, outputTokens, latencyMs };
  }

  try {
    await logLlmCall(args, { ...payload, error: errorMessage(outcome.error) });
  } catch {
    // The call failure is the error to surface; a logging failure must not hide it.
  }
  throw outcome.error;
}

async function logLlmCall<T>(args: ExtractionCallArgs<T>, payload: LlmCallPayload): Promise<void> {
  const { error } = await args.supabase.from("activity_log").insert({
    broker_id: args.brokerId,
    entity_type: args.entityType,
    entity_id: args.entityId,
    action: "llm_call",
    actor_user_id: args.actorUserId,
    payload,
  });
  if (error) {
    throw new Error(`Could not write the llm_call activity row: ${error.message}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

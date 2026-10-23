// callExtractionTool() against a fake client and a fake database: no network,
// no key. The fake client returns a canned Message; the fake database records
// every activity_log insert. The cases cover what the live path must get right
// without a live call: the request shape, the clear errors for a refusal or a
// cut-off, the double validation, and the llm_call row written for success and
// for every failure with the usage and stop reason of the call that failed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import {
  callExtractionTool,
  inputSha256,
  MAX_OUTPUT_TOKENS,
  PARSE_MODEL_DEFAULT,
  resolveParseModel,
  type ExtractionCallArgs,
  type ExtractionClient,
} from "./extract";
import { extractMaterialLinesOutputSchema, type ExtractMaterialLinesOutput } from "./schema";

type CreateParams = Parameters<ExtractionClient["messages"]["create"]>[0];
type FakeMessage = Awaited<ReturnType<ExtractionClient["messages"]["create"]>>;

type Canned = {
  stop_reason: string | null;
  /** The text block the model returned; null for a message with no content. */
  text: string | null;
  input_tokens?: number;
  output_tokens?: number;
};

function fakeClient(canned: Canned, calls: CreateParams[] = []): ExtractionClient {
  return {
    messages: {
      async create(params) {
        calls.push(params);
        const message = {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: params.model,
          content: canned.text === null ? [] : [{ type: "text", text: canned.text, citations: null }],
          stop_reason: canned.stop_reason,
          stop_sequence: null,
          usage: {
            input_tokens: canned.input_tokens ?? 1234,
            output_tokens: canned.output_tokens ?? 567,
            cache_creation: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            inference_geo: null,
            server_tool_use: null,
            service_tier: null,
          },
          container: null,
        };
        return message as unknown as FakeMessage;
      },
    },
  };
}

type LoggedRow = {
  broker_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
};

function fakeDb(rows: LoggedRow[], options: { failInsert?: boolean } = {}): Db {
  const db = {
    from(table: string) {
      return {
        async insert(row: LoggedRow) {
          if (table !== "activity_log") throw new Error(`unexpected table ${table}`);
          if (options.failInsert) return { error: { message: "insert refused" } };
          rows.push(row);
          return { error: null };
        },
      };
    },
  };
  return db as unknown as Db;
}

const VALID_OUTPUT: ExtractMaterialLinesOutput = {
  lines: [
    {
      raw_text: "W12x26 x 50' qty 8",
      span: { start: 20, end: 38 },
      product_type: "W12x26",
      category: "w_beam",
      dims: [
        { key: "d", value: "12" },
        { key: "wt", value: "26" },
      ],
      grade_spec: null,
      qty: 8,
      unit: "pcs",
      length_ft: 50,
      length_text: "50'",
      cut_to_length: false,
      delivery_notes: null,
      alternates_mentioned: [],
      confidence: 0.9,
      flags: [],
    },
  ],
  notes: null,
};
const VALID_JSON = JSON.stringify(VALID_OUTPUT);
// The shape of a max_tokens cut-off: the JSON stops mid-object.
const TRUNCATED_JSON = VALID_JSON.slice(0, 40);

const BROKER = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

function args(
  canned: Canned,
  rows: LoggedRow[],
  extra: Partial<ExtractionCallArgs<ExtractMaterialLinesOutput>> = {},
  calls: CreateParams[] = [],
): ExtractionCallArgs<ExtractMaterialLinesOutput> {
  return {
    supabase: fakeDb(rows),
    brokerId: BROKER,
    actorUserId: USER,
    entityType: "request",
    entityId: REQUEST,
    toolName: "extract_material_lines",
    system: "You extract lines.",
    userContent: "BEGIN DOCUMENT\n=== SOURCE TEXT ===\nW12x26 x 50' qty 8\nEND DOCUMENT",
    schema: extractMaterialLinesOutputSchema,
    client: fakeClient(canned, calls),
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveParseModel", () => {
  it("prefers the argument, then PARSE_MODEL, then the default", () => {
    vi.stubEnv("PARSE_MODEL", "claude-opus-5-5");
    expect(resolveParseModel("  claude-haiku-5-5 ")).toBe("claude-haiku-5-5");
    expect(resolveParseModel()).toBe("claude-opus-5-5");
    vi.stubEnv("PARSE_MODEL", "   ");
    expect(resolveParseModel()).toBe(PARSE_MODEL_DEFAULT);
    expect(PARSE_MODEL_DEFAULT).toBe("claude-sonnet-5-5");
  });
});

describe("callExtractionTool: the request", () => {
  it("sends one user message with a structured output format and nothing else that is banned", async () => {
    const rows: LoggedRow[] = [];
    const calls: CreateParams[] = [];
    const a = args({ stop_reason: "end_turn", text: VALID_JSON }, rows, {}, calls);
    await callExtractionTool(a);

    expect(calls).toHaveLength(1);
    const params = calls[0] as unknown as Record<string, unknown>;
    expect(params.model).toBe(PARSE_MODEL_DEFAULT);
    expect(params.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(params.system).toBe(a.system);
    expect(params.messages).toEqual([{ role: "user", content: a.userContent }]);
    const format = (params.output_config as { format: { type: string; schema: Record<string, unknown> } }).format;
    expect(format.type).toBe("json_schema");
    expect(format.schema).toMatchObject({ type: "object" });
    for (const banned of ["tool_choice", "tools", "thinking", "temperature", "top_p", "top_k", "stream"]) {
      expect(params, banned).not.toHaveProperty(banned);
    }
  });

  it("uses the model argument when given", async () => {
    const calls: CreateParams[] = [];
    await callExtractionTool(args({ stop_reason: "end_turn", text: VALID_JSON }, [], { model: "claude-opus-5-5" }, calls));
    expect(calls[0].model).toBe("claude-opus-5-5");
  });
});

describe("callExtractionTool: success", () => {
  it("returns the validated output with the usage, and logs one llm_call row", async () => {
    const rows: LoggedRow[] = [];
    const a = args({ stop_reason: "end_turn", text: VALID_JSON, input_tokens: 2100, output_tokens: 310 }, rows);
    const result = await callExtractionTool(a);

    expect(result.output).toEqual(VALID_OUTPUT);
    expect(result.model).toBe(PARSE_MODEL_DEFAULT);
    expect(result.inputTokens).toBe(2100);
    expect(result.outputTokens).toBe(310);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      broker_id: BROKER,
      entity_type: "request",
      entity_id: REQUEST,
      action: "llm_call",
      actor_user_id: USER,
    });
    expect(rows[0].payload).toEqual({
      tool: "extract_material_lines",
      model: PARSE_MODEL_DEFAULT,
      input_sha256: inputSha256(a.system, a.userContent),
      input_tokens: 2100,
      output_tokens: 310,
      latency_ms: result.latencyMs,
      stop_reason: "end_turn",
    });
    expect(rows[0].payload).not.toHaveProperty("error");
    expect(rows[0].payload.input_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails loudly when the llm_call row cannot be written after a successful call", async () => {
    const rows: LoggedRow[] = [];
    const a = args({ stop_reason: "end_turn", text: VALID_JSON }, rows, { supabase: fakeDb(rows, { failInsert: true }) });
    await expect(callExtractionTool(a)).rejects.toThrow(/Could not write the llm_call activity row: insert refused/);
  });
});

describe("callExtractionTool: failures carry the usage and stop reason of the call", () => {
  it("names the output token limit on max_tokens, even when the truncated text is not JSON", async () => {
    const rows: LoggedRow[] = [];
    const a = args({ stop_reason: "max_tokens", text: TRUNCATED_JSON, input_tokens: 9000, output_tokens: MAX_OUTPUT_TOKENS }, rows);
    await expect(callExtractionTool(a)).rejects.toThrow(
      new RegExp(`hit the ${MAX_OUTPUT_TOKENS} output token limit before finishing`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      input_tokens: 9000,
      output_tokens: MAX_OUTPUT_TOKENS,
      stop_reason: "max_tokens",
    });
    expect(String(rows[0].payload.error)).toMatch(/output token limit/);
  });

  it("names the context window on model_context_window_exceeded", async () => {
    const rows: LoggedRow[] = [];
    const a = args({ stop_reason: "model_context_window_exceeded", text: TRUNCATED_JSON }, rows);
    await expect(callExtractionTool(a)).rejects.toThrow(/ran out of context window/);
    expect(rows[0].payload).toMatchObject({ input_tokens: 1234, output_tokens: 567, stop_reason: "model_context_window_exceeded" });
  });

  it("names the refusal whether the model returned no content or partial text", async () => {
    for (const text of [null, "I cannot help with that request.", TRUNCATED_JSON]) {
      const rows: LoggedRow[] = [];
      await expect(callExtractionTool(args({ stop_reason: "refusal", text }, rows))).rejects.toThrow(/refused this extraction request/);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({ input_tokens: 1234, output_tokens: 567, stop_reason: "refusal" });
      expect(String(rows[0].payload.error)).toMatch(/refused/);
    }
  });

  it("reports a message with no text block as no structured output", async () => {
    const rows: LoggedRow[] = [];
    await expect(callExtractionTool(args({ stop_reason: "end_turn", text: null }, rows))).rejects.toThrow(
      /returned no structured output \(stop_reason end_turn\)/,
    );
    expect(rows[0].payload).toMatchObject({ stop_reason: "end_turn", input_tokens: 1234 });
  });

  it("rejects text that is not JSON on a normal stop, and still logs the usage", async () => {
    const rows: LoggedRow[] = [];
    await expect(callExtractionTool(args({ stop_reason: "end_turn", text: TRUNCATED_JSON }, rows))).rejects.toThrow(/JSON/);
    expect(rows[0].payload).toMatchObject({ stop_reason: "end_turn", input_tokens: 1234, output_tokens: 567 });
    expect(rows[0].payload).toHaveProperty("error");
  });

  it("rejects JSON that does not fit the schema (a flag the model may not set, a fraction as a number)", async () => {
    const offSchema = {
      lines: [{ ...VALID_OUTPUT.lines[0], flags: ["missing_grade"], dims: [{ key: "t", value: 0.625 }] }],
      notes: null,
    };
    const rows: LoggedRow[] = [];
    await expect(callExtractionTool(args({ stop_reason: "end_turn", text: JSON.stringify(offSchema) }, rows))).rejects.toThrow(
      /structured output/,
    );
    expect(rows[0].payload).toMatchObject({ stop_reason: "end_turn" });
    expect(rows[0].payload).toHaveProperty("error");
  });

  it("validates with the schema it was given a second time", async () => {
    // A schema stricter than the format: the format accepts the JSON, the second parse must not.
    const strict = extractMaterialLinesOutputSchema.refine((o) => o.lines.length === 0, "no lines allowed");
    const rows: LoggedRow[] = [];
    const a: ExtractionCallArgs<ExtractMaterialLinesOutput> = {
      ...args({ stop_reason: "end_turn", text: VALID_JSON }, rows),
      schema: strict as unknown as z.ZodType<ExtractMaterialLinesOutput>,
    };
    await expect(callExtractionTool(a)).rejects.toThrow(/no lines allowed/);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].payload.error)).toMatch(/no lines allowed/);
  });

  it("surfaces the call failure even when the failure row cannot be written", async () => {
    const rows: LoggedRow[] = [];
    const a = args({ stop_reason: "max_tokens", text: TRUNCATED_JSON }, rows, { supabase: fakeDb(rows, { failInsert: true }) });
    await expect(callExtractionTool(a)).rejects.toThrow(/output token limit/);
    expect(rows).toHaveLength(0);
  });

  it("rethrows a transport error and logs it with zero tokens and no stop reason", async () => {
    const rows: LoggedRow[] = [];
    const client: ExtractionClient = {
      messages: {
        async create() {
          throw new Error("ECONNRESET");
        },
      },
    };
    await expect(callExtractionTool(args({ stop_reason: null, text: null }, rows, { client }))).rejects.toThrow(/ECONNRESET/);
    expect(rows[0].payload).toMatchObject({ input_tokens: 0, output_tokens: 0, stop_reason: null, error: "ECONNRESET" });
  });
});

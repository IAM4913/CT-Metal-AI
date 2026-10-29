// Refresh the recorded model outputs the parser tests run on.
//
//   npm run record-fixtures                                   every request and reply fixture
//   npm run record-fixtures -- requests                       every request fixture
//   npm run record-fixtures -- replies                        every reply fixture
//   npm run record-fixtures -- mixed-list.eml quote.pdf.eml   a subset, from either list
//
// Requests: for each fixture under fixtures/requests/, build the extraction
// document exactly as parseRequest builds it from a stored request
// (src/lib/parsing/fixture-documents.ts), call the model through
// callExtractionTool() (the one path to the Anthropic API; it validates the
// output with the Zod schema and logs an llm_call activity row), and write
// fixtures/recorded/requests/<name>.json as
//   { fixture, source: "recorded", model, recorded_at, document_sha256, output }
// src/lib/parsing/fixtures.test.ts then runs offline against those files.
//
// Replies: for each fixture under fixtures/replies/, build the document exactly
// as extractOffer builds it from a stored offer
// (src/lib/parsing/offer-fixture-documents.ts), hand the model the fixture's
// fixed RFQ context (REPLY_FIXTURE_CONTEXTS) through the extract_offer_lines
// prompt, and write fixtures/recorded/replies/<name>.json as
//   { fixture, source: "recorded", model, recorded_at, document_sha256,
//     received_at, context, output }
// received_at is the fixed REPLY_RECEIVED_AT the reply fixtures are defined
// with; src/lib/parsing/offer-fixtures.test.ts normalizes against it.
//
// Either way a recording that no longer matches its fixture's document fails
// the tests, which is the point of storing the sha256.
//
// Environment (.env.local is loaded when present, see SETUP.md):
//   ANTHROPIC_API_KEY            required; the script exits before any call without it
//   PARSE_MODEL                  optional; default claude-sonnet-5-5 (src/lib/parsing/extract.ts)
//   NEXT_PUBLIC_SUPABASE_URL     required; the llm_call row is written with the
//   SUPABASE_SECRET_KEY          admin client (built directly, as scripts/seed.ts
//                                does) under the seed broker, which must exist
//
// activity_log.entity_id is a uuid, so the row cannot carry a fixture name:
// entity_type is "fixture" and entity_id is fixtureEntityId(name), a name-based
// uuid that is the same on every run (request and reply fixture names never
// collide). The mapping is printed with each result.
//
// The deterministic pass is run on each result for the printed summary only
// (line count, links, flags); nothing but the recording file is written.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateCatalog } from "@/lib/catalog/generate";
import type { Database } from "@/lib/db/types";
import { REPLY_FIXTURES, REQUEST_FIXTURES, type ReplyFixtureName, type RequestFixtureName } from "@/lib/fixtures";
import { aliasIndexFromCatalog, type AliasIndex } from "@/lib/parsing/alias-index";
import { callExtractionTool, resolveParseModel } from "@/lib/parsing/extract";
import {
  buildFixtureDocument,
  fixtureEntityId,
  recordingPath,
  recordingSchema,
  type Recording,
} from "@/lib/parsing/fixture-documents";
import { normalizeExtractedLines } from "@/lib/parsing/normalize";
import {
  buildReplyFixtureDocument,
  REPLY_FIXTURE_CONTEXTS,
  replyRecordingPath,
  replyRecordingSchema,
  type ReplyRecording,
} from "@/lib/parsing/offer-fixture-documents";
import { normalizeOfferOutput } from "@/lib/parsing/offers-normalize";
import { buildOfferUserMessage, OFFER_SYSTEM_PROMPT } from "@/lib/parsing/offers-prompt";
import { EXTRACT_OFFER_LINES, extractOfferLinesOutputSchema } from "@/lib/parsing/offers-schema";
import { buildExtractionUserMessage, EXTRACTION_SYSTEM_PROMPT } from "@/lib/parsing/prompt";
import { EXTRACT_MATERIAL_LINES, extractMaterialLinesOutputSchema } from "@/lib/parsing/schema";
import { SEED_BROKER_NAME } from "./seed-data";

// The same client type src/lib/db/client.ts exports as Db. That module is not
// imported here because it loads next/headers, which cannot run outside Next.
type Db = SupabaseClient<Database>;

type RecordEnv = { url: string; secretKey: string };

type Selection = { requests: RequestFixtureName[]; replies: ReplyFixtureName[] };

/** Command-line words that select a whole group instead of one fixture. */
const GROUP_WORDS = ["requests", "replies"] as const;

function fail(message: string): never {
  console.error(`record-fixtures: ${message}`);
  process.exit(1);
}

function requireEnv(name: string, why: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fail(`${name} is not set. ${why} Copy .env.local.example to .env.local and fill it in (see SETUP.md), or export the variable.`);
  }
  return value.trim();
}

function loadEnv(): RecordEnv {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local in the working directory; the variables may be exported.
  }
  requireEnv(
    "ANTHROPIC_API_KEY",
    "Recording calls the Anthropic API and cannot run without a key; the committed recordings are unchanged.",
  );
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", "Every model call is logged to activity_log with the admin client.");
  const secretKey = requireEnv("SUPABASE_SECRET_KEY", "Every model call is logged to activity_log with the admin client.");
  return { url, secretKey };
}

function isRequestFixture(name: string): name is RequestFixtureName {
  return (REQUEST_FIXTURES as readonly string[]).includes(name);
}

function isReplyFixture(name: string): name is ReplyFixtureName {
  return (REPLY_FIXTURES as readonly string[]).includes(name);
}

/**
 * The fixtures named on the command line, or all of them. "requests" and
 * "replies" select a whole group. Unknown names stop the run before any call.
 */
function selectFixtures(args: string[]): Selection {
  if (args.length === 0) return { requests: [...REQUEST_FIXTURES], replies: [...REPLY_FIXTURES] };

  const unknown = args.filter((a) => !isRequestFixture(a) && !isReplyFixture(a) && !(GROUP_WORDS as readonly string[]).includes(a));
  if (unknown.length > 0) {
    return fail(
      `Unknown fixture ${unknown.map((u) => JSON.stringify(u)).join(", ")}. ` +
        `Known requests: ${REQUEST_FIXTURES.join(", ")}. Known replies: ${REPLY_FIXTURES.join(", ")}. ` +
        `Or "requests" / "replies" for a whole group.`,
    );
  }

  const requests = new Set<RequestFixtureName>(args.includes("requests") ? REQUEST_FIXTURES : []);
  const replies = new Set<ReplyFixtureName>(args.includes("replies") ? REPLY_FIXTURES : []);
  for (const arg of args) {
    if (isRequestFixture(arg)) requests.add(arg);
    if (isReplyFixture(arg)) replies.add(arg);
  }
  return { requests: [...requests], replies: [...replies] };
}

async function seedBrokerId(db: Db): Promise<string> {
  const { data, error } = await db.from("brokers").select("id").eq("name", SEED_BROKER_NAME).limit(1);
  if (error) {
    return fail(`Could not read brokers: ${error.message}`);
  }
  const broker = data?.[0];
  if (!broker) {
    return fail(`Seed broker ${JSON.stringify(SEED_BROKER_NAME)} was not found. Run npm run seed first.`);
  }
  return broker.id;
}

function writeRecording(file: string, recording: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

async function recordRequest(db: Db, brokerId: string, index: AliasIndex, name: RequestFixtureName): Promise<void> {
  const { doc, sha256 } = await buildFixtureDocument(name);
  const entityId = fixtureEntityId(name);

  const result = await callExtractionTool({
    supabase: db,
    brokerId,
    actorUserId: null,
    entityType: "fixture",
    entityId,
    toolName: EXTRACT_MATERIAL_LINES,
    system: EXTRACTION_SYSTEM_PROMPT,
    userContent: buildExtractionUserMessage(doc),
    schema: extractMaterialLinesOutputSchema,
  });

  const recording: Recording = recordingSchema.parse({
    fixture: name,
    source: "recorded",
    model: result.model,
    recorded_at: new Date().toISOString(),
    document_sha256: sha256,
    output: result.output,
  } satisfies Recording);

  const file = recordingPath(name);
  writeRecording(file, recording);

  const lines = normalizeExtractedLines(result.output, doc, index);
  const unverified = lines.filter((line) => !line.span_verified).length;
  console.log(
    `${name}: ${lines.length} line(s), ${result.inputTokens} in / ${result.outputTokens} out, ${result.latencyMs} ms, ` +
      `${unverified} unverified span(s), logged as fixture ${entityId} -> ${path.relative(process.cwd(), file)}`,
  );
  for (const line of lines) {
    const link = line.catalog_item_id ? "" : " (unmatched)";
    const flags = line.flags.length > 0 ? ` [${line.flags.join(", ")}]` : "";
    const span = line.span_verified ? "" : " span unverified";
    console.log(`  ${line.line_no}. ${line.description}${link}${flags}${span}`);
  }
  if (result.output.notes) {
    console.log(`  notes: ${result.output.notes}`);
  }
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

async function recordReply(db: Db, brokerId: string, index: AliasIndex, name: ReplyFixtureName): Promise<void> {
  const { doc, sha256, receivedAt } = await buildReplyFixtureDocument(name);
  const context = REPLY_FIXTURE_CONTEXTS[name];
  const entityId = fixtureEntityId(name);

  const result = await callExtractionTool({
    supabase: db,
    brokerId,
    actorUserId: null,
    entityType: "fixture",
    entityId,
    toolName: EXTRACT_OFFER_LINES,
    system: OFFER_SYSTEM_PROMPT,
    userContent: buildOfferUserMessage(doc, context),
    schema: extractOfferLinesOutputSchema,
  });

  const recording: ReplyRecording = replyRecordingSchema.parse({
    fixture: name,
    source: "recorded",
    model: result.model,
    recorded_at: new Date().toISOString(),
    document_sha256: sha256,
    received_at: receivedAt.toISOString(),
    context,
    output: result.output,
  } satisfies ReplyRecording);

  const file = replyRecordingPath(name);
  writeRecording(file, recording);

  const { meta, lines } = normalizeOfferOutput(result.output, doc, context, index, receivedAt);
  const unverified = lines.filter((line) => !line.span_verified).length;
  const untied = lines.filter((line) => line.request_line_id === null).length;
  console.log(
    `${name}: ${meta.declined ? "declined, " : ""}${lines.length} line(s), ${result.inputTokens} in / ${result.outputTokens} out, ` +
      `${result.latencyMs} ms, ${unverified} unverified span(s), ${untied} untied line(s), ` +
      `logged as fixture ${entityId} -> ${path.relative(process.cwd(), file)}`,
  );
  lines.forEach((line, i) => {
    const tie = line.request_line_id ? context.find((c) => c.request_line_id === line.request_line_id)?.designation ?? line.request_line_id : "(untied)";
    const price = line.unit_price === null ? "no price" : `${line.unit_price}${line.price_basis ? ` ${line.price_basis}` : ""}`;
    const qty = line.available_qty === null ? "no qty" : `${line.available_qty}${line.unit ? ` ${line.unit}` : ""}`;
    const ready = line.ready_date ? `, ready ${line.ready_date}` : "";
    const flags = line.flags.length > 0 ? ` [${line.flags.join(", ")}]` : "";
    const span = line.span_verified ? "" : " span unverified";
    console.log(`  ${i + 1}. ${line.offered_desc} for ${tie}: ${qty}, ${price}, ${line.availability}${ready}${flags}${span}`);
  });
  const terms = [
    meta.payment_terms ? `terms ${meta.payment_terms}` : null,
    meta.early_pay_pct !== null ? `early pay ${meta.early_pay_pct}%${meta.early_pay_days !== null ? ` / ${meta.early_pay_days} days` : ""}` : null,
    `freight ${meta.freight_basis}${meta.freight_amount !== null ? ` ${meta.freight_amount}` : ""}`,
    meta.quote_expires_at ? `expires ${meta.quote_expires_at}` : null,
    meta.decline_reason ? `declined: ${meta.decline_reason}` : null,
  ].filter((part): part is string => part !== null);
  console.log(`  meta: ${terms.join("; ")}`);
  if (meta.notes) {
    console.log(`  notes: ${meta.notes}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const selection = selectFixtures(process.argv.slice(2));
  const total = selection.requests.length + selection.replies.length;
  const env = loadEnv();
  const model = resolveParseModel();

  const db: Db = createClient<Database>(env.url, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const brokerId = await seedBrokerId(db);
  const index = aliasIndexFromCatalog(generateCatalog());

  console.log(`Recording ${selection.requests.length} request and ${selection.replies.length} reply fixture(s) with ${model}.`);
  const failures: string[] = [];
  for (const name of selection.requests) {
    try {
      await recordRequest(db, brokerId, index, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${name}: FAILED: ${message}`);
      failures.push(name);
    }
  }
  for (const name of selection.replies) {
    try {
      await recordReply(db, brokerId, index, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${name}: FAILED: ${message}`);
      failures.push(name);
    }
  }

  if (failures.length > 0) {
    fail(`${failures.length} of ${total} fixture(s) failed: ${failures.join(", ")}. The other recordings were written. Run npm test to check them.`);
  }
  console.log(`Done. Run npm test to check the recordings against the step contract.`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });

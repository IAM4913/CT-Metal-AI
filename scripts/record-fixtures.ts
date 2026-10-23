// Refresh the recorded model outputs the parser tests run on.
//
//   npm run record-fixtures                               every request fixture
//   npm run record-fixtures -- mixed-list.eml pdf-list.eml   a subset
//
// For each fixture under fixtures/requests/: build the extraction document
// exactly as parseRequest builds it from a stored request
// (src/lib/parsing/fixture-documents.ts), call the model through
// callExtractionTool() (the one path to the Anthropic API; it validates the
// output with the Zod schema and logs an llm_call activity row), and write
// fixtures/recorded/requests/<name>.json as
//   { fixture, source: "recorded", model, recorded_at, document_sha256, output }
// src/lib/parsing/fixtures.test.ts then runs offline against those files and
// fails when a recording no longer matches its fixture's document.
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
// uuid that is the same on every run. The mapping is printed with each result.
//
// The deterministic pass is run on each result for the printed summary only
// (line count, links, flags); nothing but the recording file is written.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateCatalog } from "@/lib/catalog/generate";
import type { Database } from "@/lib/db/types";
import { REQUEST_FIXTURES, type RequestFixtureName } from "@/lib/fixtures";
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
import { buildExtractionUserMessage, EXTRACTION_SYSTEM_PROMPT } from "@/lib/parsing/prompt";
import { EXTRACT_MATERIAL_LINES, extractMaterialLinesOutputSchema } from "@/lib/parsing/schema";
import { SEED_BROKER_NAME } from "./seed-data";

// The same client type src/lib/db/client.ts exports as Db. That module is not
// imported here because it loads next/headers, which cannot run outside Next.
type Db = SupabaseClient<Database>;

type RecordEnv = { url: string; secretKey: string };

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

/** The fixtures named on the command line, or all of them. Unknown names stop the run before any call. */
function selectFixtures(args: string[]): RequestFixtureName[] {
  if (args.length === 0) return [...REQUEST_FIXTURES];
  const unknown = args.filter((a) => !isRequestFixture(a));
  if (unknown.length > 0) {
    return fail(`Unknown fixture ${unknown.map((u) => JSON.stringify(u)).join(", ")}. Known: ${REQUEST_FIXTURES.join(", ")}.`);
  }
  return Array.from(new Set(args.filter(isRequestFixture)));
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

async function recordOne(db: Db, brokerId: string, index: AliasIndex, name: RequestFixtureName): Promise<void> {
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
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);

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

async function main(): Promise<void> {
  const names = selectFixtures(process.argv.slice(2));
  const env = loadEnv();
  const model = resolveParseModel();

  const db: Db = createClient<Database>(env.url, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const brokerId = await seedBrokerId(db);
  const index = aliasIndexFromCatalog(generateCatalog());

  console.log(`Recording ${names.length} fixture(s) with ${model}.`);
  const failures: string[] = [];
  for (const name of names) {
    try {
      await recordOne(db, brokerId, index, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${name}: FAILED: ${message}`);
      failures.push(name);
    }
  }

  if (failures.length > 0) {
    fail(`${failures.length} of ${names.length} fixture(s) failed: ${failures.join(", ")}. The other recordings were written. Run npm test to check them.`);
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

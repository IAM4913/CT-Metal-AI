// Request fixtures as extraction documents, built the way parseRequest builds
// them from a stored request, so a recording made from a fixture describes the
// same document the server would send for that fixture (PRD section 15, PLAN
// Step 4 fixture tests).
//
//   .txt   one text segment holding the file as utf8 (the paste path stores the
//          textarea value unchanged, trailing newline included)
//   .eml   parseEml(): the text part becomes the text segment; every PDF
//          attachment becomes one attachment segment per page, with the
//          attachment id "fixture-attachment-<n>" (n counts PDF attachments from
//          1, in the order they appear) and the attachment's filename
//
// The document's sha256 is recorded with every model output under
// fixtures/recorded/requests/ and checked by the tests, so a changed fixture
// (or a changed header format in ./document.ts) invalidates the recording
// instead of silently passing against text the model never saw.
//
// Node-only (fs through src/lib/fixtures.ts). Imported by tests and scripts,
// never by app code.

import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { fixtureRoot, readFixture, REQUEST_FIXTURES } from "@/lib/fixtures";
import { parseEml } from "@/lib/mail/eml";
import { extractPdfPages } from "@/lib/mail/pdf-text";
import { buildExtractionDocument, type DocumentSegment, type ExtractionDocument } from "./document";
import { extractMaterialLinesOutputSchema } from "./schema";

const PDF_MIME = "application/pdf";

/** Attachment id used for the n-th PDF attachment of a fixture (n from 1). */
export function fixtureAttachmentId(n: number): string {
  return `fixture-attachment-${n}`;
}

/** "mixed-list.eml" -> "mixed-list"; the recording is named after the fixture without its extension. */
export function fixtureBaseName(name: string): string {
  return name.replace(/\.(txt|eml)$/i, "");
}

/** Absolute path of the recording for a request fixture: fixtures/recorded/requests/<base>.json. */
export function recordingPath(name: string): string {
  return path.join(fixtureRoot(), "recorded", "requests", `${fixtureBaseName(name)}.json`);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A stable uuid for a fixture, for activity_log.entity_id (a uuid column) when
 * scripts/record-fixtures.ts logs the llm_call row with entity_type "fixture".
 * Name-based (version 5 layout over sha1 of "anvil-fixture:<name>"), so every
 * recording run of the same fixture logs under the same id.
 */
export function fixtureEntityId(name: string): string {
  const bytes = createHash("sha1").update(`anvil-fixture:${name}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type FixtureDocument = { doc: ExtractionDocument; sha256: string };

/**
 * Build the extraction document for a request fixture by its file name
 * ("single-hss.txt", "pdf-list.eml"). Throws for a name that is neither .txt
 * nor .eml, or that is not under fixtures/requests/.
 */
export async function buildFixtureDocument(name: string): Promise<FixtureDocument> {
  const segments = await fixtureSegments(name);
  const doc = buildExtractionDocument(segments);
  return { doc, sha256: sha256Hex(doc.text) };
}

export async function fixtureSegments(name: string): Promise<DocumentSegment[]> {
  const bytes = readFixture(`requests/${name}`);
  if (/\.txt$/i.test(name)) {
    return [{ kind: "text", text: bytes.toString("utf8") }];
  }
  if (!/\.eml$/i.test(name)) {
    throw new Error(`Fixture ${name} is neither .txt nor .eml; buildFixtureDocument cannot read it.`);
  }

  const mail = await parseEml(bytes);
  const segments: DocumentSegment[] = [{ kind: "text", text: mail.text }];
  let pdfCount = 0;
  for (const attachment of mail.attachments) {
    if (attachment.contentType.toLowerCase() !== PDF_MIME) continue;
    pdfCount += 1;
    const attachmentId = fixtureAttachmentId(pdfCount);
    const pages = await extractPdfPages(attachment.content);
    pages.forEach((text, i) => {
      segments.push({ kind: "attachment", attachmentId, filename: attachment.filename, page: i + 1, text });
    });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

/** The file shape under fixtures/recorded/requests/. */
export const recordingSchema = z.object({
  fixture: z.enum(REQUEST_FIXTURES),
  source: z.enum(["hand-authored", "recorded"]),
  model: z.string().min(1),
  recorded_at: z.iso.datetime(),
  document_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  output: extractMaterialLinesOutputSchema,
});

export type Recording = z.infer<typeof recordingSchema>;

/** Parse a recording file's text, failing loudly on anything off-shape. */
export function parseRecording(json: string): Recording {
  return recordingSchema.parse(JSON.parse(json));
}

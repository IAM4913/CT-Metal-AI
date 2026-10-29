// Reply fixtures as extraction documents, built the way extractOffer builds
// them from a stored offer (buildOfferSegments in src/lib/server/offers.ts), so
// a recording made from a reply fixture describes the same document the server
// would send for that reply (PRD section 15 replies 1 to 5, PLAN Step 6).
//
//   .txt   one text segment holding the file as utf8 (the paste path stores the
//          textarea value unchanged, trailing newline included)
//   .eml   parseEml(): the text part becomes the text segment (only when it has
//          some text, as on the server); every PDF attachment becomes one
//          attachment segment per page, with the attachment id
//          "fixture-attachment-<n>" (n counts PDF attachments from 1, in the
//          order they appear) and the attachment's filename
//
// A reply is read against the RFQ lines it answers, so every fixture has a
// fixed context (REPLY_FIXTURE_CONTEXTS: the request lines the vendor was asked
// to quote, with stable ids) and a fixed arrival time (REPLY_RECEIVED_AT). Both
// are stored in the recording under fixtures/recorded/replies/ and checked by
// src/lib/parsing/offer-fixtures.test.ts; ready dates and quote expiry are read
// relative to received_at, so changing it changes the expected values. The
// document's sha256 is recorded as it is for requests, so a changed fixture (or
// a changed header format in ./document.ts) invalidates the recording instead
// of silently passing against text the model never saw.
//
// Node-only (fs through src/lib/fixtures.ts). Imported by tests and scripts,
// never by app code.

import path from "node:path";
import { z } from "zod";
import { lineUnitSchema, materialCategorySchema } from "@/lib/db/enums";
import { fixtureRoot, readFixture, REPLY_FIXTURES, type ReplyFixtureName } from "@/lib/fixtures";
import { parseEml } from "@/lib/mail/eml";
import { extractPdfPages } from "@/lib/mail/pdf-text";
import { buildExtractionDocument, type DocumentSegment, type ExtractionDocument } from "./document";
import { fixtureAttachmentId, fixtureBaseName, sha256Hex } from "./fixture-documents";
import type { OfferContextLine } from "./offers-prompt";
import { extractOfferLinesOutputSchema } from "./offers-schema";

const PDF_MIME = "application/pdf";

/** When every reply fixture is taken to have arrived. Ready dates and quote expiry are read relative to it. */
export const REPLY_RECEIVED_AT = new Date("2026-10-22T15:00:00.000Z");

/**
 * The stable request_line_id of fixture context line n:
 * 11111111-1111-4111-8111-<n, zero-padded to 12 digits>. A well-formed uuid
 * (version nibble 4, variant 8) that no database ever mints.
 */
export function replyFixtureLineId(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999_999_999_999) {
    throw new Error(`Fixture line number out of range: ${n}`);
  }
  return `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
}

// The request lines the reply fixtures answer (PRD section 15: the single HSS
// requests, the heavier channel, and the four-item mixed list).
const HSS_8X8X3_8: OfferContextLine = {
  request_line_id: replyFixtureLineId(1),
  line_no: 1,
  designation: "HSS8x8x3/8",
  description: "HSS8x8x3/8",
  qty: 20,
  unit: "pcs",
  length_ft: 40,
  length_text: "40'",
  grade_spec: null,
  category: "hss_square",
  dims: { a: 8, b: 8, t: 0.375 },
};

const HSS_8X8X5_8: OfferContextLine = {
  request_line_id: replyFixtureLineId(2),
  line_no: 1,
  designation: "HSS8x8x5/8",
  description: "HSS8x8x5/8",
  qty: 100,
  unit: "pcs",
  length_ft: 40,
  length_text: "40'",
  grade_spec: "A500 Gr B",
  category: "hss_square",
  dims: { a: 8, b: 8, t: 0.625 },
};

const C12X30: OfferContextLine = {
  request_line_id: replyFixtureLineId(3),
  line_no: 1,
  designation: "C12x30",
  description: "C12x30",
  qty: 6,
  unit: "pcs",
  length_ft: 40,
  length_text: "40'",
  grade_spec: null,
  category: "channel",
  dims: { d: 12, wt: 30 },
};

const MIXED_LIST: OfferContextLine[] = [
  {
    request_line_id: replyFixtureLineId(11),
    line_no: 1,
    designation: "W12x26",
    description: "W12x26",
    qty: 8,
    unit: "pcs",
    length_ft: 50,
    length_text: "50'",
    grade_spec: null,
    category: "w_beam",
    dims: { d: 12, wt: 26 },
  },
  {
    request_line_id: replyFixtureLineId(12),
    line_no: 2,
    designation: "L2x2x1/4",
    description: "L2x2x1/4",
    qty: 40,
    unit: "pcs",
    length_ft: 20,
    length_text: "20'",
    grade_spec: null,
    category: "angle",
    dims: { a: 2, b: 2, t: 0.25 },
  },
  {
    request_line_id: replyFixtureLineId(13),
    line_no: 3,
    designation: "PL3/8",
    description: "PL3/8 48x96 A36",
    qty: 10,
    unit: "pcs",
    length_ft: null,
    length_text: null,
    grade_spec: "A36",
    category: "plate",
    dims: { t: 0.375, w: 48, l: 96 },
  },
  {
    request_line_id: replyFixtureLineId(14),
    line_no: 4,
    designation: "HSS6x6x3/8",
    description: "HSS6x6x3/8",
    qty: 20,
    unit: "pcs",
    length_ft: 24,
    length_text: "24'",
    grade_spec: null,
    category: "hss_square",
    dims: { a: 6, b: 6, t: 0.375 },
  },
];

/** The RFQ lines each reply fixture answers, as the model is given them and as the recordings store them. */
export const REPLY_FIXTURE_CONTEXTS: Record<ReplyFixtureName, OfferContextLine[]> = {
  "alt-wall-rolling.txt": [HSS_8X8X3_8],
  "partial-discount.txt": [HSS_8X8X5_8],
  "future-rolling.txt": [HSS_8X8X5_8],
  "quote.pdf.eml": MIXED_LIST,
  "decline.txt": [C12X30],
};

/** Absolute path of the recording for a reply fixture: fixtures/recorded/replies/<base>.json ("quote.pdf.eml" gives quote.pdf.json). */
export function replyRecordingPath(name: string): string {
  return path.join(fixtureRoot(), "recorded", "replies", `${fixtureBaseName(name)}.json`);
}

export type ReplyFixtureDocument = { doc: ExtractionDocument; sha256: string; receivedAt: Date };

/**
 * Build the extraction document for a reply fixture by its file name
 * ("alt-wall-rolling.txt", "quote.pdf.eml"). Throws for a name that is neither
 * .txt nor .eml (the standalone quote.pdf is not a reply fixture on its own),
 * or that is not under fixtures/replies/.
 */
export async function buildReplyFixtureDocument(name: string): Promise<ReplyFixtureDocument> {
  const segments = await replyFixtureSegments(name);
  const doc = buildExtractionDocument(segments);
  return { doc, sha256: sha256Hex(doc.text), receivedAt: REPLY_RECEIVED_AT };
}

export async function replyFixtureSegments(name: string): Promise<DocumentSegment[]> {
  const bytes = readFixture(`replies/${name}`);
  if (/\.txt$/i.test(name)) {
    return [{ kind: "text", text: bytes.toString("utf8") }];
  }
  if (!/\.eml$/i.test(name)) {
    throw new Error(`Fixture ${name} is neither .txt nor .eml; buildReplyFixtureDocument cannot read it.`);
  }

  const mail = await parseEml(bytes);
  const segments: DocumentSegment[] = [];
  if (mail.text.trim() !== "") segments.push({ kind: "text", text: mail.text });
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One context line as stored in a recording; the same shape as OfferContextLine. */
export const offerContextLineSchema = z.object({
  request_line_id: z.string().regex(UUID),
  line_no: z.number().int().positive(),
  designation: z.string().nullable(),
  description: z.string(),
  qty: z.number().nullable(),
  unit: lineUnitSchema.nullable(),
  length_ft: z.number().nullable(),
  length_text: z.string().nullable(),
  grade_spec: z.string().nullable(),
  category: materialCategorySchema.nullable(),
  dims: z.record(z.string(), z.unknown()),
});

/** The file shape under fixtures/recorded/replies/. */
export const replyRecordingSchema = z.object({
  fixture: z.enum(REPLY_FIXTURES),
  source: z.enum(["hand-authored", "recorded"]),
  model: z.string().min(1),
  recorded_at: z.iso.datetime(),
  document_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  received_at: z.iso.datetime(),
  context: z.array(offerContextLineSchema),
  output: extractOfferLinesOutputSchema,
});

export type ReplyRecording = z.infer<typeof replyRecordingSchema>;

/** Parse a reply recording file's text, failing loudly on anything off-shape. */
export function parseReplyRecording(json: string): ReplyRecording {
  return replyRecordingSchema.parse(JSON.parse(json));
}

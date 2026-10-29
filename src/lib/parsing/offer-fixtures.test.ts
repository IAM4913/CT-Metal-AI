// Fixture-driven offer extraction tests (PLAN Step 6, PRD section 15 replies 1 to 5).
//
// Each test loads the recorded model output under fixtures/recorded/replies/,
// rebuilds the extraction document from the reply fixture exactly as
// extractOffer would (src/lib/parsing/offer-fixture-documents.ts), checks that
// the recording was made from that very document (sha256) against the fixed
// RFQ context and arrival time it stores, validates the output with the Zod
// schema, runs the deterministic pass against the seed catalog, and asserts the
// line counts, request-line ties, prices, bases, availability, dates, terms,
// flags, and spans the step contract names. No network, no database: a stale
// recording fails here, and npm run record-fixtures refreshes it against the
// live model.

import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { generateCatalog } from "@/lib/catalog/generate";
import { readFixture, REPLY_FIXTURES, type ReplyFixtureName } from "@/lib/fixtures";
import { aliasIndexFromCatalog } from "./alias-index";
import { SOURCE_TEXT_HEADER, type ExtractionDocument } from "./document";
import { fixtureAttachmentId } from "./fixture-documents";
import {
  buildReplyFixtureDocument,
  offerContextLineSchema,
  parseReplyRecording,
  REPLY_FIXTURE_CONTEXTS,
  REPLY_RECEIVED_AT,
  replyFixtureLineId,
  replyRecordingPath,
  replyRecordingSchema,
  type ReplyRecording,
} from "./offer-fixture-documents";
import {
  normalizeOfferOutput,
  offerConfidence,
  orderOfferFlags,
  type NormalizedOfferLine,
  type NormalizedOfferMeta,
} from "./offers-normalize";
import { extractOfferLinesOutputSchema, modelOfferFlagValues, offerFlagValues } from "./offers-schema";

const EM_DASH = String.fromCharCode(0x2014); // built from the code point so this file holds none
const index = aliasIndexFromCatalog(generateCatalog());

const LINE_HSS_8X8X3_8 = "11111111-1111-4111-8111-000000000001";
const LINE_HSS_8X8X5_8 = "11111111-1111-4111-8111-000000000002";
const LINE_C12X30 = "11111111-1111-4111-8111-000000000003";
const MIXED_LINE_IDS = [
  "11111111-1111-4111-8111-000000000011",
  "11111111-1111-4111-8111-000000000012",
  "11111111-1111-4111-8111-000000000013",
  "11111111-1111-4111-8111-000000000014",
];

type Loaded = {
  raw: string;
  recording: ReplyRecording;
  doc: ExtractionDocument;
  sha256: string;
  receivedAt: Date;
  meta: NormalizedOfferMeta;
  lines: NormalizedOfferLine[];
};

const cache = new Map<string, Promise<Loaded>>();

function load(name: ReplyFixtureName): Promise<Loaded> {
  let pending = cache.get(name);
  if (!pending) {
    pending = (async () => {
      const raw = readFileSync(replyRecordingPath(name), "utf8");
      const recording = parseReplyRecording(raw);
      const { doc, sha256, receivedAt } = await buildReplyFixtureDocument(name);
      const output = extractOfferLinesOutputSchema.parse(recording.output);
      // The recording's own context and arrival time drive the pass, as the
      // record script wrote them; a separate test pins them to the fixed values.
      const { meta, lines } = normalizeOfferOutput(output, doc, recording.context, index, new Date(recording.received_at));
      return { raw, recording, doc, sha256, receivedAt, meta, lines };
    })();
    cache.set(name, pending);
  }
  return pending;
}

/** The text of the segment a source_span points at, as the Offers tab would read it. */
function segmentText(doc: ExtractionDocument, line: NormalizedOfferLine): string {
  const span = line.source_span;
  const segment = doc.segments.find((s) =>
    span.kind === "text"
      ? s.kind === "text"
      : s.kind === "attachment" && s.attachmentId === span.attachment_id && s.page === span.page,
  );
  if (!segment) throw new Error(`No segment for span ${JSON.stringify(span)}`);
  return segment.text.slice(span.start, span.end);
}

function only(lines: NormalizedOfferLine[]): NormalizedOfferLine {
  expect(lines).toHaveLength(1);
  return lines[0];
}

// ---------------------------------------------------------------------------
// The fixture-to-document helper and the fixed contexts
// ---------------------------------------------------------------------------

describe("buildReplyFixtureDocument", () => {
  it("reads a .txt fixture as one text segment holding the file verbatim", async () => {
    const { doc, sha256, receivedAt } = await buildReplyFixtureDocument("alt-wall-rolling.txt");
    const file = readFixture("replies/alt-wall-rolling.txt").toString("utf8");
    expect(doc.segments).toHaveLength(1);
    expect(doc.segments[0]).toMatchObject({ kind: "text", text: file, start: SOURCE_TEXT_HEADER.length });
    expect(doc.text).toBe(SOURCE_TEXT_HEADER + file);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receivedAt.toISOString()).toBe("2026-10-22T15:00:00.000Z");
    expect(receivedAt).toBe(REPLY_RECEIVED_AT);
  });

  it("reads an .eml as the mail text plus one attachment segment per PDF page with the numbered fixture attachment id", async () => {
    const { doc } = await buildReplyFixtureDocument("quote.pdf.eml");
    expect(doc.segments).toHaveLength(2);
    expect(doc.segments[0]).toMatchObject({ kind: "text", start: SOURCE_TEXT_HEADER.length });
    expect(doc.segments[0].text).toContain("Quote attached.");
    expect(doc.segments[0].text).not.toContain("Content-Type");
    expect(doc.segments[1]).toMatchObject({
      kind: "attachment",
      attachmentId: fixtureAttachmentId(1),
      filename: "delta-quote-4417.pdf",
      page: 1,
    });
    expect(doc.text).toContain("=== ATTACHMENT: delta-quote-4417.pdf (page 1) ===\n");
    expect(doc.segments[1].text).toContain("W12x26 x 50' 8 pcs $62.50 cwt stock");
    expect(doc.segments[1].text).toContain("Quote valid 7 days");
  });

  it("is deterministic", async () => {
    const a = await buildReplyFixtureDocument("quote.pdf.eml");
    const b = await buildReplyFixtureDocument("quote.pdf.eml");
    expect(a.sha256).toBe(b.sha256);
    expect(a.doc.text).toBe(b.doc.text);
  });

  it("refuses a name that is neither .txt nor .eml", async () => {
    await expect(buildReplyFixtureDocument("quote.pdf")).rejects.toThrow(/neither \.txt nor \.eml/);
  });

  it("names recordings after the fixture without its .txt or .eml extension", () => {
    expect(replyRecordingPath("alt-wall-rolling.txt")).toMatch(/fixtures[\\/]recorded[\\/]replies[\\/]alt-wall-rolling\.json$/);
    expect(replyRecordingPath("quote.pdf.eml")).toMatch(/fixtures[\\/]recorded[\\/]replies[\\/]quote\.pdf\.json$/);
  });
});

describe("REPLY_FIXTURE_CONTEXTS", () => {
  it("mints the stable fixture line ids the contract names", () => {
    expect(replyFixtureLineId(1)).toBe(LINE_HSS_8X8X3_8);
    expect(replyFixtureLineId(2)).toBe(LINE_HSS_8X8X5_8);
    expect(replyFixtureLineId(3)).toBe(LINE_C12X30);
    expect([11, 12, 13, 14].map(replyFixtureLineId)).toEqual(MIXED_LINE_IDS);
    expect(() => replyFixtureLineId(0)).toThrow(/out of range/);
    expect(() => replyFixtureLineId(1.5)).toThrow(/out of range/);
  });

  it("has a context for every reply fixture, numbered from 1, with distinct well-formed ids", () => {
    for (const name of REPLY_FIXTURES) {
      const context = REPLY_FIXTURE_CONTEXTS[name];
      expect(context.length, name).toBeGreaterThan(0);
      expect(context.map((l) => l.line_no)).toEqual(context.map((_, i) => i + 1));
      expect(new Set(context.map((l) => l.request_line_id)).size).toBe(context.length);
      for (const line of context) {
        expect(() => offerContextLineSchema.parse(line)).not.toThrow();
      }
    }
  });

  it("pins each fixture to the request lines the step contract names", () => {
    expect(REPLY_FIXTURE_CONTEXTS["alt-wall-rolling.txt"]).toMatchObject([
      { request_line_id: LINE_HSS_8X8X3_8, designation: "HSS8x8x3/8", qty: 20, unit: "pcs", length_ft: 40, grade_spec: null, category: "hss_square", dims: { a: 8, b: 8, t: 0.375 } },
    ]);
    expect(REPLY_FIXTURE_CONTEXTS["partial-discount.txt"]).toMatchObject([
      { request_line_id: LINE_HSS_8X8X5_8, designation: "HSS8x8x5/8", qty: 100, unit: "pcs", length_ft: 40, grade_spec: "A500 Gr B", category: "hss_square", dims: { a: 8, b: 8, t: 0.625 } },
    ]);
    expect(REPLY_FIXTURE_CONTEXTS["future-rolling.txt"]).toEqual(REPLY_FIXTURE_CONTEXTS["partial-discount.txt"]);
    expect(REPLY_FIXTURE_CONTEXTS["decline.txt"]).toMatchObject([
      { request_line_id: LINE_C12X30, designation: "C12x30", qty: 6, unit: "pcs", length_ft: 40, grade_spec: null, category: "channel", dims: { d: 12, wt: 30 } },
    ]);
    const mixed = REPLY_FIXTURE_CONTEXTS["quote.pdf.eml"];
    expect(mixed.map((l) => l.request_line_id)).toEqual(MIXED_LINE_IDS);
    expect(mixed.map((l) => l.designation)).toEqual(["W12x26", "L2x2x1/4", "PL3/8", "HSS6x6x3/8"]);
    expect(mixed.map((l) => [l.qty, l.unit, l.length_ft])).toEqual([
      [8, "pcs", 50],
      [40, "pcs", 20],
      [10, "pcs", null],
      [20, "pcs", 24],
    ]);
    expect(mixed[2]).toMatchObject({ grade_spec: "A36", category: "plate", dims: { t: 0.375, w: 48, l: 96 } });
  });
});

// ---------------------------------------------------------------------------
// Every recording
// ---------------------------------------------------------------------------

describe.each(REPLY_FIXTURES)("recording for %s", (name) => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load(name);
  });

  it("exists, matches the recording shape, and names this fixture", () => {
    expect(existsSync(replyRecordingPath(name))).toBe(true);
    expect(() => replyRecordingSchema.parse(JSON.parse(f.raw))).not.toThrow();
    expect(f.recording.fixture).toBe(name);
    expect(["hand-authored", "recorded"]).toContain(f.recording.source);
    expect(f.recording.model).not.toBe("");
    expect(Number.isNaN(Date.parse(f.recording.recorded_at))).toBe(false);
  });

  it("was made from the document the fixture builds today (sha256)", () => {
    expect(f.recording.document_sha256).toBe(f.sha256);
  });

  it("stores the fixed context and arrival time the fixture is defined with", () => {
    expect(f.recording.context).toEqual(REPLY_FIXTURE_CONTEXTS[name]);
    expect(new Date(f.recording.received_at).getTime()).toBe(REPLY_RECEIVED_AT.getTime());
    expect(f.receivedAt.getTime()).toBe(REPLY_RECEIVED_AT.getTime());
  });

  it("holds output that passes the extraction schema, with no em dash anywhere", () => {
    expect(() => extractOfferLinesOutputSchema.parse(f.recording.output)).not.toThrow();
    expect(f.raw).not.toContain(EM_DASH);
    expect(f.raw.endsWith("\n")).toBe(true);
  });

  it("keeps the model to strings, nulls, context ids, and the three judgment flags", () => {
    const contextIds = new Set(f.recording.context.map((l) => l.request_line_id));
    for (const line of f.recording.output.lines) {
      if (line.request_line_id !== null) expect(contextIds.has(line.request_line_id), line.raw_text).toBe(true);
      for (const flag of line.flags) {
        expect(modelOfferFlagValues).toContain(flag);
      }
      for (const text of [line.unit_price_text, line.ready_date_text, line.delivery_estimate_text]) {
        expect(text === null || typeof text === "string").toBe(true);
      }
      expect(line.confidence).toBeGreaterThanOrEqual(0.6);
      expect(line.confidence).toBeLessThanOrEqual(0.98);
    }
    const meta = f.recording.output.offer_meta;
    for (const text of [meta.early_pay_pct_text, meta.freight_amount_text, meta.quote_valid_text, meta.payment_terms]) {
      expect(text === null || typeof text === "string").toBe(true);
    }
    if (meta.declined) expect(f.recording.output.lines).toHaveLength(0);
  });

  it("verifies every span and points each at the text it was read from", () => {
    expect(f.lines.length).toBe(f.recording.output.lines.length);
    for (const line of f.lines) {
      expect(line.span_verified, line.raw_text).toBe(true);
      expect(segmentText(f.doc, line)).toBe(line.raw_text);
      expect(line.source_span.start).toBeLessThan(line.source_span.end);
    }
  });

  it("has exact offsets when hand-authored (they were computed from the document)", () => {
    if (f.recording.source !== "hand-authored") return;
    for (const line of f.recording.output.lines) {
      expect(f.doc.text.slice(line.span.start, line.span.end)).toBe(line.raw_text);
    }
  });

  it("takes no line from a greeting, a sign-off, a header, or a terms footer", () => {
    for (const line of f.lines) {
      expect(line.raw_text).not.toMatch(/^(Marcus|Tony|Dana|Jim)$/);
      expect(line.raw_text).not.toMatch(/^===/);
      expect(line.raw_text).not.toMatch(/^(Terms:|Freight included|Quote valid|Item Qty|-{10,})/);
    }
  });

  it("orders flags as offerFlagValues does, clamps confidence, and ties every line to a context line", () => {
    for (const line of f.lines) {
      expect(line.flags).toEqual(orderOfferFlags(line.flags));
      for (const flag of line.flags) expect(offerFlagValues).toContain(flag);
      expect(line.confidence).toBeGreaterThanOrEqual(0);
      expect(line.confidence).toBeLessThanOrEqual(1);
      expect(line.request_line_id).not.toBeNull();
      expect(line.flags).not.toContain("unmatched_line");
      expect(line.flags).not.toContain("possible_duplicate");
    }
    expect(f.meta.declined).toBe(f.recording.output.offer_meta.declined);
  });
});

// ---------------------------------------------------------------------------
// Expected results per fixture (step contract 10)
// ---------------------------------------------------------------------------

describe("alt-wall-rolling.txt", () => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load("alt-wall-rolling.txt");
  });

  it("is not a decline and offers one alternate-wall line tied to the HSS8x8x3/8 request line", () => {
    expect(f.meta.declined).toBe(false);
    const line = only(f.lines);
    expect(line.request_line_id).toBe(LINE_HSS_8X8X3_8);
    expect(line.is_exact_match).toBe(false);
    expect(line.alternate_types).toContain("wall");
    expect(line.offered_desc).toBe("8x8x1/2");
    expect(line.offered_catalog_item_id).toBe("HSS8x8x1/2");
  });

  it("reads stock at $64.50/cwt with no stated quantity", () => {
    const line = only(f.lines);
    expect(line.availability).toBe("stock");
    expect(line.unit_price).toBe(64.5);
    expect(line.price_basis).toBe("per_cwt");
    expect(line.available_qty).toBeNull();
    expect(line.unit).toBeNull();
    expect(line.ready_date).toBeNull();
    expect(line.flags).toContain("missing_qty");
    expect(line.flags).not.toContain("missing_price");
    expect(line.flags).not.toContain("missing_availability");
  });

  it("reads FOB mill as freight separate and keeps the 3/8 wall remark in the notes", () => {
    expect(f.meta.freight_basis).toBe("separate");
    expect(f.meta.freight_amount).toBeNull();
    expect(f.meta.early_pay_pct).toBeNull();
    expect(f.meta.early_pay_days).toBeNull();
    expect(f.meta.quote_expires_at).toBeNull();
    expect(f.meta.notes).toContain("3/8 wall is booked through December");
  });

  it("has a verified text span inside the reply text", () => {
    const line = only(f.lines);
    expect(line.span_verified).toBe(true);
    expect(line.source_span.kind).toBe("text");
    const source = readFixture("replies/alt-wall-rolling.txt").toString("utf8");
    expect(source.slice(line.source_span.start, line.source_span.end)).toBe(line.raw_text);
    expect(line.raw_text).toContain("$64.50/cwt FOB mill");
  });
});

describe("partial-discount.txt", () => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load("partial-discount.txt");
  });

  it("offers 60 pcs from stock at $0.98/ft on the HSS8x8x5/8 line, exactly as asked", () => {
    expect(f.meta.declined).toBe(false);
    const line = only(f.lines);
    expect(line.request_line_id).toBe(LINE_HSS_8X8X5_8);
    expect(line.is_exact_match).toBe(true);
    expect(line.alternate_types).toEqual([]);
    expect(line.offered_desc).toBe("HSS8x8x5/8");
    expect(line.offered_catalog_item_id).toBe("HSS8x8x5/8");
    expect(line.available_qty).toBe(60);
    expect(line.unit).toBe("pcs");
    expect(line.availability).toBe("stock");
    expect(line.unit_price).toBe(0.98);
    expect(line.price_basis).toBe("per_ft");
  });

  it("carries no missing flags", () => {
    const line = only(f.lines);
    expect(line.flags).not.toContain("missing_price");
    expect(line.flags).not.toContain("missing_qty");
    expect(line.flags).not.toContain("missing_availability");
    expect(line.flags).toEqual([]);
  });

  it("reads freight separate and 1% net 10 as a one percent, ten day early-pay term", () => {
    expect(f.meta.freight_basis).toBe("separate");
    expect(f.meta.early_pay_pct).toBe(1);
    expect(f.meta.early_pay_days).toBe(10);
    expect(f.meta.payment_terms).toContain("1% net 10");
    expect(f.meta.freight_amount).toBeNull();
    expect(f.meta.quote_expires_at).toBeNull();
  });

  it("has a verified text span", () => {
    const line = only(f.lines);
    expect(line.span_verified).toBe(true);
    expect(line.source_span.kind).toBe("text");
    const source = readFixture("replies/partial-discount.txt").toString("utf8");
    expect(source.slice(line.source_span.start, line.source_span.end)).toBe(line.raw_text);
  });
});

describe("future-rolling.txt", () => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load("future-rolling.txt");
  });

  it("offers one rolling line tied to the HSS8x8x5/8 request line ready the week of Nov 17, 2026", () => {
    expect(f.meta.declined).toBe(false);
    const line = only(f.lines);
    expect(line.request_line_id).toBe(LINE_HSS_8X8X5_8);
    expect(line.availability).toBe("rolling");
    expect(line.ready_date).toBe("2026-11-17");
    expect(line.offered_catalog_item_id).toBe("HSS8x8x5/8");
  });

  it("names no price or count, so both are null and flagged, while availability is known", () => {
    const line = only(f.lines);
    expect(line.unit_price).toBeNull();
    expect(line.price_basis).toBeNull();
    expect(line.available_qty).toBeNull();
    expect(line.flags).toContain("missing_price");
    expect(line.flags).toContain("missing_qty");
    expect(line.flags).not.toContain("missing_availability");
  });

  it("keeps the five loads and the 40' cut for the reviewer", () => {
    const line = only(f.lines);
    expect(`${line.delivery_estimate_text ?? ""} ${line.raw_text}`).toMatch(/five loads/);
    expect(`${line.offered_desc} ${line.delivery_estimate_text ?? ""}`).toContain("40'");
  });

  it("has no terms, freight, or validity and a verified text span", () => {
    expect(f.meta.freight_basis).toBe("unknown");
    expect(f.meta.early_pay_pct).toBeNull();
    expect(f.meta.early_pay_days).toBeNull();
    expect(f.meta.quote_expires_at).toBeNull();
    const line = only(f.lines);
    expect(line.span_verified).toBe(true);
    expect(line.source_span.kind).toBe("text");
    const source = readFixture("replies/future-rolling.txt").toString("utf8");
    expect(source.slice(line.source_span.start, line.source_span.end)).toBe(line.raw_text);
  });
});

describe("decline.txt", () => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load("decline.txt");
  });

  it("is a decline with zero lines and a reason that names channel", () => {
    expect(f.meta.declined).toBe(true);
    expect(f.lines).toHaveLength(0);
    expect(f.meta.decline_reason).toMatch(/channel/i);
  });

  it("reads as a whole reply: confidence 1 with no lines, no terms, no freight", () => {
    expect(offerConfidence(f.lines, f.meta.declined)).toBe(1);
    expect(f.meta.freight_basis).toBe("unknown");
    expect(f.meta.early_pay_pct).toBeNull();
    expect(f.meta.freight_amount).toBeNull();
    expect(f.meta.quote_expires_at).toBeNull();
  });
});

describe("quote.pdf.eml", () => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load("quote.pdf.eml");
  });

  it("quotes four lines tied to the four mixed-list request lines in order, all exact", () => {
    expect(f.meta.declined).toBe(false);
    expect(f.lines).toHaveLength(4);
    expect(f.lines.map((l) => l.request_line_id)).toEqual(MIXED_LINE_IDS);
    for (const line of f.lines) {
      expect(line.is_exact_match, line.raw_text).toBe(true);
      expect(line.alternate_types, line.raw_text).toEqual([]);
    }
  });

  it("links each row to its catalog item although the table writes the length into the item", () => {
    expect(f.lines.map((l) => l.offered_desc)).toEqual(["W12x26 x 50'", "L2x2x1/4 x 20'", "PL3/8 48x96 A36", "HSS6x6x3/8 x 24'"]);
    expect(f.lines.map((l) => l.offered_catalog_item_id)).toEqual(["W12x26", "L2x2x1/4", "PL3/8", "HSS6x6x3/8"]);
  });

  it("reads each row's price, basis, quantity, and availability", () => {
    expect(f.lines.map((l) => l.unit_price)).toEqual([62.5, 0.98, 58, 71]);
    expect(f.lines.map((l) => l.price_basis)).toEqual(["per_cwt", "per_ft", "per_cwt", "per_cwt"]);
    expect(f.lines.map((l) => l.available_qty)).toEqual([8, 40, 10, 20]);
    expect(f.lines.map((l) => l.unit)).toEqual(["pcs", "pcs", "pcs", "pcs"]);
    expect(f.lines.map((l) => l.availability)).toEqual(["stock", "stock", "stock", "rolling"]);
    expect(f.lines.map((l) => l.ready_date)).toEqual([null, null, null, "2026-11-17"]);
  });

  it("flags nothing on a complete table", () => {
    for (const line of f.lines) {
      expect(line.flags, line.raw_text).toEqual([]);
    }
    expect(offerConfidence(f.lines, f.meta.declined)).toBeGreaterThan(0.9);
  });

  it("reads the footer as terms: 1% 10 days, freight included, valid 7 days from receipt", () => {
    expect(f.meta.early_pay_pct).toBe(1);
    expect(f.meta.early_pay_days).toBe(10);
    expect(f.meta.payment_terms).toContain("Net 30");
    expect(f.meta.freight_basis).toBe("included");
    expect(f.meta.freight_amount).toBeNull();
    expect(f.meta.quote_expires_at).not.toBeNull();
    expect(f.meta.quote_expires_at!.slice(0, 10)).toBe("2026-10-29");
  });

  it("gives every line a verified attachment span on page 1 of the first fixture attachment", () => {
    const page = f.doc.segments.find((s) => s.kind === "attachment");
    expect(page).toBeDefined();
    for (const line of f.lines) {
      expect(line.span_verified).toBe(true);
      expect(line.source_span.kind).toBe("attachment");
      if (line.source_span.kind !== "attachment") continue;
      expect(line.source_span.attachment_id).toBe(fixtureAttachmentId(1));
      expect(line.source_span.page).toBe(1);
      expect(page!.text.slice(line.source_span.start, line.source_span.end)).toBe(line.raw_text);
    }
  });

  it("takes nothing from the covering email or the quote header", () => {
    for (const line of f.lines) {
      expect(line.raw_text).not.toContain("Quote attached");
      expect(line.raw_text).not.toContain("Delta Steel");
      expect(line.raw_text).not.toContain("marcus.reed");
    }
  });
});

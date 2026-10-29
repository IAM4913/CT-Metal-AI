import { describe, expect, it } from "vitest";
import { generateCatalog } from "@/lib/catalog/generate";
import { aliasIndexFromCatalog, lookupItem } from "./alias-index";
import { buildExtractionDocument } from "./document";
import {
  carriedOfferFlags,
  clampConfidence,
  computeOfferFlags,
  markOfferDuplicates,
  normalizeEarlyPay,
  normalizeOfferMeta,
  normalizeOfferOutput,
  offerConfidence,
  offerDuplicateKey,
  offeredItemCandidates,
  orderOfferFlags,
  stripTrailingLength,
} from "./offers-normalize";
import type { OfferContextLine } from "./offers-prompt";
import { extractOfferLinesOutputSchema, offerFlagValues, type ExtractedOfferLine, type ExtractOfferLinesOutput, type OfferMeta } from "./offers-schema";

const index = aliasIndexFromCatalog(generateCatalog());
const RECEIVED = new Date("2026-10-22T15:00:00Z");

const LINE_ID_1 = "11111111-1111-4111-8111-000000000001";
const LINE_ID_2 = "11111111-1111-4111-8111-000000000002";
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";

const CONTEXT: OfferContextLine[] = [
  {
    request_line_id: LINE_ID_1,
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
  },
  {
    request_line_id: LINE_ID_2,
    line_no: 2,
    designation: "HSS8x8x5/8",
    description: "HSS8x8x5/8",
    qty: 100,
    unit: "pcs",
    length_ft: 40,
    length_text: "40'",
    grade_spec: "A500 Gr B",
    category: "hss_square",
    dims: { a: 8, b: 8, t: 0.625 },
  },
];

const REPLY = "3/8 wall is booked through December, nothing on the floor. We can offer 8x8x1/2 from stock, 40', $64.50/cwt FOB mill.\n\nMarcus\n";
const doc = buildExtractionDocument([{ kind: "text", text: REPLY }]);

const META: OfferMeta = {
  declined: false,
  decline_reason: null,
  payment_terms: null,
  early_pay_pct_text: null,
  early_pay_days: null,
  freight_amount_text: null,
  freight_basis: "unknown",
  quote_valid_text: null,
  availability_remarks: null,
};

function line(raw: string, overrides: Partial<ExtractedOfferLine> = {}): ExtractedOfferLine {
  const start = doc.text.indexOf(raw);
  return {
    request_line_id: LINE_ID_1,
    raw_text: raw,
    span: { start, end: start + raw.length },
    offered_desc: "8x8x1/2",
    is_exact_match: false,
    alternate_types: ["wall"],
    available_qty: null,
    unit: null,
    availability: "stock",
    ready_date_text: null,
    delivery_estimate_text: null,
    unit_price_text: "$64.50/cwt",
    price_basis: "per_cwt",
    confidence: 0.9,
    flags: [],
    ...overrides,
  };
}

const ALT_RAW = "We can offer 8x8x1/2 from stock, 40', $64.50/cwt FOB mill.";

function output(lines: ExtractedOfferLine[], meta: Partial<OfferMeta> = {}, notes: string | null = null): ExtractOfferLinesOutput {
  return extractOfferLinesOutputSchema.parse({ offer_meta: { ...META, ...meta }, lines, notes });
}

describe("computeOfferFlags", () => {
  const base = { request_line_id: LINE_ID_1, unit_price: 64.5, available_qty: 60, availability: "stock" as const, declined: false };

  it("is empty for a complete line", () => {
    expect(computeOfferFlags(base)).toEqual([]);
  });

  it("flags a missing price unless the offer is declined", () => {
    expect(computeOfferFlags({ ...base, unit_price: null })).toEqual(["missing_price"]);
    expect(computeOfferFlags({ ...base, unit_price: null, declined: true })).toEqual([]);
  });

  it("flags a missing quantity whatever the availability", () => {
    expect(computeOfferFlags({ ...base, available_qty: null })).toEqual(["missing_qty"]);
    expect(computeOfferFlags({ ...base, available_qty: null, availability: "unknown" })).toEqual(["missing_qty", "missing_availability"]);
    expect(computeOfferFlags({ ...base, available_qty: null, availability: "rolling" })).toEqual(["missing_qty"]);
  });

  it("flags unknown availability and an untied line", () => {
    expect(computeOfferFlags({ ...base, availability: "unknown" })).toEqual(["missing_availability"]);
    expect(computeOfferFlags({ ...base, request_line_id: null })).toEqual(["unmatched_line"]);
  });

  it("carries the judgment flags and orders everything by offerFlagValues", () => {
    const flags = computeOfferFlags({
      ...base,
      unit_price: null,
      request_line_id: null,
      judgment: ["possible_duplicate", "ambiguous_basis", "ambiguous_unit", "missing_qty" as never],
    });
    expect(flags).toEqual(["missing_price", "ambiguous_unit", "ambiguous_basis", "unmatched_line", "possible_duplicate"]);
    expect(flags).toEqual(orderOfferFlags(flags));
  });

  it("reads the judgment flags off a stored row and drops the rest", () => {
    expect(carriedOfferFlags(["missing_price", "ambiguous_basis", "bogus", "possible_duplicate"])).toEqual([
      "ambiguous_basis",
      "possible_duplicate",
    ]);
  });

  it("orderOfferFlags follows the closed list", () => {
    expect(orderOfferFlags(["possible_duplicate", "missing_price", "missing_price"])).toEqual(["missing_price", "possible_duplicate"]);
    expect(offerFlagValues).toEqual([
      "missing_price",
      "missing_qty",
      "missing_availability",
      "ambiguous_unit",
      "ambiguous_basis",
      "unmatched_line",
      "possible_duplicate",
    ]);
  });
});

describe("stripTrailingLength and offeredItemCandidates", () => {
  it("drops a length written onto the end of an item", () => {
    expect(stripTrailingLength("W12x26 x 50'")).toBe("W12x26");
    expect(stripTrailingLength("C12x30 40'")).toBe("C12x30");
    expect(stripTrailingLength("HSS6x6x3/8 x 24'")).toBe("HSS6x6x3/8");
    expect(stripTrailingLength("L2x2x1/4 x 20 ft")).toBe("L2x2x1/4");
    expect(stripTrailingLength("8x8x1/2 x 40 feet")).toBe("8x8x1/2");
    expect(stripTrailingLength("8x8x1/2 40 ft.")).toBe("8x8x1/2");
    expect(stripTrailingLength("W12x26 x 20'-6\"")).toBe("W12x26");
    expect(stripTrailingLength("  W12x26 x 50'  ")).toBe("W12x26");
  });

  it("leaves a fraction, a sheet size, an unmarked number, and a bare length alone", () => {
    expect(stripTrailingLength("HSS8x8x3/8")).toBe("HSS8x8x3/8");
    expect(stripTrailingLength("PL3/8 48x96 A36")).toBe("PL3/8 48x96 A36");
    expect(stripTrailingLength("8x8x1/2 x 40")).toBe("8x8x1/2 x 40");
    expect(stripTrailingLength("40'")).toBe("40'");
    expect(stripTrailingLength("bent plate per print")).toBe("bent plate per print");
  });

  it("lists the description, its stripped form, and the exact designation once each", () => {
    expect(offeredItemCandidates("W12x26 x 50'", "W12x26")).toEqual(["W12x26 x 50'", "W12x26"]);
    expect(offeredItemCandidates("PL3/8 48x96 A36", "PL3/8")).toEqual(["PL3/8 48x96 A36", "PL3/8"]);
    expect(offeredItemCandidates("8x8x1/2", null)).toEqual(["8x8x1/2"]);
    expect(offeredItemCandidates("8x8x1/2 x 40'", null)).toEqual(["8x8x1/2 x 40'", "8x8x1/2"]);
    expect(offeredItemCandidates("  ", "HSS8x8x3/8")).toEqual(["HSS8x8x3/8"]);
  });

  it("links a length-bearing table row to its catalog item through the seed index", () => {
    expect(lookupItem(index, offeredItemCandidates("W12x26 x 50'", null))?.catalog_item_id).toBe("W12x26");
    expect(lookupItem(index, offeredItemCandidates("C12x30 40'", null))?.catalog_item_id).toBe("C12x30");
    expect(lookupItem(index, offeredItemCandidates("HSS6x6x3/8 x 24'", null))?.catalog_item_id).toBe("HSS6x6x3/8");
    expect(lookupItem(index, offeredItemCandidates("PL3/8 48x96 A36", null))).toBeNull();
    expect(lookupItem(index, offeredItemCandidates("PL3/8 48x96 A36", "PL3/8"))?.catalog_item_id).toBe("PL3/8");
    // An alternate never borrows the request line's designation.
    expect(lookupItem(index, offeredItemCandidates("bent plate per print", null))).toBeNull();
  });
});

describe("offerDuplicateKey", () => {
  it("keys on the request line and the folded offered item, null for an untied line", () => {
    expect(offerDuplicateKey({ request_line_id: LINE_ID_1, offered_desc: "HSS 8x8x1/2" })).toBe(
      offerDuplicateKey({ request_line_id: LINE_ID_1, offered_desc: "hss8x8x1/2" }),
    );
    expect(offerDuplicateKey({ request_line_id: LINE_ID_1, offered_desc: "8x8x1/2", offered_catalog_item_id: "HSS8x8x1/2" })).toBe(
      `${LINE_ID_1}|item:HSS8x8x1/2`,
    );
    expect(offerDuplicateKey({ request_line_id: LINE_ID_1, offered_desc: "8x8x1/2" })).not.toBe(
      offerDuplicateKey({ request_line_id: LINE_ID_2, offered_desc: "8x8x1/2" }),
    );
    expect(offerDuplicateKey({ request_line_id: null, offered_desc: "8x8x1/2" })).toBeNull();
  });
});

describe("markOfferDuplicates", () => {
  it("flags two lines on the same request line with the same offered item, spacing and case folded", () => {
    const lines = [
      { request_line_id: LINE_ID_1, offered_desc: "HSS 8x8x1/2", flags: [] as never[] },
      { request_line_id: LINE_ID_1, offered_desc: "hss8x8x1/2", flags: [] as never[] },
      { request_line_id: LINE_ID_1, offered_desc: "8x8x3/8", flags: [] as never[] },
    ];
    const marked = markOfferDuplicates(lines);
    expect(marked.map((l) => l.flags)).toEqual([["possible_duplicate"], ["possible_duplicate"], []]);
    expect(lines[0].flags).toEqual([]);
  });

  it("pairs two spellings that link to the same catalog item", () => {
    const marked = markOfferDuplicates([
      { request_line_id: LINE_ID_1, offered_desc: "8x8x1/2", offered_catalog_item_id: "HSS8x8x1/2", flags: [] },
      { request_line_id: LINE_ID_1, offered_desc: "8 square 1/2 wall", offered_catalog_item_id: "HSS8x8x1/2", flags: [] },
      { request_line_id: LINE_ID_1, offered_desc: "8x8x1/2", offered_catalog_item_id: null, flags: [] },
    ]);
    expect(marked.map((l) => l.flags)).toEqual([["possible_duplicate"], ["possible_duplicate"], []]);
  });

  it("never pairs lines on different request lines or untied lines", () => {
    const marked = markOfferDuplicates([
      { request_line_id: LINE_ID_1, offered_desc: "8x8x1/2", flags: [] },
      { request_line_id: LINE_ID_2, offered_desc: "8x8x1/2", flags: [] },
      { request_line_id: null, offered_desc: "8x8x1/2", flags: [] },
      { request_line_id: null, offered_desc: "8x8x1/2", flags: [] },
    ]);
    expect(marked.every((l) => l.flags.length === 0)).toBe(true);
  });
});

describe("normalizeEarlyPay", () => {
  it("reads the pct text first", () => {
    expect(normalizeEarlyPay({ early_pay_pct_text: "1% net 10", payment_terms: "Net 30", early_pay_days: null })).toEqual({ pct: 1, days: 10 });
  });

  it("falls back to the payment terms when the pct text is null", () => {
    expect(normalizeEarlyPay({ early_pay_pct_text: null, payment_terms: "Net 30, 1% 10 days", early_pay_days: null })).toEqual({ pct: 1, days: 10 });
    expect(normalizeEarlyPay({ early_pay_pct_text: null, payment_terms: "1/10 net 30", early_pay_days: null })).toEqual({ pct: 1, days: 10 });
  });

  it("uses the model's days only when the parsers find no window, and only beside a percentage", () => {
    expect(normalizeEarlyPay({ early_pay_pct_text: "1%", payment_terms: "Net 30", early_pay_days: 10 })).toEqual({ pct: 1, days: 10 });
    expect(normalizeEarlyPay({ early_pay_pct_text: "1% net 10", payment_terms: null, early_pay_days: 15 })).toEqual({ pct: 1, days: 10 });
    expect(normalizeEarlyPay({ early_pay_pct_text: null, payment_terms: "Net 30", early_pay_days: 10 })).toEqual({ pct: null, days: null });
    expect(normalizeEarlyPay({ early_pay_pct_text: "1%", payment_terms: null, early_pay_days: 0 })).toEqual({ pct: 1, days: null });
  });

  it("is null for plain terms", () => {
    expect(normalizeEarlyPay({ early_pay_pct_text: null, payment_terms: "Net 30", early_pay_days: null })).toEqual({ pct: null, days: null });
    expect(normalizeEarlyPay({ early_pay_pct_text: null, payment_terms: null, early_pay_days: null })).toEqual({ pct: null, days: null });
  });

  it("does not read a month/day or a fraction in the terms as a discount", () => {
    expect(normalizeEarlyPay({ early_pay_pct_text: null, payment_terms: "Net 30, due 11/30", early_pay_days: null })).toEqual({ pct: null, days: null });
    expect(normalizeEarlyPay({ early_pay_pct_text: null, payment_terms: "Net 30 from 10/22", early_pay_days: null })).toEqual({ pct: null, days: null });
    expect(normalizeEarlyPay({ early_pay_pct_text: null, payment_terms: "1/2 down, balance net 30", early_pay_days: null })).toEqual({ pct: null, days: null });
    // The pct text itself may use the bare slash form the prompt allows.
    expect(normalizeEarlyPay({ early_pay_pct_text: "2/10", payment_terms: "Net 30, due 11/30", early_pay_days: null })).toEqual({ pct: 2, days: 10 });
    // A bare percent takes its days from a marked terms phrase, never from a date in it.
    expect(normalizeEarlyPay({ early_pay_pct_text: "1%", payment_terms: "Net 30, due 11/30", early_pay_days: null })).toEqual({ pct: 1, days: null });
    expect(normalizeEarlyPay({ early_pay_pct_text: "1%", payment_terms: "terms 1/10 net 30", early_pay_days: null })).toEqual({ pct: 1, days: 10 });
  });
});

describe("normalizeOfferMeta", () => {
  it("parses terms, freight, and expiry", () => {
    const meta = normalizeOfferMeta(
      output([], {
        payment_terms: " Net 30, 1% 10 days ",
        early_pay_pct_text: null,
        early_pay_days: null,
        freight_amount_text: "$350",
        freight_basis: "included",
        quote_valid_text: "valid 7 days",
        availability_remarks: null,
      }),
      RECEIVED,
    );
    expect(meta).toEqual({
      declined: false,
      decline_reason: null,
      payment_terms: "Net 30, 1% 10 days",
      early_pay_pct: 1,
      early_pay_days: 10,
      freight_amount: 350,
      freight_basis: "included",
      quote_expires_at: "2026-10-29T15:00:00.000Z",
      notes: null,
    });
  });

  it("reads expiry from a named date", () => {
    const meta = normalizeOfferMeta(output([], { quote_valid_text: "good through 11/30" }), RECEIVED);
    expect(meta.quote_expires_at).toBe("2026-11-30T00:00:00.000Z");
  });

  it("keeps unreadable freight and validity text, the remarks, and the model's notes in notes", () => {
    const meta = normalizeOfferMeta(
      output([], { freight_amount_text: "TBD", quote_valid_text: "subject to change", availability_remarks: "3/8 wall is booked through December" }, "Two-page quote"),
      RECEIVED,
    );
    expect(meta.freight_amount).toBeNull();
    expect(meta.quote_expires_at).toBeNull();
    expect(meta.notes).toBe("Two-page quote\nAvailability: 3/8 wall is booked through December\nFreight: TBD\nQuote validity: subject to change");
  });

  it("carries a decline with its reason", () => {
    const meta = normalizeOfferMeta(output([], { declined: true, decline_reason: " we don't stock channel " }), RECEIVED);
    expect(meta.declined).toBe(true);
    expect(meta.decline_reason).toBe("we don't stock channel");
    expect(meta.notes).toBeNull();
  });
});

describe("normalizeOfferOutput", () => {
  it("normalizes an alternate line: verified span, parsed price, catalog link, flags", () => {
    const { meta, lines } = normalizeOfferOutput(output([line(ALT_RAW)], { freight_basis: "separate" }), doc, CONTEXT, index, RECEIVED);
    expect(meta.declined).toBe(false);
    expect(meta.freight_basis).toBe("separate");
    expect(lines).toHaveLength(1);
    const [alt] = lines;
    expect(alt.request_line_id).toBe(LINE_ID_1);
    expect(alt.is_exact_match).toBe(false);
    expect(alt.alternate_types).toEqual(["wall"]);
    expect(alt.offered_desc).toBe("8x8x1/2");
    expect(alt.offered_catalog_item_id).toBe("HSS8x8x1/2");
    expect(alt.unit_price).toBe(64.5);
    expect(alt.price_basis).toBe("per_cwt");
    expect(alt.availability).toBe("stock");
    expect(alt.available_qty).toBeNull();
    expect(alt.flags).toEqual(["missing_qty"]);
    expect(alt.span_verified).toBe(true);
    expect(alt.source_span).toEqual({ kind: "text", start: REPLY.indexOf(ALT_RAW), end: REPLY.indexOf(ALT_RAW) + ALT_RAW.length });
    expect(alt.confidence).toBe(0.9);
  });

  it("normalizes an exact line with a quantity and no flags", () => {
    const exact = line(ALT_RAW, {
      request_line_id: LINE_ID_2,
      offered_desc: "HSS8x8x5/8",
      is_exact_match: true,
      alternate_types: [],
      available_qty: 60,
      unit: "pcs",
      unit_price_text: "$0.98/ft",
      price_basis: "per_ft",
    });
    const { lines } = normalizeOfferOutput(output([exact]), doc, CONTEXT, index, RECEIVED);
    expect(lines[0]).toMatchObject({
      request_line_id: LINE_ID_2,
      offered_catalog_item_id: "HSS8x8x5/8",
      is_exact_match: true,
      alternate_types: [],
      available_qty: 60,
      unit: "pcs",
      unit_price: 0.98,
      price_basis: "per_ft",
      flags: [],
    });
  });

  it("drops a request_line_id that is not in the context and flags unmatched_line", () => {
    const { lines } = normalizeOfferOutput(
      output([line(ALT_RAW, { request_line_id: UNKNOWN_ID }), line(ALT_RAW, { request_line_id: null }), line(ALT_RAW, { request_line_id: "  " })]),
      doc,
      CONTEXT,
      index,
      RECEIVED,
    );
    for (const l of lines) {
      expect(l.request_line_id).toBeNull();
      expect(l.flags).toEqual(["missing_qty", "unmatched_line"]);
    }
  });

  it("flags a missing price and quantity, not when declined", () => {
    const priceless = line(ALT_RAW, { unit_price_text: null, price_basis: null, available_qty: null });
    const open = normalizeOfferOutput(output([priceless]), doc, CONTEXT, index, RECEIVED).lines[0];
    expect(open.unit_price).toBeNull();
    expect(open.flags).toEqual(["missing_price", "missing_qty"]);
    const declined = normalizeOfferOutput(output([priceless], { declined: true }), doc, CONTEXT, index, RECEIVED).lines[0];
    expect(declined.flags).toEqual(["missing_qty"]);
  });

  it("flags unknown availability and an unreadable price text", () => {
    const l = line(ALT_RAW, { availability: "unknown", unit_price_text: "call for pricing", available_qty: 5, unit: "pcs" });
    const [n] = normalizeOfferOutput(output([l]), doc, CONTEXT, index, RECEIVED).lines;
    expect(n.unit_price).toBeNull();
    expect(n.flags).toEqual(["missing_price", "missing_availability"]);
  });

  it("parses the ready date against the received date and keeps unreadable date text", () => {
    const rolling = line(ALT_RAW, {
      availability: "rolling",
      ready_date_text: "week of Nov 17",
      delivery_estimate_text: "five loads, can cut 40'",
      unit_price_text: null,
      price_basis: null,
    });
    const [n] = normalizeOfferOutput(output([rolling]), doc, CONTEXT, index, RECEIVED).lines;
    expect(n.ready_date).toBe("2026-11-17");
    expect(n.delivery_estimate_text).toBe("five loads, can cut 40'");
    expect(n.flags).toEqual(["missing_price", "missing_qty"]);

    const vague = line(ALT_RAW, { availability: "rolling", ready_date_text: "mid November", delivery_estimate_text: null });
    const [v] = normalizeOfferOutput(output([vague]), doc, CONTEXT, index, RECEIVED).lines;
    expect(v.ready_date).toBeNull();
    expect(v.delivery_estimate_text).toBe("Ready: mid November");

    const both = line(ALT_RAW, { availability: "rolling", ready_date_text: "mid November", delivery_estimate_text: "two trucks" });
    expect(normalizeOfferOutput(output([both]), doc, CONTEXT, index, RECEIVED).lines[0].delivery_estimate_text).toBe("two trucks; Ready: mid November");
  });

  it("marks duplicates across lines and carries the model's judgment flags", () => {
    const a = line(ALT_RAW, { flags: ["ambiguous_basis"] });
    const b = line(ALT_RAW, { offered_desc: "HSS 8x8x1/2", flags: ["ambiguous_unit"] });
    const c = line(ALT_RAW, { request_line_id: LINE_ID_2, offered_desc: "8x8x1/2" });
    const { lines } = normalizeOfferOutput(output([a, b, c]), doc, CONTEXT, index, RECEIVED);
    expect(lines[0].flags).toEqual(["missing_qty", "ambiguous_basis", "possible_duplicate"]);
    expect(lines[1].flags).toEqual(["missing_qty", "ambiguous_unit", "possible_duplicate"]);
    expect(lines[2].flags).toEqual(["missing_qty"]);
  });

  it("leaves an unknown offered item unlinked and uses raw text when offered_desc is blank", () => {
    const custom = line(ALT_RAW, { offered_desc: "bent plate per print" });
    expect(normalizeOfferOutput(output([custom]), doc, CONTEXT, index, RECEIVED).lines[0].offered_catalog_item_id).toBeNull();
    const blank = line(ALT_RAW, { offered_desc: "  " });
    expect(normalizeOfferOutput(output([blank]), doc, CONTEXT, index, RECEIVED).lines[0].offered_desc).toBe(ALT_RAW);
  });

  it("repairs an off span and records an unverifiable one", () => {
    const shifted = line(ALT_RAW);
    shifted.span = { start: shifted.span.start + 4, end: shifted.span.end + 4 };
    const [repaired] = normalizeOfferOutput(output([shifted]), doc, CONTEXT, index, RECEIVED).lines;
    expect(repaired.span_verified).toBe(true);
    expect(repaired.source_span).toEqual({ kind: "text", start: REPLY.indexOf(ALT_RAW), end: REPLY.indexOf(ALT_RAW) + ALT_RAW.length });

    const invented = line("text that is not in the reply", { span: { start: 0, end: 10 } });
    const [unverified] = normalizeOfferOutput(output([invented]), doc, CONTEXT, index, RECEIVED).lines;
    expect(unverified.span_verified).toBe(false);
  });

  it("places an attachment span on its page", () => {
    const page = "W12x26 x 50' 8 pcs $62.50 cwt stock\nL2x2x1/4 x 20' 40 pcs $0.98 ft stock";
    const pdfDoc = buildExtractionDocument([
      { kind: "text", text: "Quote attached." },
      { kind: "attachment", attachmentId: "att-1", filename: "quote.pdf", page: 1, text: page },
    ]);
    const row = "L2x2x1/4 x 20' 40 pcs $0.98 ft stock";
    const start = pdfDoc.text.indexOf(row);
    const l = line(ALT_RAW, {
      raw_text: row,
      span: { start, end: start + row.length },
      offered_desc: "L2x2x1/4 x 20'",
      is_exact_match: true,
      alternate_types: [],
      available_qty: 40,
      unit: "pcs",
      unit_price_text: "$0.98 ft",
      price_basis: "per_ft",
    });
    const [n] = normalizeOfferOutput(output([l]), pdfDoc, CONTEXT, index, RECEIVED).lines;
    expect(n.source_span).toEqual({ kind: "attachment", attachment_id: "att-1", page: 1, start: page.indexOf(row), end: page.indexOf(row) + row.length });
    expect(n.span_verified).toBe(true);
    expect(n.unit_price).toBe(0.98);
    // The length written into the table cell does not stop the catalog link.
    expect(n.offered_catalog_item_id).toBe("L2x2x1/4");
  });

  it("links an offered item written with its length, and an exact match through the request line's designation", () => {
    const withLength = line(ALT_RAW, { offered_desc: "8x8x1/2 x 40'" });
    expect(normalizeOfferOutput(output([withLength]), doc, CONTEXT, index, RECEIVED).lines[0].offered_catalog_item_id).toBe("HSS8x8x1/2");

    const exactUnlinkable = line(ALT_RAW, { request_line_id: LINE_ID_2, offered_desc: "the 5/8 wall, 60 pcs", is_exact_match: true, alternate_types: [] });
    expect(normalizeOfferOutput(output([exactUnlinkable]), doc, CONTEXT, index, RECEIVED).lines[0].offered_catalog_item_id).toBe("HSS8x8x5/8");

    // An alternate written in words the catalog does not know stays unlinked rather than taking the request line's item.
    const alternateUnlinkable = line(ALT_RAW, { offered_desc: "the heavier wall", is_exact_match: false, alternate_types: ["wall"] });
    expect(normalizeOfferOutput(output([alternateUnlinkable]), doc, CONTEXT, index, RECEIVED).lines[0].offered_catalog_item_id).toBeNull();

    // An exact line tied to no context line has no designation to borrow.
    const untied = line(ALT_RAW, { request_line_id: null, offered_desc: "the 5/8 wall", is_exact_match: true, alternate_types: [] });
    expect(normalizeOfferOutput(output([untied]), doc, CONTEXT, index, RECEIVED).lines[0].offered_catalog_item_id).toBeNull();
  });

  it("clamps confidence and drops a non-positive quantity", () => {
    const l = line(ALT_RAW, { confidence: 1.7, available_qty: 0 });
    const [n] = normalizeOfferOutput(output([l]), doc, CONTEXT, index, RECEIVED).lines;
    expect(n.confidence).toBe(1);
    expect(n.available_qty).toBeNull();
    expect(normalizeOfferOutput(output([line(ALT_RAW, { confidence: -2 })]), doc, CONTEXT, index, RECEIVED).lines[0].confidence).toBe(0);
    expect(clampConfidence(Number.NaN)).toBe(0);
  });

  it("gives a decline zero lines and the reason", () => {
    const { meta, lines } = normalizeOfferOutput(
      output([], { declined: true, decline_reason: "we don't stock channel" }),
      buildExtractionDocument([{ kind: "text", text: "Sorry, we don't stock channel.\n\nJim\n" }]),
      CONTEXT,
      index,
      RECEIVED,
    );
    expect(meta.declined).toBe(true);
    expect(meta.decline_reason).toContain("channel");
    expect(lines).toEqual([]);
  });

  it("dedupes alternate types", () => {
    const l = line(ALT_RAW, { alternate_types: ["wall", "wall", "dimension"] });
    expect(normalizeOfferOutput(output([l]), doc, CONTEXT, index, RECEIVED).lines[0].alternate_types).toEqual(["wall", "dimension"]);
  });
});

describe("offerConfidence", () => {
  it("is the mean of the line confidences, clamped", () => {
    expect(offerConfidence([{ confidence: 0.8 }, { confidence: 1 }], false)).toBeCloseTo(0.9);
    expect(offerConfidence([{ confidence: 2 }], false)).toBe(1);
  });

  it("is 1 for a decline with no lines and 0 for an open reply with none", () => {
    expect(offerConfidence([], true)).toBe(1);
    expect(offerConfidence([], false)).toBe(0);
  });
});

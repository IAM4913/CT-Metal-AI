import { describe, expect, it } from "vitest";
import {
  alternateTypeValues,
  availabilityValues,
  freightBasisValues,
  lineUnitValues,
  priceBasisValues,
} from "@/lib/db/enums";
import { buildExtractionDocument } from "./document";
import {
  BEGIN_CONTEXT,
  buildOfferUserMessage,
  END_CONTEXT,
  formatContextLine,
  OFFER_SYSTEM_PROMPT,
  type OfferContextLine,
} from "./offers-prompt";
import { BEGIN_DOCUMENT, END_DOCUMENT } from "./prompt";

const EM_DASH = String.fromCharCode(0x2014);

const LINE_1: OfferContextLine = {
  request_line_id: "11111111-1111-4111-8111-000000000001",
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

const LINE_2: OfferContextLine = {
  request_line_id: "11111111-1111-4111-8111-000000000003",
  line_no: 2,
  designation: null,
  description: "some angle for clips",
  qty: null,
  unit: null,
  length_ft: null,
  length_text: "40' or 48'",
  grade_spec: "A36",
  category: "angle",
  dims: {},
};

describe("OFFER_SYSTEM_PROMPT", () => {
  it("opens with the PRD section 13 B stance and refuses to guess", () => {
    expect(OFFER_SYSTEM_PROMPT.startsWith("You are extracting a vendor's reply to a steel RFQ sent by a broker in Texas.")).toBe(true);
    expect(OFFER_SYSTEM_PROMPT).toContain("Do not guess prices. Do not guess quantities. Do not guess dates.");
    expect(OFFER_SYSTEM_PROMPT).toContain("Never invent a price, quantity, or date. Missing means null.");
    expect(OFFER_SYSTEM_PROMPT).toContain("raw_text must be copied verbatim from the document and span must be its character offsets");
  });

  it("ties lines to request_line_id from the context or null", () => {
    expect(OFFER_SYSTEM_PROMPT).toContain(BEGIN_CONTEXT);
    expect(OFFER_SYSTEM_PROMPT).toContain(END_CONTEXT);
    expect(OFFER_SYSTEM_PROMPT).toContain("copied exactly from the context, or null when it cannot be tied");
    expect(OFFER_SYSTEM_PROMPT).toContain("never pick one at random");
  });

  it("explains exact versus alternate against the context line", () => {
    expect(OFFER_SYSTEM_PROMPT).toContain("the request asks for 8x8x3/8 and the vendor offers 8x8x1/2, that is an alternate wall");
    expect(OFFER_SYSTEM_PROMPT).toContain("6x6x3/8 and the vendor offers 8x8x1/2, that is alternate dimension and wall");
    for (const alternate of alternateTypeValues) expect(OFFER_SYSTEM_PROMPT).toContain(alternate);
  });

  it("names the availability, basis, freight, and unit rules", () => {
    expect(OFFER_SYSTEM_PROMPT).toContain('stock when the vendor says "in stock", "on the floor", "from stock"');
    expect(OFFER_SYSTEM_PROMPT).toContain("rolling when a rolling or mill date is mentioned");
    expect(OFFER_SYSTEM_PROMPT).toContain("/cwt or cwt is per_cwt, /ft or ft is per_ft, /lb or lb is per_lb, /pc, each, or ea is per_pc, /ton or ton is per_ton, /sqft or sq ft is per_sqft");
    expect(OFFER_SYSTEM_PROMPT).toContain('included when the vendor says "delivered", "freight included"');
    expect(OFFER_SYSTEM_PROMPT).toContain('separate when "freight separate", "plus freight", "FOB mill", "FOB shipping point"');
    for (const value of [...availabilityValues, ...priceBasisValues, ...freightBasisValues, ...lineUnitValues]) {
      expect(OFFER_SYSTEM_PROMPT, value).toContain(value);
    }
  });

  it("asks for verbatim text fields and the model's three judgment flags only", () => {
    expect(OFFER_SYSTEM_PROMPT).toContain("ready_date_text: the ready or ship date exactly as written");
    expect(OFFER_SYSTEM_PROMPT).toContain("unit_price_text: the price exactly as written, currency and basis fragment included");
    expect(OFFER_SYSTEM_PROMPT).toContain('early_pay_pct_text: the early-payment discount text as written ("1% net 10"');
    expect(OFFER_SYSTEM_PROMPT).toContain("flags: any of ambiguous_unit");
    expect(OFFER_SYSTEM_PROMPT).toContain("ambiguous_basis");
    expect(OFFER_SYSTEM_PROMPT).toContain("possible_duplicate");
    expect(OFFER_SYSTEM_PROMPT).toContain("Do not report missing values as flags");
    expect(OFFER_SYSTEM_PROMPT).not.toContain("missing_price");
  });

  it("declines mean zero lines, and carries the fixture examples", () => {
    expect(OFFER_SYSTEM_PROMPT).toContain("A declined reply has zero lines.");
    for (const needle of [
      "3/8 wall is booked through December",
      "Have 60 pcs in stock at $0.98/ft, freight separate, 1% net 10.",
      "Rolling week of Nov 17, five loads, can cut 40'.",
      "Sorry, we don't stock channel.",
      "W12x26 x 50' 8 pcs $62.50 cwt stock",
      "Quote valid 7 days",
    ]) {
      expect(OFFER_SYSTEM_PROMPT, needle).toContain(needle);
    }
  });

  it("has no em dash", () => {
    expect(OFFER_SYSTEM_PROMPT).not.toContain(EM_DASH);
  });
});

describe("formatContextLine", () => {
  it("renders the id, designation, quantity, length, grade, category, and dims", () => {
    expect(formatContextLine(LINE_1)).toBe(
      "1. request_line_id 11111111-1111-4111-8111-000000000001: HSS8x8x3/8, qty 20 pcs, length 40 ft, grade (none), category hss_square, dims a=8 b=8 t=0.375",
    );
  });

  it("falls back to the description, the length text, and (none) markers", () => {
    expect(formatContextLine(LINE_2)).toBe(
      "2. request_line_id 11111111-1111-4111-8111-000000000003: some angle for clips, qty (not stated), length 40' or 48', grade A36, category angle, dims (none)",
    );
  });

  it("shows the description beside a designation when they differ", () => {
    const line = { ...LINE_1, description: "8 square 3/8" };
    expect(formatContextLine(line)).toContain("HSS8x8x3/8 (8 square 3/8), qty 20 pcs");
  });
});

describe("buildOfferUserMessage", () => {
  const doc = buildExtractionDocument([
    { kind: "text", text: "Quote attached. Let me know.\n\nMarcus" },
    { kind: "attachment", attachmentId: "att-1", filename: "delta-quote-4417.pdf", page: 1, text: "W12x26 x 50' 8 pcs $62.50 cwt stock" },
  ]);
  const message = buildOfferUserMessage(doc, [LINE_1, LINE_2]);

  it("wraps the document text unchanged between the markers", () => {
    expect(message).toContain(`${BEGIN_DOCUMENT}\n${doc.text}\n${END_DOCUMENT}`);
    expect(message.endsWith(END_DOCUMENT)).toBe(true);
  });

  it("lists every context line with its id between the context markers, before the document", () => {
    const contextStart = message.indexOf(BEGIN_CONTEXT);
    const contextEnd = message.indexOf(END_CONTEXT);
    const docStart = message.indexOf(BEGIN_DOCUMENT);
    expect(contextStart).toBeGreaterThan(-1);
    expect(contextEnd).toBeGreaterThan(contextStart);
    expect(docStart).toBeGreaterThan(contextEnd);
    const context = message.slice(contextStart, contextEnd);
    expect(context).toContain(formatContextLine(LINE_1));
    expect(context).toContain(formatContextLine(LINE_2));
    expect(context).toContain(LINE_1.request_line_id);
    expect(context).toContain(LINE_2.request_line_id);
  });

  it("states the character count and the layout", () => {
    expect(message).toContain(`It is ${doc.text.length} characters long.`);
    expect(message).toContain("1 attachment page");
    expect(message).toContain("=== SOURCE TEXT ===");
  });

  it("describes a document with no reply text (a PDF upload) and an empty context", () => {
    const pdfOnly = buildExtractionDocument([
      { kind: "attachment", attachmentId: "att-1", filename: "quote.pdf", page: 1, text: "row" },
      { kind: "attachment", attachmentId: "att-1", filename: "quote.pdf", page: 2, text: "row" },
    ]);
    const text = buildOfferUserMessage(pdfOnly, []);
    expect(text).toContain("2 attachment pages");
    expect(text).toContain("there is no reply text.");
    expect(text).not.toContain("=== SOURCE TEXT ===");
    expect(text).toContain("set request_line_id null on every line");
  });

  it("has no em dash", () => {
    expect(message).not.toContain(EM_DASH);
  });
});

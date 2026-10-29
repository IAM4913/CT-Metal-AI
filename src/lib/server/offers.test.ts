import { describe, expect, it } from "vitest";
import { requestStatusValues, rfqStatusValues, type AlternateType } from "@/lib/db/enums";
import { buildExtractionDocument } from "@/lib/parsing/document";
import {
  buildOfferSegments,
  diffRows,
  joinOfferNotes,
  manualOfferInputSchema,
  NeedsRfqChoiceError,
  nextRequestStatus,
  OfferExtractionError,
  offerLinePatchSchema,
  offerPatchSchema,
  reconcileExactness,
  recomputeOfferLineFlags,
  ReplyFileError,
  rfqStatusFromOffers,
  rowOfferFlags,
  sortOfferLines,
  toContextLine,
  toExpiryTimestamp,
  untiedLinesNote,
} from "./offers";

const LINE_ID = "11111111-1111-4111-8111-000000000001";
const RFQ_ID = "22222222-2222-4222-8222-222222222222";

describe("nextRequestStatus", () => {
  it("moves a sent request to collecting on the first offer and to comparing once every sent RFQ answered", () => {
    expect(nextRequestStatus("rfqs_sent", ["responded", "sent"])).toBe("collecting");
    expect(nextRequestStatus("rfqs_sent", ["responded"])).toBe("comparing");
    expect(nextRequestStatus("rfqs_sent", ["declined", "responded"])).toBe("comparing");
    expect(nextRequestStatus("collecting", ["responded", "sent"])).toBeNull();
    expect(nextRequestStatus("collecting", ["responded", "declined"])).toBe("comparing");
    expect(nextRequestStatus("collecting", ["closed", "responded"])).toBe("comparing");
  });

  it("counts a partially sent revision (some drafts still unsent) by its sent RFQs only", () => {
    expect(nextRequestStatus("rfqs_drafted", ["draft", "responded"])).toBe("comparing");
    expect(nextRequestStatus("rfqs_drafted", ["draft", "sent", "responded"])).toBe("collecting");
    expect(nextRequestStatus("rfqs_drafted", ["draft", "failed"])).toBeNull();
  });

  it("never moves a request backwards or before its RFQs went out", () => {
    for (const status of ["comparing", "sourced", "closed", "new", "parsing", "needs_review", "reviewed"] as const) {
      expect(nextRequestStatus(status, ["responded"]), status).toBeNull();
      expect(nextRequestStatus(status, ["responded", "sent"]), status).toBeNull();
    }
    expect(nextRequestStatus("rfqs_sent", [])).toBeNull();
  });

  it("decides every request status the database knows", () => {
    for (const status of requestStatusValues) {
      const next = nextRequestStatus(status, ["responded"]);
      expect(next === null || requestStatusValues.includes(next)).toBe(true);
    }
  });
});

describe("rfqStatusFromOffers", () => {
  it("is responded while any offer stands, declined when every offer is a decline, sent with none", () => {
    expect(rfqStatusFromOffers(["parsed"])).toBe("responded");
    expect(rfqStatusFromOffers(["declined", "reviewed"])).toBe("responded");
    expect(rfqStatusFromOffers(["declined"])).toBe("declined");
    expect(rfqStatusFromOffers(["declined", "declined"])).toBe("declined");
    expect(rfqStatusFromOffers([])).toBe("sent");
    for (const status of rfqStatusValues) expect(rfqStatusValues).toContain(status);
  });
});

describe("buildOfferSegments", () => {
  it("puts the reply text first and one segment per PDF page after it", () => {
    const segments = buildOfferSegments("Quote attached.", [
      { attachmentId: "att-1", filename: "quote.pdf", pages: ["page one", "page two"] },
      { attachmentId: "att-2", filename: "terms.pdf", pages: ["terms"] },
    ]);
    expect(segments).toEqual([
      { kind: "text", text: "Quote attached." },
      { kind: "attachment", attachmentId: "att-1", filename: "quote.pdf", page: 1, text: "page one" },
      { kind: "attachment", attachmentId: "att-1", filename: "quote.pdf", page: 2, text: "page two" },
      { kind: "attachment", attachmentId: "att-2", filename: "terms.pdf", page: 1, text: "terms" },
    ]);
    expect(buildExtractionDocument(segments).segments).toHaveLength(4);
  });

  it("has no text segment for a PDF upload or a blank body, and no segments at all for nothing", () => {
    expect(buildOfferSegments(null, [{ attachmentId: "a", filename: "q.pdf", pages: ["x"] }])[0].kind).toBe("attachment");
    expect(buildOfferSegments("   \n", [{ attachmentId: "a", filename: "q.pdf", pages: ["x"] }])).toHaveLength(1);
    expect(buildOfferSegments(null, [])).toEqual([]);
    expect(buildOfferSegments("", [{ attachmentId: "a", filename: "q.pdf", pages: [] }])).toEqual([]);
  });
});

describe("toContextLine", () => {
  const row = {
    id: LINE_ID,
    line_no: 2,
    description: "8 square 3/8",
    qty: 20,
    unit: "pcs" as const,
    length_ft: 40,
    length_text: "40'",
    grade_spec: null,
    category: "hss_square" as const,
    dims: { a: 8, b: 8, t: 0.375 },
  };

  it("carries the row's values and the designation", () => {
    expect(toContextLine(row, "HSS8x8x3/8")).toEqual({
      request_line_id: LINE_ID,
      line_no: 2,
      designation: "HSS8x8x3/8",
      description: "8 square 3/8",
      qty: 20,
      unit: "pcs",
      length_ft: 40,
      length_text: "40'",
      grade_spec: null,
      category: "hss_square",
      dims: { a: 8, b: 8, t: 0.375 },
    });
  });

  it("reads non-object dims as empty", () => {
    expect(toContextLine({ ...row, dims: 0 }, null).dims).toEqual({});
    expect(toContextLine({ ...row, dims: [1, 2] }, null).dims).toEqual({});
    expect(toContextLine({ ...row, dims: "x" }, null).designation).toBeNull();
  });
});

describe("untiedLinesNote and joinOfferNotes", () => {
  it("is null when every line was tied", () => {
    expect(untiedLinesNote([])).toBeNull();
  });

  it("names each untied line with its price and raw text", () => {
    const note = untiedLinesNote([
      { offered_desc: "C12x30", raw_text: " C12x30 40' $58/cwt ", unit_price: 58, price_basis: "per_cwt" },
      { offered_desc: "misc clips", raw_text: "clips extra", unit_price: null, price_basis: null },
    ]);
    expect(note).toBe(
      '2 lines could not be tied to a request line and were not stored:\n  - C12x30 at 58 per_cwt: "C12x30 40\' $58/cwt"\n  - misc clips: "clips extra"',
    );
    expect(untiedLinesNote([{ offered_desc: "x", raw_text: "x", unit_price: null, price_basis: null }])).toContain("1 line could not be tied to a request line and was not stored");
  });

  it("joins notes with a blank line and gives an empty string for nothing", () => {
    expect(joinOfferNotes("a", null, "  ", undefined, "b")).toBe("a\n\nb");
    expect(joinOfferNotes(null, "")).toBe("");
  });
});

describe("reconcileExactness", () => {
  const current = { is_exact_match: false, alternate_types: ["wall"] as AlternateType[] };

  it("clears the alternate types when the line becomes exact", () => {
    expect(reconcileExactness({ is_exact_match: true }, current)).toEqual({ is_exact_match: true, alternate_types: [] });
  });

  it("keeps the alternate types when the line stays or becomes an alternate", () => {
    expect(reconcileExactness({ is_exact_match: false }, { is_exact_match: true, alternate_types: [] })).toEqual({ is_exact_match: false, alternate_types: [] });
    expect(reconcileExactness({ is_exact_match: false }, current)).toEqual({ is_exact_match: false, alternate_types: ["wall"] });
  });

  it("makes the line an alternate when alternate types are named, and exact when they are cleared", () => {
    expect(reconcileExactness({ alternate_types: ["grade", "grade", "length"] }, { is_exact_match: true, alternate_types: [] })).toEqual({
      is_exact_match: false,
      alternate_types: ["grade", "length"],
    });
    expect(reconcileExactness({ alternate_types: [] }, current)).toEqual({ is_exact_match: false, alternate_types: [] });
    expect(reconcileExactness({ alternate_types: [], is_exact_match: true }, current)).toEqual({ is_exact_match: true, alternate_types: [] });
  });

  it("changes nothing when the patch touches neither", () => {
    expect(reconcileExactness({}, current)).toEqual(current);
  });
});

describe("selectionBoundChange", () => {
  const row = {
    request_line_id: LINE_ID,
    offered_catalog_item_id: "33333333-3333-4333-8333-000000000003",
    is_exact_match: true,
    alternate_types: [] as AlternateType[],
    offered_desc: "W12x26",
  };

  it("is bound by the request line, the catalog link, the exactness, and the alternate types", async () => {
    const { selectionBoundChange } = await import("./offers");
    expect(selectionBoundChange(row, { ...row, request_line_id: "11111111-1111-4111-8111-000000000002" })).toBe(true);
    expect(selectionBoundChange(row, { ...row, offered_catalog_item_id: null })).toBe(true);
    expect(selectionBoundChange(row, { ...row, is_exact_match: false })).toBe(true);
    expect(selectionBoundChange(row, { ...row, is_exact_match: false, alternate_types: ["wall"] })).toBe(true);
    const flagged = { ...row, is_exact_match: false, alternate_types: ["wall", "length"] as AlternateType[] };
    expect(selectionBoundChange(flagged, { ...flagged, alternate_types: ["length", "wall"] })).toBe(false);
    expect(selectionBoundChange(flagged, { ...flagged, alternate_types: ["length"] })).toBe(true);
  });

  it("is bound by a written length or sheet size, not by other wording", async () => {
    const { selectionBoundChange } = await import("./offers");
    expect(selectionBoundChange(row, { ...row, offered_desc: "W12x26 x 40'" })).toBe(true);
    expect(selectionBoundChange({ ...row, offered_desc: "W12x26 x 40'" }, { ...row, offered_desc: "W12x26 40 ft" })).toBe(false);
    expect(selectionBoundChange(row, { ...row, offered_desc: "W12x26 A992" })).toBe(false);
    const plate = { ...row, offered_desc: "PL3/8 48x96" };
    expect(selectionBoundChange(plate, { ...plate, offered_desc: "PL3/8 60x120" })).toBe(true);
    expect(selectionBoundChange(plate, { ...plate, offered_desc: "PL3/8 48 x 96 A36" })).toBe(false);
  });

  it("is not bound by a price, quantity, or date (those are compared at confirm time)", async () => {
    const { selectionBoundChange, SELECTION_BOUND_ERROR } = await import("./offers");
    expect(selectionBoundChange(row, { ...row })).toBe(false);
    expect(SELECTION_BOUND_ERROR).toContain("Compare tab");
    expect(SELECTION_BOUND_ERROR).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("recomputeOfferLineFlags", () => {
  const line = { request_line_id: LINE_ID, unit_price: null, available_qty: null, availability: "unknown" as const, flags: ["missing_price", "ambiguous_basis", "junk"] };

  it("recomputes the value flags and carries only the judgment flags", () => {
    expect(recomputeOfferLineFlags(line, false)).toEqual(["missing_price", "missing_qty", "missing_availability", "ambiguous_basis"]);
    expect(recomputeOfferLineFlags(line, true)).toEqual(["missing_qty", "missing_availability", "ambiguous_basis"]);
    expect(recomputeOfferLineFlags({ ...line, unit_price: 1, available_qty: 2, availability: "stock", flags: [] }, false)).toEqual([]);
  });
});

describe("sortOfferLines", () => {
  const LINE_A = "11111111-1111-4111-8111-00000000000a";
  const LINE_B = "11111111-1111-4111-8111-00000000000b";
  const LINE_C = "11111111-1111-4111-8111-00000000000c";
  const lineNo = new Map([
    [LINE_A, 1],
    [LINE_B, 2],
    [LINE_C, 3],
  ]);
  // One extraction: every row shares the batch's created_at and the ids are random.
  const batch = "2026-10-22T15:00:01.000Z";
  const lines = [
    { id: "f0000000-0000-4000-8000-000000000003", request_line_id: LINE_C, created_at: batch },
    { id: "a0000000-0000-4000-8000-000000000001", request_line_id: LINE_B, created_at: batch },
    { id: "c0000000-0000-4000-8000-000000000002", request_line_id: LINE_A, created_at: batch },
  ];

  it("orders a batch by the request line's line_no, not by id", () => {
    expect(sortOfferLines(lines, lineNo).map((l) => l.request_line_id)).toEqual([LINE_A, LINE_B, LINE_C]);
    expect(sortOfferLines([...lines].reverse(), lineNo)).toEqual(sortOfferLines(lines, lineNo));
    expect(lines[0].request_line_id).toBe(LINE_C);
  });

  it("breaks a tie on the same request line by created_at, then id, and sorts unknown lines last", () => {
    const later = "2026-10-23T09:00:00.000Z";
    const two = [
      { id: "b0000000-0000-4000-8000-000000000002", request_line_id: LINE_A, created_at: later },
      { id: "a0000000-0000-4000-8000-000000000001", request_line_id: LINE_A, created_at: batch },
      { id: "e0000000-0000-4000-8000-000000000005", request_line_id: "99999999-9999-4999-8999-999999999999", created_at: batch },
      { id: "d0000000-0000-4000-8000-000000000004", request_line_id: LINE_A, created_at: later },
    ];
    expect(sortOfferLines(two, lineNo).map((l) => l.id.slice(0, 1))).toEqual(["a", "b", "d", "e"]);
    expect(sortOfferLines([], lineNo)).toEqual([]);
  });
});

describe("rowOfferFlags", () => {
  it("keeps the app's flags and drops unknown strings", () => {
    expect(rowOfferFlags(["missing_price", "bogus", "possible_duplicate"])).toEqual(["missing_price", "possible_duplicate"]);
    expect(rowOfferFlags([])).toEqual([]);
  });
});

describe("diffRows", () => {
  it("lists the changed keys with their before and after values only", () => {
    type Row = { a: number; b: string; c: number[]; d: string | null };
    const before: Row = { a: 1, b: "x", c: [1, 2], d: null };
    const after: Row = { a: 1, b: "y", c: [1, 2], d: "set" };
    expect(diffRows(before, after, ["a", "b", "c", "d"])).toEqual({ changed: ["b", "d"], before: { b: "x", d: null }, after: { b: "y", d: "set" } });
    expect(diffRows(before, { ...before }, ["a", "b", "c", "d"]).changed).toEqual([]);
  });
});

describe("toExpiryTimestamp", () => {
  it("turns a date-only value into that day at 00:00 UTC and keeps a timestamp", () => {
    expect(toExpiryTimestamp("2026-10-29")).toBe("2026-10-29T00:00:00.000Z");
    expect(toExpiryTimestamp("2026-10-29T17:00:00.000Z")).toBe("2026-10-29T17:00:00.000Z");
    expect(toExpiryTimestamp("2026-10-29T12:00:00-05:00")).toBe("2026-10-29T17:00:00.000Z");
    expect(toExpiryTimestamp(null)).toBeNull();
  });
});

describe("schemas", () => {
  const manual = {
    rfqId: RFQ_ID,
    source: "phone",
    receivedAt: "2026-10-23T17:00:00.000Z",
    paymentTerms: "net 30",
    earlyPayPct: 1,
    earlyPayDays: 10,
    freightAmount: null,
    freightBasis: "separate",
    quoteExpiresAt: "2026-10-30T17:00:00.000Z",
    notes: null,
    declined: false,
    lines: [
      {
        requestLineId: LINE_ID,
        offeredDesc: "HSS8x8x3/8",
        isExactMatch: true,
        alternateTypes: [],
        availableQty: 20,
        unit: "pcs",
        availability: "stock",
        readyDate: null,
        deliveryEstimateText: null,
        unitPrice: 64.5,
        priceBasis: "per_cwt",
      },
    ],
  };

  it("accepts a manual quote with an ISO or date-only received date and expiry", () => {
    const parsed = manualOfferInputSchema.parse(manual);
    expect(parsed.receivedAt).toBeInstanceOf(Date);
    expect(parsed.receivedAt.toISOString()).toBe("2026-10-23T17:00:00.000Z");
    expect(manualOfferInputSchema.parse({ ...manual, receivedAt: "2026-10-23", quoteExpiresAt: "2026-10-30" }).quoteExpiresAt).toBe("2026-10-30");
    expect(manualOfferInputSchema.parse({ ...manual, quoteExpiresAt: null, lines: [] }).lines).toEqual([]);
  });

  it("refuses a bad source, a negative price, a zero quantity, a non-date, and a bad ready date", () => {
    expect(manualOfferInputSchema.safeParse({ ...manual, source: "email" }).success).toBe(false);
    expect(manualOfferInputSchema.safeParse({ ...manual, receivedAt: "yesterday" }).success).toBe(false);
    expect(manualOfferInputSchema.safeParse({ ...manual, lines: [{ ...manual.lines[0], unitPrice: -1 }] }).success).toBe(false);
    expect(manualOfferInputSchema.safeParse({ ...manual, lines: [{ ...manual.lines[0], availableQty: 0 }] }).success).toBe(false);
    expect(manualOfferInputSchema.safeParse({ ...manual, lines: [{ ...manual.lines[0], readyDate: "11/17" }] }).success).toBe(false);
    expect(manualOfferInputSchema.safeParse({ ...manual, lines: [{ ...manual.lines[0], offeredDesc: "  " }] }).success).toBe(false);
  });

  it("offerLinePatchSchema takes any subset of the grid fields and nothing else", () => {
    expect(offerLinePatchSchema.parse({ unit_price: null, ready_date: "2026-11-17" })).toEqual({ unit_price: null, ready_date: "2026-11-17" });
    expect(offerLinePatchSchema.parse({ request_line_id: LINE_ID, alternate_types: ["wall"] })).toEqual({ request_line_id: LINE_ID, alternate_types: ["wall"] });
    expect(offerLinePatchSchema.safeParse({ flags: [] }).success).toBe(false);
    expect(offerLinePatchSchema.safeParse({ available_qty: -3 }).success).toBe(false);
    expect(offerLinePatchSchema.safeParse({ ready_date: "Nov 17" }).success).toBe(false);
    expect(offerLinePatchSchema.safeParse({ offered_desc: " " }).success).toBe(false);
  });

  it("offerPatchSchema takes the header fields, with a date or a timestamp for the expiry", () => {
    expect(offerPatchSchema.parse({ quote_expires_at: "2026-10-30" })).toEqual({ quote_expires_at: "2026-10-30" });
    expect(offerPatchSchema.parse({ quote_expires_at: "2026-10-30T17:00:00.000Z", freight_basis: "included" })).toEqual({
      quote_expires_at: "2026-10-30T17:00:00.000Z",
      freight_basis: "included",
    });
    expect(offerPatchSchema.safeParse({ early_pay_pct: 150 }).success).toBe(false);
    expect(offerPatchSchema.safeParse({ early_pay_days: 0 }).success).toBe(false);
    expect(offerPatchSchema.safeParse({ status: "reviewed" }).success).toBe(false);
  });
});

describe("errors", () => {
  it("carry what the action needs", () => {
    const choice = new NeedsRfqChoiceError({ from: "a@b", subject: "Re", date: null, messageId: null, inReplyTo: "<x>", references: [], attachmentCount: 1 });
    expect(choice.name).toBe("NeedsRfqChoiceError");
    expect(choice.summary.inReplyTo).toBe("<x>");
    expect(choice.message).toContain("Pick the RFQ");

    const extraction = new OfferExtractionError("offer-1", RFQ_ID, new Error("model refused"));
    expect(extraction.offerId).toBe("offer-1");
    expect(extraction.rfqId).toBe(RFQ_ID);
    expect(extraction.message).toContain("model refused");
    expect(extraction.message).toContain("saved as an offer");

    expect(new ReplyFileError("bad file").name).toBe("ReplyFileError");
  });
});

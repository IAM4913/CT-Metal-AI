import { describe, expect, it } from "vitest";
import {
  buildComparison,
  buildOfferCell,
  changesForOfferLine,
  costInputFor,
  DECLINED_OFFER_ERROR,
  describeChanges,
  dimensionChanges,
  dimsRecord,
  effectiveAlternateTypes,
  fillableQty,
  freightKnown,
  groupSelectionsForPurchase,
  isAlternate,
  MOVED_SELECTION_ERROR,
  numDim,
  offerCellExtendedForQty,
  offeredLengthFt,
  offeredSheetSize,
  selectionBlockedReason,
  selectionSummary,
  SORT_KEYS,
  sortOffers,
  unfilledQty,
  unitsAgree,
  type BranchInput,
  type BuildInput,
  type CatalogItemInput,
  type OfferCell,
  type OfferInput,
  type OfferLineInput,
  type RequestLineInput,
  type RfqInput,
  type SelectionInput,
} from "./build";
import { hasValue, REASON_NO_EARLY_PAY, REASON_NO_PRICE, REASON_NO_WEIGHT } from "./cost";

const EM_DASH = String.fromCharCode(0x2014);

// ---------------------------------------------------------------------------
// Fixture: the mixed-list request answered by three vendors, one decline, one
// RFQ still out. Delta quotes everything exact (with early-pay terms), Alamo
// has a partial on the angle, an alternate wall on the tube, and a rolling
// beam with no price and no freight, Coastal has the beam per foot with
// freight included and a thicker plate.
// ---------------------------------------------------------------------------

const CATALOG: Record<string, CatalogItemInput & { id: string }> = {
  w12x26: { id: "item-w12x26", designation: "W12x26", category: "w_beam", dims: { d: 12, wt: 26 }, weight_per_ft: 26 },
  l2: { id: "item-l2", designation: "L2x2x1/4", category: "angle", dims: { a: 2, b: 2, t: 0.25 }, weight_per_ft: 3.19 },
  pl38: { id: "item-pl38", designation: "PL3/8", category: "plate", dims: { t: 0.375, weight_per_sqft: 15.3 }, weight_per_ft: null },
  pl12: { id: "item-pl12", designation: "PL1/2", category: "plate", dims: { t: 0.5, weight_per_sqft: 20.4 }, weight_per_ft: null },
  hss38: { id: "item-hss6-38", designation: "HSS6x6x3/8", category: "hss_square", dims: { a: 6, b: 6, t: 0.375 }, weight_per_ft: 27.48 },
  hss12: { id: "item-hss6-12", designation: "HSS6x6x1/2", category: "hss_square", dims: { a: 6, b: 6, t: 0.5 }, weight_per_ft: 35.24 },
  w12x22: { id: "item-w12x22", designation: "W12x22", category: "w_beam", dims: { d: 12, wt: 22 }, weight_per_ft: 22 },
  hss8x6: { id: "item-hss8x6", designation: "HSS8x6x3/8", category: "hss_rectangular", dims: { a: 8, b: 6, t: 0.375 }, weight_per_ft: 31.84 },
};

function catalogById(): Map<string, CatalogItemInput> {
  return new Map(Object.values(CATALOG).map(({ id, ...item }) => [id, item]));
}

function line(overrides: Partial<RequestLineInput> & Pick<RequestLineInput, "id" | "line_no">): RequestLineInput {
  return {
    raw_text: "",
    description: "",
    catalog_item_id: null,
    category: null,
    dims: {},
    grade_spec: null,
    qty: null,
    unit: "pcs",
    length_ft: null,
    length_text: null,
    status: "confirmed",
    ...overrides,
  };
}

const LINES: RequestLineInput[] = [
  line({
    id: "line-1",
    line_no: 1,
    raw_text: "W12x26 x 50' qty 8",
    description: "W12x26",
    catalog_item_id: CATALOG.w12x26.id,
    category: "w_beam",
    dims: { d: 12, wt: 26 },
    qty: 8,
    length_ft: 50,
    length_text: "50'",
  }),
  line({
    id: "line-2",
    line_no: 2,
    raw_text: "L2x2x1/4 x 20' qty 40",
    description: "L2x2x1/4",
    catalog_item_id: CATALOG.l2.id,
    category: "angle",
    dims: { a: 2, b: 2, t: 0.25 },
    qty: 40,
    length_ft: 20,
    length_text: "20'",
  }),
  line({
    id: "line-3",
    line_no: 3,
    raw_text: "3/8 plate 48x96 qty 10 A36",
    description: "3/8 plate",
    catalog_item_id: CATALOG.pl38.id,
    category: "plate",
    dims: { t: 0.375, w: 48, l: 96 },
    grade_spec: "A36",
    qty: 10,
  }),
  line({
    id: "line-4",
    line_no: 4,
    raw_text: '6" sq 3/8 x 24\' qty 20',
    description: '6" sq 3/8',
    catalog_item_id: CATALOG.hss38.id,
    category: "hss_square",
    dims: { a: 6, b: 6, t: 0.375 },
    qty: 20,
    length_ft: 24,
    length_text: "24'",
  }),
  line({ id: "line-5", line_no: 5, raw_text: "removed clip angle", description: "angle", status: "removed", qty: 4 }),
];

const BRANCHES: BranchInput[] = [
  { id: "br-delta", name: "Houston", vendor_name: "Delta Steel" },
  { id: "br-alamo", name: "San Antonio", vendor_name: "Alamo Metals" },
  { id: "br-coastal", name: "Beaumont", vendor_name: "Coastal Steel" },
  { id: "br-dixie", name: "Dallas", vendor_name: "Dixie Metals" },
  { id: "br-echo", name: "Tyler", vendor_name: "Echo Steel" },
];

const RFQS: RfqInput[] = [
  { id: "rfq-delta", branch_id: "br-delta", status: "responded", sent_at: "2026-10-22T14:00:00.000Z" },
  { id: "rfq-alamo", branch_id: "br-alamo", status: "responded", sent_at: "2026-10-22T14:00:00.000Z" },
  { id: "rfq-coastal", branch_id: "br-coastal", status: "responded", sent_at: "2026-10-22T14:00:00.000Z" },
  { id: "rfq-dixie", branch_id: "br-dixie", status: "declined", sent_at: "2026-10-22T14:00:00.000Z" },
  { id: "rfq-echo", branch_id: "br-echo", status: "sent", sent_at: "2026-10-22T14:05:00.000Z" },
  { id: "rfq-foxtrot", branch_id: "br-foxtrot", status: "draft", sent_at: null },
];

function offer(overrides: Partial<OfferInput> & Pick<OfferInput, "id" | "rfq_id" | "branch_id">): OfferInput {
  return {
    message_id: null,
    attachment_id: null,
    status: "reviewed",
    received_at: "2026-10-22T16:00:00.000Z",
    quote_expires_at: null,
    payment_terms: null,
    early_pay_pct: null,
    early_pay_days: null,
    freight_amount: null,
    freight_basis: "unknown",
    notes: "",
    ...overrides,
  };
}

const OFFERS: OfferInput[] = [
  offer({
    id: "offer-delta",
    rfq_id: "rfq-delta",
    branch_id: "br-delta",
    message_id: "msg-delta",
    payment_terms: "Net 30, 1% 10 days",
    early_pay_pct: 1,
    early_pay_days: 10,
    freight_amount: 350,
    freight_basis: "separate",
    quote_expires_at: "2026-11-05T00:00:00.000Z",
  }),
  offer({ id: "offer-alamo", rfq_id: "rfq-alamo", branch_id: "br-alamo", attachment_id: "att-alamo", status: "parsed" }),
  offer({
    id: "offer-coastal",
    rfq_id: "rfq-coastal",
    branch_id: "br-coastal",
    message_id: "msg-coastal",
    payment_terms: "Net 30",
    freight_basis: "included",
  }),
  offer({ id: "offer-dixie", rfq_id: "rfq-dixie", branch_id: "br-dixie", status: "declined", notes: "Sorry, we don't stock plate." }),
];

function offerLine(overrides: Partial<OfferLineInput> & Pick<OfferLineInput, "id" | "offer_id" | "request_line_id" | "offered_desc">): OfferLineInput {
  return {
    offered_catalog_item_id: null,
    is_exact_match: true,
    alternate_types: [],
    available_qty: null,
    unit: null,
    availability: "unknown",
    ready_date: null,
    delivery_estimate_text: null,
    unit_price: null,
    price_basis: null,
    flags: [],
    confidence: 0.9,
    ...overrides,
  };
}

const OFFER_LINES: OfferLineInput[] = [
  offerLine({
    id: "ol-delta-1",
    offer_id: "offer-delta",
    request_line_id: "line-1",
    offered_desc: "W12x26",
    offered_catalog_item_id: CATALOG.w12x26.id,
    available_qty: 8,
    unit: "pcs",
    availability: "stock",
    unit_price: 64.5,
    price_basis: "per_cwt",
  }),
  offerLine({
    id: "ol-delta-2",
    offer_id: "offer-delta",
    request_line_id: "line-2",
    offered_desc: "L2x2x1/4",
    offered_catalog_item_id: CATALOG.l2.id,
    available_qty: 60,
    unit: "pcs",
    availability: "stock",
    unit_price: 0.98,
    price_basis: "per_ft",
  }),
  offerLine({
    id: "ol-delta-3",
    offer_id: "offer-delta",
    request_line_id: "line-3",
    offered_desc: "PL3/8 48x96",
    offered_catalog_item_id: CATALOG.pl38.id,
    available_qty: 10,
    unit: "pcs",
    availability: "stock",
    unit_price: 0.62,
    price_basis: "per_lb",
  }),
  offerLine({
    id: "ol-delta-4",
    offer_id: "offer-delta",
    request_line_id: "line-4",
    offered_desc: "HSS6x6x3/8",
    offered_catalog_item_id: CATALOG.hss38.id,
    available_qty: 20,
    unit: "pcs",
    availability: "stock",
    unit_price: 412,
    price_basis: "per_pc",
  }),
  offerLine({
    id: "ol-alamo-1",
    offer_id: "offer-alamo",
    request_line_id: "line-1",
    offered_desc: "W12x26",
    offered_catalog_item_id: CATALOG.w12x26.id,
    availability: "rolling",
    ready_date: "2026-11-17",
    delivery_estimate_text: "five loads, can cut 50'",
    flags: ["missing_price", "missing_qty"],
    confidence: 0.7,
  }),
  offerLine({
    id: "ol-alamo-2",
    offer_id: "offer-alamo",
    request_line_id: "line-2",
    offered_desc: "L2x2x1/4",
    offered_catalog_item_id: CATALOG.l2.id,
    available_qty: 25,
    unit: "pcs",
    availability: "stock",
    unit_price: 1.05,
    price_basis: "per_ft",
  }),
  offerLine({
    id: "ol-alamo-4",
    offer_id: "offer-alamo",
    request_line_id: "line-4",
    offered_desc: "6x6x1/2",
    offered_catalog_item_id: CATALOG.hss12.id,
    is_exact_match: false,
    alternate_types: ["wall"],
    availability: "stock",
    unit_price: 66,
    price_basis: "per_cwt",
  }),
  offerLine({
    id: "ol-coastal-1",
    offer_id: "offer-coastal",
    request_line_id: "line-1",
    offered_desc: "W12x26 x 50'",
    offered_catalog_item_id: CATALOG.w12x26.id,
    available_qty: 8,
    unit: "pcs",
    availability: "stock",
    unit_price: 17.1,
    price_basis: "per_ft",
  }),
  offerLine({
    id: "ol-coastal-3",
    offer_id: "offer-coastal",
    request_line_id: "line-3",
    offered_desc: "PL1/2",
    offered_catalog_item_id: CATALOG.pl12.id,
    is_exact_match: false,
    alternate_types: ["dimension"],
    available_qty: 10,
    unit: "pcs",
    availability: "stock",
    unit_price: 0.6,
    price_basis: "per_lb",
  }),
  offerLine({ id: "ol-dixie-3", offer_id: "offer-dixie", request_line_id: "line-3", offered_desc: "plate", flags: ["missing_price"] }),
  offerLine({ id: "ol-orphan", offer_id: "offer-missing", request_line_id: "line-1", offered_desc: "W12x26", unit_price: 1, price_basis: "per_ft" }),
  offerLine({ id: "ol-removed", offer_id: "offer-delta", request_line_id: "line-5", offered_desc: "angle", unit_price: 1, price_basis: "per_ft" }),
];

const SELECTIONS: SelectionInput[] = [
  { id: "sel-1", request_line_id: "line-1", offer_line_id: "ol-delta-1", qty: 8, note: null },
  { id: "sel-2a", request_line_id: "line-2", offer_line_id: "ol-delta-2", qty: 15, note: null },
  { id: "sel-2b", request_line_id: "line-2", offer_line_id: "ol-alamo-2", qty: 25, note: "balance from Alamo" },
  { id: "sel-4a", request_line_id: "line-4", offer_line_id: "ol-delta-4", qty: 20, note: null },
  { id: "sel-4b", request_line_id: "line-4", offer_line_id: "ol-alamo-4", qty: 5, note: null },
];

function input(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    lines: LINES,
    offers: OFFERS,
    offerLines: OFFER_LINES,
    rfqs: RFQS,
    branches: BRANCHES,
    selections: SELECTIONS,
    catalogById: catalogById(),
    ...overrides,
  };
}

function cellOf(cells: OfferCell[], offerLineId: string): OfferCell {
  const cell = cells.find((c) => c.offer_line_id === offerLineId);
  if (!cell) throw new Error(`no cell ${offerLineId}`);
  return cell;
}

function branchMap(): Map<string, BranchInput> {
  return new Map(BRANCHES.map((branch) => [branch.id, branch]));
}

// ---------------------------------------------------------------------------
// The four-line scenario
// ---------------------------------------------------------------------------

describe("buildComparison on the mixed-list scenario", () => {
  const model = buildComparison(input());
  const [beam, angle, plate, tube] = model.lines;

  it("has one block per live request line in line order, removed lines left out", () => {
    expect(model.lines.map((entry) => entry.line.id)).toEqual(["line-1", "line-2", "line-3", "line-4"]);
    expect(beam.line).toEqual({
      id: "line-1",
      line_no: 1,
      designation: "W12x26",
      description: "W12x26",
      raw_text: "W12x26 x 50' qty 8",
      qty: 8,
      unit: "pcs",
      length_ft: 50,
      length_text: "50'",
      grade_spec: null,
      category: "w_beam",
      dims: { d: 12, wt: 26 },
    });
    expect(plate.line.grade_spec).toBe("A36");
    expect(plate.line.dims).toEqual({ t: 0.375, w: 48, l: 96 });
  });

  it("orders each line's offers by vendor name then branch name, never by price", () => {
    expect(beam.offers.map((cell) => cell.vendor_name)).toEqual(["Alamo Metals", "Coastal Steel", "Delta Steel"]);
    expect(angle.offers.map((cell) => cell.vendor_name)).toEqual(["Alamo Metals", "Delta Steel"]);
    expect(tube.offers.map((cell) => cell.vendor_name)).toEqual(["Alamo Metals", "Delta Steel"]);
  });

  it("skips an offer line whose offer is not in the input", () => {
    expect(beam.offers.map((cell) => cell.offer_line_id)).not.toContain("ol-orphan");
    expect(model.lines.flatMap((entry) => entry.offers).map((cell) => cell.offer_line_id)).not.toContain("ol-removed");
  });

  it("names the vendor, branch, RFQ, and reply source on every cell", () => {
    const delta = cellOf(beam.offers, "ol-delta-1");
    expect(delta).toMatchObject({
      offer_id: "offer-delta",
      rfq_id: "rfq-delta",
      branch_id: "br-delta",
      vendor_name: "Delta Steel",
      branch_name: "Houston",
      offer_status: "reviewed",
      offered_designation: "W12x26",
      source: { message_id: "msg-delta", attachment_id: null },
      quote_expires_at: "2026-11-05T00:00:00.000Z",
      payment_terms: "Net 30, 1% 10 days",
    });
    expect(cellOf(beam.offers, "ol-alamo-1").source).toEqual({ message_id: null, attachment_id: "att-alamo" });
  });

  it("carries the request line and whether the vendor's unit is the request's on every cell", () => {
    for (const entry of model.lines) {
      for (const cell of entry.offers) expect(cell.request_line_id).toBe(entry.line.id);
    }
    expect(cellOf(beam.offers, "ol-delta-1").same_unit).toBe(true);
    // Alamo named no quantity for the beam and no unit: nothing to mix
    expect(cellOf(beam.offers, "ol-alamo-1").same_unit).toBe(true);
  });

  it("computes the exact per_cwt beam: extended, per-foot, early pay, freight known", () => {
    const delta = cellOf(beam.offers, "ol-delta-1");
    expect(delta.extended).toEqual({ value: 6708 });
    expect(delta.per_ft).toEqual({ value: 16.77 });
    expect(delta.early_pay).toEqual({ pct: 1, days: 10, savings: { value: 67.08 } });
    expect(delta.freight_amount).toBe(350);
    expect(delta.freight_basis).toBe("separate");
    expect(delta.unfilled).toBe(0);
    expect(delta.incomplete).toBe(false);
    expect(delta.cost_input).toEqual({
      price_basis: "per_cwt",
      unit_price: 64.5,
      qty_pcs: 8,
      unit: "pcs",
      length_ft: 50,
      weight_per_ft: 26,
      plate: null,
    });
  });

  it("shows the rolling beam with no price as unknown, incomplete, with its date and estimate", () => {
    const alamo = cellOf(beam.offers, "ol-alamo-1");
    expect(alamo.availability).toBe("rolling");
    expect(alamo.ready_date).toBe("2026-11-17");
    expect(alamo.delivery_estimate_text).toBe("five loads, can cut 50'");
    expect(alamo.unit_price).toBeNull();
    expect(alamo.extended).toEqual({ reason: REASON_NO_PRICE });
    expect(alamo.per_ft).toEqual({ reason: REASON_NO_PRICE });
    expect(alamo.early_pay.savings).toEqual({ reason: REASON_NO_EARLY_PAY });
    expect(alamo.unfilled).toBeNull();
    expect(alamo.incomplete).toBe(true);
    expect(alamo.flags).toEqual(["missing_price", "missing_qty"]);
  });

  it("treats freight included as known freight, so a per_ft quote with no amount is complete", () => {
    const coastal = cellOf(beam.offers, "ol-coastal-1");
    expect(coastal.extended).toEqual({ value: 6840 });
    expect(coastal.per_ft).toEqual({ value: 17.1 });
    expect(coastal.freight_amount).toBeNull();
    expect(coastal.freight_basis).toBe("included");
    expect(coastal.incomplete).toBe(false);
    expect(coastal.early_pay.savings).toEqual({ reason: REASON_NO_EARLY_PAY });
  });

  it("prices a partial quantity for what the vendor has and shows the unfilled balance", () => {
    const alamo = cellOf(angle.offers, "ol-alamo-2");
    expect(alamo.available_qty).toBe(25);
    expect(alamo.unfilled).toBe(15);
    expect(alamo.cost_input.qty_pcs).toBe(25);
    expect(alamo.extended).toEqual({ value: 525 });
    expect(alamo.per_ft).toEqual({ value: 1.05 });
    // freight_basis unknown with no amount: unknown freight marks the cell incomplete
    expect(alamo.incomplete).toBe(true);
  });

  it("prices a surplus vendor for the requested quantity, not the stock count", () => {
    const delta = cellOf(angle.offers, "ol-delta-2");
    expect(delta.available_qty).toBe(60);
    expect(delta.unfilled).toBe(0);
    expect(delta.cost_input.qty_pcs).toBe(40);
    expect(delta.extended).toEqual({ value: 784 });
    expect(delta.early_pay.savings).toEqual({ value: 7.84 });
  });

  it("weighs plate from thickness and sheet size and has no per-foot price for it", () => {
    const delta = cellOf(plate.offers, "ol-delta-3");
    expect(delta.cost_input.plate).toEqual({ t_in: 0.375, w_in: 48, l_in: 96, weight_per_sqft: 15.3 });
    expect(delta.extended).toEqual({ value: 3035.52 });
    expect(delta.per_ft).toEqual({ reason: REASON_NO_WEIGHT });
    expect(delta.early_pay.savings).toEqual({ value: 30.36 });
  });

  it("flags the alternate wall with the wall change and prices it at the offered section's weight", () => {
    const alamo = cellOf(tube.offers, "ol-alamo-4");
    expect(alamo.is_exact_match).toBe(false);
    expect(alamo.alternate_types).toEqual(["wall"]);
    expect(alamo.changed).toEqual(["wall 3/8 to 1/2"]);
    expect(alamo.offered_designation).toBe("HSS6x6x1/2");
    expect(alamo.cost_input.weight_per_ft).toBe(35.24);
    expect(alamo.cost_input.qty_pcs).toBe(20);
    expect(alamo.extended).toEqual({ value: 11164.03 });
    expect(alamo.per_ft).toEqual({ value: 23.2584 });
    expect(alamo.unfilled).toBeNull();
  });

  it("flags a thicker plate as a thickness change and weighs the offered thickness", () => {
    const coastal = cellOf(plate.offers, "ol-coastal-3");
    expect(coastal.changed).toEqual(["thickness 3/8 to 1/2"]);
    expect(coastal.cost_input.plate).toEqual({ t_in: 0.5, w_in: 48, l_in: 96, weight_per_sqft: 20.4 });
    expect(coastal.extended).toEqual({ value: 3916.8 });
  });

  it("prices the per_pc tube and its per-foot equivalent from the requested length", () => {
    const delta = cellOf(tube.offers, "ol-delta-4");
    expect(delta.extended).toEqual({ value: 8240 });
    expect(delta.per_ft).toEqual({ value: 17.1667 });
    expect(delta.changed).toEqual([]);
  });

  it("keeps a declined offer's line visible with its offer status, and lists the decline", () => {
    const dixie = cellOf(plate.offers, "ol-dixie-3");
    expect(dixie.offer_status).toBe("declined");
    expect(dixie.extended).toEqual({ reason: REASON_NO_PRICE });
    expect(model.declined).toEqual([{ rfq_id: "rfq-dixie", vendor_name: "Dixie Metals", branch_name: "Dallas", reason: "Sorry, we don't stock plate." }]);
  });

  it("lists the RFQs still out (sent, no reply) and not drafts or answered ones", () => {
    expect(model.awaiting).toEqual([{ rfq_id: "rfq-echo", vendor_name: "Echo Steel", branch_name: "Tyler", sent_at: "2026-10-22T14:05:00.000Z" }]);
  });

  it("sums selections per line: full, split, none, and over-selected", () => {
    expect(beam.selections).toEqual([{ selection_id: "sel-1", offer_line_id: "ol-delta-1", qty: 8, note: null }]);
    expect([beam.selected_qty, beam.remaining, beam.over_selected]).toEqual([8, 0, false]);

    expect(angle.selections.map((s) => [s.offer_line_id, s.qty, s.note])).toEqual([
      ["ol-delta-2", 15, null],
      ["ol-alamo-2", 25, "balance from Alamo"],
    ]);
    expect([angle.selected_qty, angle.remaining, angle.over_selected]).toEqual([40, 0, false]);

    expect(plate.selections).toEqual([]);
    expect([plate.selected_qty, plate.remaining, plate.over_selected]).toEqual([0, 10, false]);

    expect([tube.selected_qty, tube.remaining, tube.over_selected]).toEqual([25, 0, true]);
  });

  it("writes no em dash anywhere in the model", () => {
    expect(JSON.stringify(model)).not.toContain(EM_DASH);
  });

  it("is deterministic", () => {
    expect(buildComparison(input())).toEqual(model);
  });

  it("names unknown branches rather than failing", () => {
    const model2 = buildComparison(input({ branches: [] }));
    expect(model2.lines[0].offers[0]).toMatchObject({ vendor_name: "Unknown vendor", branch_name: "Unknown branch" });
    expect(model2.awaiting[0]).toMatchObject({ vendor_name: "Unknown vendor", branch_name: "Unknown branch" });
  });

  it("has no selections and full remaining quantities when none were made", () => {
    const model2 = buildComparison(input({ selections: [] }));
    for (const entry of model2.lines) {
      expect(entry.selections).toEqual([]);
      expect(entry.selected_qty).toBe(0);
      expect(entry.remaining).toBe(entry.line.qty);
      expect(entry.over_selected).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Sorting (PRD rule 6)
// ---------------------------------------------------------------------------

describe("sortOffers", () => {
  const model = buildComparison(input());
  const beam = model.lines[0].offers;

  it("vendor: vendor name then branch name, the default", () => {
    expect(sortOffers(beam, "vendor").map((c) => c.offer_line_id)).toEqual(["ol-alamo-1", "ol-coastal-1", "ol-delta-1"]);
    const twoBranches: OfferCell[] = [
      { ...beam[2], branch_name: "Waco", offer_line_id: "x-waco" },
      { ...beam[2], branch_name: "Austin", offer_line_id: "x-austin" },
    ];
    expect(sortOffers(twoBranches, "vendor").map((c) => c.offer_line_id)).toEqual(["x-austin", "x-waco"]);
  });

  it("price: by per-foot price, then extended-only cells, unknown last", () => {
    expect(sortOffers(beam, "price").map((c) => c.offer_line_id)).toEqual(["ol-delta-1", "ol-coastal-1", "ol-alamo-1"]);
    // Plate has no per-foot price: the two priced cells sort by extended cost, the unpriced decline last.
    const plate = model.lines[2].offers;
    expect(sortOffers(plate, "price").map((c) => c.offer_line_id)).toEqual(["ol-delta-3", "ol-coastal-3", "ol-dixie-3"]);
  });

  it("ready_date: soonest first, no date last, ties by vendor", () => {
    expect(sortOffers(beam, "ready_date").map((c) => c.offer_line_id)).toEqual(["ol-alamo-1", "ol-coastal-1", "ol-delta-1"]);
    const dated: OfferCell[] = [
      { ...beam[2], ready_date: "2026-12-01", offer_line_id: "dec" },
      { ...beam[2], ready_date: "2026-11-03", offer_line_id: "nov" },
      { ...beam[2], ready_date: null, offer_line_id: "none" },
    ];
    expect(sortOffers(dated, "ready_date").map((c) => c.offer_line_id)).toEqual(["nov", "dec", "none"]);
  });

  it("availability: stock, rolling, unknown, then ready date, then vendor", () => {
    expect(sortOffers(beam, "availability").map((c) => c.offer_line_id)).toEqual(["ol-coastal-1", "ol-delta-1", "ol-alamo-1"]);
    const mixed: OfferCell[] = [
      { ...beam[2], availability: "unknown", offer_line_id: "u" },
      { ...beam[2], availability: "rolling", ready_date: "2026-12-01", offer_line_id: "r-dec" },
      { ...beam[2], availability: "rolling", ready_date: "2026-11-17", offer_line_id: "r-nov" },
      { ...beam[2], availability: "stock", offer_line_id: "s" },
    ];
    expect(sortOffers(mixed, "availability").map((c) => c.offer_line_id)).toEqual(["s", "r-nov", "r-dec", "u"]);
  });

  it("is stable and returns a copy", () => {
    const same: OfferCell[] = [
      { ...beam[2], offer_line_id: "first" },
      { ...beam[2], offer_line_id: "second" },
    ];
    for (const key of SORT_KEYS) {
      const sorted = sortOffers(same, key);
      expect(sorted.map((c) => c.offer_line_id), key).toEqual(["first", "second"]);
      expect(sorted).not.toBe(same);
    }
    expect(beam.map((c) => c.offer_line_id)).toEqual(["ol-alamo-1", "ol-coastal-1", "ol-delta-1"]);
  });
});

// ---------------------------------------------------------------------------
// Purchase grouping and recomputing at the selected quantity
// ---------------------------------------------------------------------------

describe("offerCellExtendedForQty", () => {
  const model = buildComparison(input());

  it("recomputes the extended cost for the selected quantity", () => {
    const delta = cellOf(model.lines[1].offers, "ol-delta-2");
    expect(offerCellExtendedForQty(delta, 15)).toEqual({ value: 294 });
    expect(offerCellExtendedForQty(delta, 40)).toEqual(delta.extended);
    const alamoTube = cellOf(model.lines[3].offers, "ol-alamo-4");
    expect(offerCellExtendedForQty(alamoTube, 5)).toEqual({ value: 2791.01 });
  });

  it("keeps the reasons", () => {
    const alamo = cellOf(model.lines[0].offers, "ol-alamo-1");
    expect(offerCellExtendedForQty(alamo, 8)).toEqual({ reason: REASON_NO_PRICE });
    expect(offerCellExtendedForQty(cellOf(model.lines[1].offers, "ol-delta-2"), 0)).toEqual({ reason: "no quantity" });
  });
});

describe("groupSelectionsForPurchase", () => {
  const model = buildComparison(input());
  const cells = model.lines.flatMap((entry) => entry.offers);

  it("makes one group per branch in vendor order with material and freight totals", () => {
    const groups = groupSelectionsForPurchase(cells, SELECTIONS);
    expect(groups.map((g) => g.branch_id)).toEqual(["br-alamo", "br-delta"]);

    const [alamo, delta] = groups;
    expect(delta).toEqual({
      branch_id: "br-delta",
      vendor_name: "Delta Steel",
      branch_name: "Houston",
      selection_ids: ["sel-1", "sel-2a", "sel-4a"],
      offer_ids: ["offer-delta"],
      total_material: 6708 + 294 + 8240,
      total_freight: 350,
      unknowns: [],
    });
    expect(alamo.selection_ids).toEqual(["sel-2b", "sel-4b"]);
    expect(alamo.total_material).toBe(525 + 2791.01);
    expect(alamo.total_freight).toBeNull();
    expect(alamo.unknowns).toEqual(["freight from Alamo Metals San Antonio: unknown"]);
  });

  it("leaves material null when any selected cell cannot be priced", () => {
    const groups = groupSelectionsForPurchase(cells, [
      { id: "s1", request_line_id: "line-1", offer_line_id: "ol-alamo-1", qty: 8, note: null },
      { id: "s2", request_line_id: "line-2", offer_line_id: "ol-alamo-2", qty: 25, note: null },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].total_material).toBeNull();
    expect(groups[0].unknowns).toEqual(["material for W12x26: no price", "freight from Alamo Metals San Antonio: unknown"]);
  });

  it("counts freight once per offer and included freight as nothing extra", () => {
    const groups = groupSelectionsForPurchase(cells, [
      { id: "s1", request_line_id: "line-1", offer_line_id: "ol-coastal-1", qty: 8, note: null },
      { id: "s2", request_line_id: "line-3", offer_line_id: "ol-coastal-3", qty: 10, note: null },
    ]);
    expect(groups[0].offer_ids).toEqual(["offer-coastal"]);
    expect(groups[0].total_freight).toBe(0);
    expect(groups[0].total_material).toBe(6840 + 3916.8);
  });

  it("refuses a selection that points at no cell", () => {
    expect(() => groupSelectionsForPurchase(cells, [{ id: "s", request_line_id: "line-1", offer_line_id: "ol-orphan", qty: 1, note: null }])).toThrow(
      /not on this request/,
    );
  });

  it("refuses a selection whose offer line now answers another request line", () => {
    const moved: SelectionInput = { id: "s", request_line_id: "line-2", offer_line_id: "ol-delta-1", qty: 8, note: null };
    expect(() => groupSelectionsForPurchase(cells, [moved])).toThrow(MOVED_SELECTION_ERROR);
    // and never prices the same offer line under two lines
    const twice: SelectionInput[] = [{ id: "s1", request_line_id: "line-1", offer_line_id: "ol-delta-1", qty: 8, note: null }, moved];
    expect(() => groupSelectionsForPurchase(cells, twice)).toThrow(MOVED_SELECTION_ERROR);
  });

  it("refuses a selection on a declined offer", () => {
    const declined: SelectionInput = { id: "s", request_line_id: "line-3", offer_line_id: "ol-dixie-3", qty: 10, note: null };
    expect(() => groupSelectionsForPurchase(cells, [declined])).toThrow(DECLINED_OFFER_ERROR);
    expect(() => groupSelectionsForPurchase(cells, [declined])).toThrow(/Dixie Metals Dallas/);
  });

  it("is empty for no selections", () => {
    expect(groupSelectionsForPurchase(cells, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Conversion data choices
// ---------------------------------------------------------------------------

describe("costInputFor", () => {
  const catalog = catalogById();
  const beam = LINES[0];

  it("uses the request line's item weight when the vendor offers exactly what was asked but the line is unlinked", () => {
    const unlinkedExact = offerLine({ id: "x", offer_id: "o", request_line_id: beam.id, offered_desc: "W12x26", unit_price: 64.5, price_basis: "per_cwt" });
    expect(costInputFor(beam, unlinkedExact, catalog).weight_per_ft).toBe(26);
  });

  it("gives an unlinked alternate no weight, so a weight price cannot be computed", () => {
    const alternate = offerLine({
      id: "x",
      offer_id: "o",
      request_line_id: beam.id,
      offered_desc: "W12x22",
      is_exact_match: false,
      alternate_types: ["dimension"],
      unit_price: 64.5,
      price_basis: "per_cwt",
    });
    const cost = costInputFor(beam, alternate, catalog);
    expect(cost.weight_per_ft).toBeNull();
    expect(cost.length_ft).toBe(50);
  });

  it("prices a length alternate at the length written on the offer, or at none", () => {
    const written = offerLine({
      id: "x",
      offer_id: "o",
      request_line_id: beam.id,
      offered_desc: "W12x26 x 40'",
      offered_catalog_item_id: CATALOG.w12x26.id,
      is_exact_match: false,
      alternate_types: ["length"],
      unit_price: 64.5,
      price_basis: "per_cwt",
    });
    expect(costInputFor(beam, written, catalog).length_ft).toBe(40);
    const unwritten = { ...written, offered_desc: "W12x26 random lengths" };
    expect(costInputFor(beam, unwritten, catalog).length_ft).toBeNull();
  });

  it("falls back to the length on the offer when the request has none", () => {
    const noLength = { ...beam, length_ft: null };
    const written = offerLine({ id: "x", offer_id: "o", request_line_id: beam.id, offered_desc: "W12x26 x 40'", offered_catalog_item_id: CATALOG.w12x26.id });
    expect(costInputFor(noLength, written, catalog).length_ft).toBe(40);
  });

  it("prices in the request unit and does not net quantities across different units", () => {
    const feet = offerLine({
      id: "x",
      offer_id: "o",
      request_line_id: beam.id,
      offered_desc: "W12x26",
      offered_catalog_item_id: CATALOG.w12x26.id,
      available_qty: 800,
      unit: "ft",
      unit_price: 17.1,
      price_basis: "per_ft",
    });
    const cost = costInputFor(beam, feet, catalog);
    expect(cost.unit).toBe("pcs");
    expect(cost.qty_pcs).toBe(8);
    expect(unfilledQty(beam.qty, 800, unitsAgree({ qty: beam.qty, unit: beam.unit }, { qty: 800, unit: "ft" }))).toBeNull();
  });

  it("takes the offer's unit only when the request has no quantity at all", () => {
    const noUnit = { ...beam, unit: null, qty: null };
    const feet = offerLine({ id: "x", offer_id: "o", request_line_id: beam.id, offered_desc: "W12x26", available_qty: 400, unit: "ft", unit_price: 17.1, price_basis: "per_ft" });
    const cost = costInputFor(noUnit, feet, catalog);
    expect(cost.unit).toBe("ft");
    expect(cost.qty_pcs).toBe(400);
    const cell = buildOfferCell(noUnit, feet, OFFERS[2], branchMap(), catalog);
    expect(cell.extended).toEqual({ value: 6840 });
    expect(cell.same_unit).toBe(true);
  });

  it("never relabels a known requested count with the vendor's unit (a request with a quantity and no unit stays unknown)", () => {
    const noUnit = { ...beam, unit: null };
    const feet = offerLine({ id: "x", offer_id: "o", request_line_id: beam.id, offered_desc: "W12x26", available_qty: 400, unit: "ft", unit_price: 17.1, price_basis: "per_ft" });
    const cost = costInputFor(noUnit, feet, catalog);
    expect(cost.unit).toBeNull();
    expect(cost.qty_pcs).toBe(8);
    const cell = buildOfferCell(noUnit, feet, OFFERS[2], branchMap(), catalog);
    expect(cell.extended).toEqual({ reason: "unit unknown not comparable with per_ft" });
    expect(cell.unfilled).toBeNull();
    expect(cell.same_unit).toBe(false);
    expect(cell.incomplete).toBe(true);
    expect(offerCellExtendedForQty(cell, 8)).toEqual({ reason: "unit unknown not comparable with per_ft" });

    const pounds = { ...feet, available_qty: 10000, unit: "lbs" as const, unit_price: 0.645, price_basis: "per_lb" as const };
    expect(buildOfferCell(noUnit, pounds, OFFERS[2], branchMap(), catalog).extended).toEqual({ reason: "unit unknown not comparable with per_lb" });

    const pieces = { ...feet, available_qty: 5, unit: "pcs" as const };
    const pieceCell = buildOfferCell(noUnit, pieces, OFFERS[2], branchMap(), catalog);
    expect(pieceCell.extended).toEqual({ reason: "unit unknown not comparable with per_ft" });
    expect(pieceCell.unfilled).toBeNull();
    expect(pieceCell.cost_input.qty_pcs).toBe(8);

    // per_pc reads a unitless count as pieces (the contract): the requested 8, not the vendor's 5.
    const perPiece = { ...pieces, unit_price: 800, price_basis: "per_pc" as const };
    expect(buildOfferCell(noUnit, perPiece, OFFERS[2], branchMap(), catalog).extended).toEqual({ value: 6400 });
  });

  it("weighs a linked plate alternate at the sheet size written on the offer", () => {
    const plateLine = LINES[2];
    const thicker = offerLine({
      id: "x",
      offer_id: "o",
      request_line_id: plateLine.id,
      offered_desc: "PL1/2 60x120",
      offered_catalog_item_id: CATALOG.pl12.id,
      is_exact_match: false,
      alternate_types: ["dimension"],
      available_qty: 10,
      unit: "pcs",
      unit_price: 58,
      price_basis: "per_cwt",
    });
    expect(costInputFor(plateLine, thicker, catalog).plate).toEqual({ t_in: 0.5, w_in: 60, l_in: 120, weight_per_sqft: 20.4 });
    const cell = buildOfferCell(plateLine, thicker, OFFERS[2], branchMap(), catalog);
    expect(cell.extended).toEqual({ value: 5916 });
    expect(cell.changed).toEqual(["thickness 3/8 to 1/2, size 48x96 to 60x120"]);
  });

  it("weighs a thickness alternate that writes no sheet size at the requested size, and a same-thickness one at none", () => {
    const plateLine = LINES[2];
    const thickerUnsized = offerLine({
      id: "x",
      offer_id: "o",
      request_line_id: plateLine.id,
      offered_desc: "PL1/2",
      offered_catalog_item_id: CATALOG.pl12.id,
      is_exact_match: false,
      alternate_types: ["dimension"],
      unit_price: 0.6,
      price_basis: "per_lb",
    });
    expect(costInputFor(plateLine, thickerUnsized, catalog).plate).toEqual({ t_in: 0.5, w_in: 48, l_in: 96, weight_per_sqft: 20.4 });

    const sameThickness = { ...thickerUnsized, offered_desc: "PL3/8", offered_catalog_item_id: CATALOG.pl38.id };
    expect(costInputFor(plateLine, sameThickness, catalog).plate).toEqual({ t_in: 0.375, w_in: null, l_in: null, weight_per_sqft: 15.3 });
  });

  it("leaves an unlinked plate alternate unknown even when it writes a sheet size (its thickness is not known)", () => {
    const plateLine = LINES[2];
    const unlinked = offerLine({
      id: "x",
      offer_id: "o",
      request_line_id: plateLine.id,
      offered_desc: "PL1/2 60x120",
      is_exact_match: false,
      alternate_types: ["dimension"],
      unit_price: 58,
      price_basis: "per_cwt",
    });
    const cell = buildOfferCell(plateLine, unlinked, OFFERS[2], branchMap(), catalog);
    expect(cell.cost_input.plate).toMatchObject({ w_in: null, l_in: null });
    expect(cell.extended).toEqual({ reason: "no plate dimensions" });
    expect(cell.changed).toEqual(["size 48x96 to 60x120"]);
  });

  it("has no plate dims for a shape that is not plate or sheet", () => {
    expect(costInputFor(beam, OFFER_LINES[0], catalog).plate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Alternates the data shows and the row does not flag (PRD rule 3, code computes)
// ---------------------------------------------------------------------------

describe("isAlternate and effectiveAlternateTypes", () => {
  const catalog = catalogById();
  const beam = LINES[0];
  const plateLine = LINES[2];
  const tube = LINES[3];

  it("keeps a row that is exact in every way exact", () => {
    expect(isAlternate(beam, OFFER_LINES[0], catalog)).toBe(false);
    expect(effectiveAlternateTypes(beam, OFFER_LINES[0], catalog)).toEqual([]);
    // the length written on the offer equals the requested one
    const coastal = OFFER_LINES.find((line) => line.id === "ol-coastal-1")!;
    expect(isAlternate(beam, coastal, catalog)).toBe(false);
    // a plate whose written sheet size is the requested one
    const delta = OFFER_LINES.find((line) => line.id === "ol-delta-3")!;
    expect(isAlternate(plateLine, delta, catalog)).toBe(false);
  });

  it("makes a row marked exact but linked to another catalog item an alternate, naming the difference", () => {
    const lighter = offerLine({
      id: "x",
      offer_id: "offer-coastal",
      request_line_id: beam.id,
      offered_desc: "W12x22",
      offered_catalog_item_id: CATALOG.w12x22.id,
      available_qty: 20,
      unit: "pcs",
      unit_price: 60,
      price_basis: "per_cwt",
    });
    expect(lighter.is_exact_match).toBe(true);
    expect(isAlternate(beam, lighter, catalog)).toBe(true);
    expect(effectiveAlternateTypes(beam, lighter, catalog)).toEqual(["dimension"]);
    expect(changesForOfferLine(beam, lighter, catalog)).toEqual(["weight 26 to 22"]);
    const cell = buildOfferCell(beam, lighter, OFFERS[2], branchMap(), catalog);
    expect(cell.is_exact_match).toBe(false);
    expect(cell.alternate_types).toEqual(["dimension"]);
    expect(cell.changed).toEqual(["weight 26 to 22"]);
    expect(cell.offered_designation).toBe("W12x22");
    expect(cell.cost_input.weight_per_ft).toBe(22);
  });

  it("calls a tube whose only differing dim is the wall a wall alternate", () => {
    const thicker = offerLine({
      id: "x",
      offer_id: "o",
      request_line_id: tube.id,
      offered_desc: "HSS6x6x1/2",
      offered_catalog_item_id: CATALOG.hss12.id,
    });
    expect(effectiveAlternateTypes(tube, thicker, catalog)).toEqual(["wall"]);
    expect(changesForOfferLine(tube, thicker, catalog)).toEqual(["wall 3/8 to 1/2"]);
    const widerToo = { ...thicker, offered_desc: "HSS8x6x3/8", offered_catalog_item_id: CATALOG.hss8x6.id };
    expect(effectiveAlternateTypes(tube, widerToo, catalog)).toEqual(["dimension"]);
    expect(changesForOfferLine(tube, widerToo, catalog)).toEqual(["size 6x6 to 8x6"]);
  });

  it("does not add a second dimension type when the row already names one", () => {
    const flagged = OFFER_LINES.find((line) => line.id === "ol-alamo-4")!;
    expect(effectiveAlternateTypes(tube, flagged, catalog)).toEqual(["wall"]);
    const plateFlagged = OFFER_LINES.find((line) => line.id === "ol-coastal-3")!;
    expect(effectiveAlternateTypes(plateLine, plateFlagged, catalog)).toEqual(["dimension"]);
  });

  it("makes a row whose written length differs from the requested one a length alternate, priced at that length", () => {
    const shorter = offerLine({
      id: "x",
      offer_id: "o",
      request_line_id: beam.id,
      offered_desc: "W12x26 x 40'",
      offered_catalog_item_id: CATALOG.w12x26.id,
      unit_price: 64.5,
      price_basis: "per_cwt",
    });
    expect(effectiveAlternateTypes(beam, shorter, catalog)).toEqual(["length"]);
    expect(changesForOfferLine(beam, shorter, catalog)).toEqual(["length 50' to 40'"]);
    expect(costInputFor(beam, shorter, catalog).length_ft).toBe(40);
    // no requested length: nothing to compare
    expect(effectiveAlternateTypes({ ...beam, length_ft: null }, shorter, catalog)).toEqual([]);
  });

  it("makes a plate whose written sheet size differs from the requested one a dimension alternate at that size", () => {
    const bigger = offerLine({
      id: "x",
      offer_id: "o",
      request_line_id: plateLine.id,
      offered_desc: "PL3/8 60x120",
      offered_catalog_item_id: CATALOG.pl38.id,
      unit_price: 0.62,
      price_basis: "per_lb",
    });
    expect(effectiveAlternateTypes(plateLine, bigger, catalog)).toEqual(["dimension"]);
    expect(changesForOfferLine(plateLine, bigger, catalog)).toEqual(["size 48x96 to 60x120"]);
    expect(costInputFor(plateLine, bigger, catalog).plate).toEqual({ t_in: 0.375, w_in: 60, l_in: 120, weight_per_sqft: 15.3 });
  });

  it("adds nothing when a side is unlinked or the lengths are not both known", () => {
    const unlinked = offerLine({ id: "x", offer_id: "o", request_line_id: beam.id, offered_desc: "W12x22" });
    expect(effectiveAlternateTypes(beam, unlinked, catalog)).toEqual([]);
    expect(isAlternate(beam, unlinked, catalog)).toBe(false);
    const unlinkedLine = { ...beam, catalog_item_id: null };
    const linked = offerLine({ id: "x", offer_id: "o", request_line_id: beam.id, offered_desc: "W12x22", offered_catalog_item_id: CATALOG.w12x22.id });
    expect(effectiveAlternateTypes(unlinkedLine, linked, catalog)).toEqual([]);
  });

  it("is an alternate whenever the row says so, with the row's types first", () => {
    const flagged = offerLine({
      id: "x",
      offer_id: "o",
      request_line_id: beam.id,
      offered_desc: "W12x22 x 40'",
      offered_catalog_item_id: CATALOG.w12x22.id,
      is_exact_match: false,
      alternate_types: ["grade"],
    });
    expect(effectiveAlternateTypes(beam, flagged, catalog)).toEqual(["grade", "dimension", "length"]);
    expect(changesForOfferLine(beam, flagged, catalog)).toEqual(["grade", "weight 26 to 22", "length 50' to 40'"]);
    const bare = offerLine({ id: "x", offer_id: "o", request_line_id: beam.id, offered_desc: "something else", is_exact_match: false });
    expect(isAlternate(beam, bare, catalog)).toBe(true);
    expect(changesForOfferLine(beam, bare, catalog)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Alternates in words
// ---------------------------------------------------------------------------

describe("describeChanges", () => {
  const tube = { dims: { a: 6, b: 6, t: 0.375 }, grade_spec: null, length_ft: 24, category: "hss_square" as const };

  it("wall from dims.t on both sides, else the word alone", () => {
    expect(describeChanges({ alternate_types: ["wall"], requested: tube, offered: { dims: { a: 6, b: 6, t: 0.5 }, length_ft: null } })).toEqual(["wall 3/8 to 1/2"]);
    expect(describeChanges({ alternate_types: ["wall"], requested: tube, offered: { dims: null, length_ft: null } })).toEqual(["wall"]);
    expect(describeChanges({ alternate_types: ["wall"], requested: tube, offered: { dims: { a: 6, b: 6 }, length_ft: null } })).toEqual(["wall"]);
    expect(describeChanges({ alternate_types: ["wall"], requested: { ...tube, dims: {} }, offered: { dims: { t: 0.5 }, length_ft: null } })).toEqual(["wall"]);
  });

  it("dimension lists every dim that differs, with the size pair as one part", () => {
    expect(describeChanges({ alternate_types: ["dimension"], requested: tube, offered: { dims: { a: 8, b: 6, t: 0.375 }, length_ft: null } })).toEqual(["size 6x6 to 8x6"]);
    const beam = { dims: { d: 12, wt: 26 }, grade_spec: null, length_ft: 50, category: "w_beam" as const };
    expect(describeChanges({ alternate_types: ["dimension"], requested: beam, offered: { dims: { d: 10, wt: 22 }, length_ft: null } })).toEqual(["depth 12 to 10, weight 26 to 22"]);
    expect(describeChanges({ alternate_types: ["dimension"], requested: beam, offered: { dims: { d: 12, wt: 22 }, length_ft: null } })).toEqual(["weight 26 to 22"]);
    const bar = { dims: { d: 1 }, grade_spec: null, length_ft: 20, category: "round_bar" as const };
    expect(describeChanges({ alternate_types: ["dimension"], requested: bar, offered: { dims: { d: 1.25 }, length_ft: null } })).toEqual(["diameter 1 to 1-1/4"]);
  });

  it("dimension reports thickness unless wall is also listed, and the word alone when nothing differs", () => {
    const plate = { dims: { t: 0.375, w: 48, l: 96 }, grade_spec: "A36", length_ft: null, category: "plate" as const };
    expect(describeChanges({ alternate_types: ["dimension"], requested: plate, offered: { dims: { t: 0.5 }, length_ft: null } })).toEqual(["thickness 3/8 to 1/2"]);
    expect(describeChanges({ alternate_types: ["wall", "dimension"], requested: tube, offered: { dims: { a: 8, b: 8, t: 0.5 }, length_ft: null } })).toEqual([
      "wall 3/8 to 1/2",
      "size 6x6 to 8x8",
    ]);
    expect(describeChanges({ alternate_types: ["wall", "dimension"], requested: tube, offered: { dims: { a: 6, b: 6, t: 0.5 }, length_ft: null } })).toEqual([
      "wall 3/8 to 1/2",
      "dimension",
    ]);
    expect(describeChanges({ alternate_types: ["dimension"], requested: tube, offered: { dims: null, length_ft: null } })).toEqual(["dimension"]);
  });

  it("grade names the requested grade when there is one", () => {
    expect(describeChanges({ alternate_types: ["grade"], requested: { ...tube, grade_spec: "A500 Gr B" }, offered: { dims: null, length_ft: null } })).toEqual([
      "grade (requested A500 Gr B)",
    ]);
    expect(describeChanges({ alternate_types: ["grade"], requested: tube, offered: { dims: null, length_ft: null } })).toEqual(["grade"]);
  });

  it("length compares the requested and offered lengths in feet", () => {
    expect(describeChanges({ alternate_types: ["length"], requested: { ...tube, length_ft: 40 }, offered: { dims: null, length_ft: 48 } })).toEqual(["length 40' to 48'"]);
    expect(describeChanges({ alternate_types: ["length"], requested: { ...tube, length_ft: 40 }, offered: { dims: null, length_ft: null } })).toEqual(["length (requested 40')"]);
    expect(describeChanges({ alternate_types: ["length"], requested: { ...tube, length_ft: 40 }, offered: { dims: null, length_ft: 40 } })).toEqual(["length (requested 40')"]);
    expect(describeChanges({ alternate_types: ["length"], requested: { ...tube, length_ft: null }, offered: { dims: null, length_ft: 48 } })).toEqual(["length"]);
  });

  it("keeps the order of the alternate types and reads fraction strings", () => {
    const text = describeChanges({
      alternate_types: ["length", "grade", "wall"],
      requested: { dims: { a: "8", b: "8", t: "3/8" }, grade_spec: "A500", length_ft: 40, category: "hss_square" },
      offered: { dims: { a: 8, b: 8, t: 0.5 }, length_ft: 48 },
    });
    expect(text).toEqual(["length 40' to 48'", "grade (requested A500)", "wall 3/8 to 1/2"]);
  });

  it("is empty for an exact match through changesForOfferLine", () => {
    expect(changesForOfferLine(LINES[3], OFFER_LINES[3], catalogById())).toEqual([]);
    expect(changesForOfferLine(LINES[3], OFFER_LINES[6], catalogById())).toEqual(["wall 3/8 to 1/2"]);
  });

  it("fills request dims from the linked item when the parser wrote none", () => {
    const bare = { ...LINES[3], dims: {} };
    expect(changesForOfferLine(bare, OFFER_LINES[6], catalogById())).toEqual(["wall 3/8 to 1/2"]);
  });

  it("dimensionChanges handles string series and schedule dims", () => {
    expect(dimensionChanges({ d: 12, wt: 30, series: "C" }, { d: 12, wt: 31, series: "MC" }, "channel", false)).toEqual(["weight 30 to 31", "series C to MC"]);
  });
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  it("offeredLengthFt reads a trailing length and nothing else", () => {
    expect(offeredLengthFt("W12x26 x 50'")).toBe(50);
    expect(offeredLengthFt("C12x30 40 ft")).toBe(40);
    expect(offeredLengthFt("HSS6x6x3/8 x 24 ft")).toBe(24);
    expect(offeredLengthFt("8x8x1/2")).toBeNull();
    expect(offeredLengthFt("PL3/8 48x96")).toBeNull();
    expect(offeredLengthFt("40'")).toBeNull();
    expect(offeredLengthFt("")).toBeNull();
  });

  it("fillableQty is the smaller known quantity in one unit, else the requested one", () => {
    expect(fillableQty(40, 60, true)).toBe(40);
    expect(fillableQty(40, 25, true)).toBe(25);
    expect(fillableQty(40, null, true)).toBe(40);
    expect(fillableQty(null, 25, true)).toBe(25);
    expect(fillableQty(null, null, true)).toBeNull();
    expect(fillableQty(8, 800, false)).toBe(8);
    expect(fillableQty(null, 800, false)).toBeNull();
  });

  it("unfilledQty is the shortfall, zero when covered, null when unknown", () => {
    expect(unfilledQty(40, 25, true)).toBe(15);
    expect(unfilledQty(40, 60, true)).toBe(0);
    expect(unfilledQty(40, 40, true)).toBe(0);
    expect(unfilledQty(null, 25, true)).toBeNull();
    expect(unfilledQty(40, null, true)).toBeNull();
    expect(unfilledQty(40, 25, false)).toBeNull();
  });

  it("unitsAgree needs both units known and equal, or no quantity beside the missing unit", () => {
    expect(unitsAgree({ qty: 8, unit: "pcs" }, { qty: 10, unit: "pcs" })).toBe(true);
    expect(unitsAgree({ qty: 8, unit: "pcs" }, { qty: 800, unit: "ft" })).toBe(false);
    // the vendor named no quantity: nothing to mix
    expect(unitsAgree({ qty: 8, unit: "pcs" }, { qty: null, unit: null })).toBe(true);
    // the vendor named a count with no unit: not read as pieces
    expect(unitsAgree({ qty: 8, unit: "pcs" }, { qty: 10, unit: null })).toBe(false);
    // the request names no quantity: the vendor's quantity stands on its own
    expect(unitsAgree({ qty: null, unit: null }, { qty: 400, unit: "ft" })).toBe(true);
    // the request has a count and no unit: 8 of something is not 8 feet
    expect(unitsAgree({ qty: 8, unit: null }, { qty: 400, unit: "ft" })).toBe(false);
    expect(unitsAgree({ qty: 8, unit: null }, { qty: 5, unit: "pcs" })).toBe(false);
    expect(unitsAgree({ qty: 8, unit: null }, { qty: null, unit: null })).toBe(false);
    expect(unitsAgree({ qty: null, unit: null }, { qty: null, unit: null })).toBe(true);
  });

  it("offeredSheetSize reads a plate's written sheet size in inches and nothing else", () => {
    expect(offeredSheetSize("PL1/2 60x120")).toEqual({ w_in: 60, l_in: 120 });
    expect(offeredSheetSize("PL3/8 48x96")).toEqual({ w_in: 48, l_in: 96 });
    expect(offeredSheetSize("PL3/8 48x96 A36")).toEqual({ w_in: 48, l_in: 96 });
    expect(offeredSheetSize("1/2 plate 48 x 96")).toEqual({ w_in: 48, l_in: 96 });
    expect(offeredSheetSize('3/8" plate 48" x 96"')).toEqual({ w_in: 48, l_in: 96 });
    expect(offeredSheetSize("PL3/8x48x96")).toEqual({ w_in: 48, l_in: 96 });
    expect(offeredSheetSize("plate 1/2 x 48 x 96")).toEqual({ w_in: 48, l_in: 96 });
    expect(offeredSheetSize("PL1/2 4'x8'")).toEqual({ w_in: 48, l_in: 96 });
    expect(offeredSheetSize("PL1/2 5 ft x 10 ft")).toEqual({ w_in: 60, l_in: 120 });
    expect(offeredSheetSize("PL1/2 60.5x120")).toEqual({ w_in: 60.5, l_in: 120 });
    // never a fraction, never a mixed number
    expect(offeredSheetSize("PL1/2")).toBeNull();
    expect(offeredSheetSize("1-1/2 plate")).toBeNull();
    expect(offeredSheetSize("PL3/8 A36")).toBeNull();
    // a bare small pair is as likely feet as inches
    expect(offeredSheetSize("PL1/2 4x8")).toBeNull();
    expect(offeredSheetSize("")).toBeNull();
  });

  it("selectionBlockedReason blocks a declined offer only", () => {
    expect(selectionBlockedReason("declined")).toBe(DECLINED_OFFER_ERROR);
    expect(selectionBlockedReason("parsed")).toBeNull();
    expect(selectionBlockedReason("reviewed")).toBeNull();
  });

  it("freightKnown is an amount or included", () => {
    expect(freightKnown({ freight_amount: 350, freight_basis: "separate" })).toBe(true);
    expect(freightKnown({ freight_amount: null, freight_basis: "included" })).toBe(true);
    expect(freightKnown({ freight_amount: null, freight_basis: "separate" })).toBe(false);
    expect(freightKnown({ freight_amount: null, freight_basis: "unknown" })).toBe(false);
  });

  it("selectionSummary (PRD rule 5)", () => {
    expect(selectionSummary(20, [])).toEqual({ selected_qty: 0, remaining: 20, over_selected: false });
    expect(selectionSummary(20, [{ qty: 12 }])).toEqual({ selected_qty: 12, remaining: 8, over_selected: false });
    expect(selectionSummary(20, [{ qty: 12 }, { qty: 8 }])).toEqual({ selected_qty: 20, remaining: 0, over_selected: false });
    expect(selectionSummary(20, [{ qty: 12 }, { qty: 10 }])).toEqual({ selected_qty: 22, remaining: 0, over_selected: true });
    expect(selectionSummary(null, [{ qty: 12 }])).toEqual({ selected_qty: 12, remaining: null, over_selected: false });
    expect(selectionSummary(1, [{ qty: 0.1 }, { qty: 0.2 }])).toEqual({ selected_qty: 0.3, remaining: 0.7, over_selected: false });
  });

  it("dimsRecord and numDim read stored dims and fraction strings", () => {
    expect(dimsRecord({ a: 8, t: "3/8", series: "C", junk: null, nested: { x: 1 }, blank: "  " })).toEqual({ a: 8, t: "3/8", series: "C" });
    expect(dimsRecord(null)).toEqual({});
    expect(dimsRecord("x")).toEqual({});
    expect(dimsRecord([1, 2])).toEqual({});
    expect(numDim({ t: "3/8" }, "t")).toBe(0.375);
    expect(numDim({ t: 0.5 }, "t")).toBe(0.5);
    expect(numDim({ series: "C" }, "series")).toBeNull();
    expect(numDim({}, "t")).toBeNull();
  });

  it("exports every sort key the UI offers", () => {
    expect(SORT_KEYS).toEqual(["vendor", "price", "ready_date", "availability"]);
  });

  it("hasValue tells the cells apart", () => {
    const model = buildComparison(input());
    const cells = model.lines.flatMap((entry) => entry.offers);
    expect(cells.filter((cell) => hasValue(cell.extended))).toHaveLength(8);
    expect(cells.filter((cell) => cell.incomplete).map((cell) => cell.offer_line_id)).toEqual(["ol-alamo-1", "ol-alamo-2", "ol-dixie-3", "ol-alamo-4"]);
  });
});

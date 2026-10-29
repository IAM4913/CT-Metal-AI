// The comparison model (PRD section 8, FR-10, PLAN Step 7). Pure: rows in,
// one ComparisonModel out. No I/O, no LLM. src/lib/server/compare.ts loads the
// rows under RLS and calls buildComparison(); the Compare tab renders the
// result and calls sortOffers() for its sort controls.
//
// Per request line (removed lines are left out) the model holds one OfferCell
// per offer line that answers it, with the cost math from ./cost.ts already
// done:
//   extended      extendedCost() for the quantity the vendor can fill
//                 (min(requested, available) when both are known and in the
//                 same unit, the requested quantity when the vendor named none,
//                 the available quantity when the request has none); the
//                 inputs it used are kept in cost_input so a purchase can
//                 recompute the cost for the selected quantity
//                 (offerCellExtendedForQty).
//   per_ft        perFootPrice(), the comparability column (PRD rule 2).
//   early_pay     the scenario row (rule 4): the saving on `extended`.
//   unfilled      requested minus available when the vendor has less, 0 when
//                 enough, null when either side is unknown or the units differ.
//                 Quantities are netted only when both units are known and
//                 equal (unitsAgree); a known quantity in an unknown unit is
//                 never read as the other side's unit.
//   incomplete    the price, the freight, or the extended cost is unknown
//                 (rule 1). Freight is known when the offer states an amount or
//                 says it is included in the price.
//   is_exact_match  false when the row says alternate, and also when the data
//                 shows a difference the row does not flag (isAlternate): the
//                 offered catalog item is not the requested one, the sheet size
//                 written on a plate offer is not the requested one, or the
//                 length written on the offer is not the requested length. The
//                 stored flag alone never makes an offer exact (rule 3, code
//                 computes); alternate_types carries the derived types too.
//   changed       one line of text per alternate type, read from the request
//                 line's dims, grade, and length against the offered catalog
//                 item ("wall 3/8 to 1/2", "depth 12 to 10, weight 26 to 22",
//                 "thickness 3/8 to 1/2, size 48x96 to 60x120", "length 40' to
//                 50'", "grade (requested A36)"); the type name alone when the
//                 values are not known on both sides.
//
// Conversion data is taken from the offered catalog item when the offer line is
// linked, else from the request line's item when the vendor offers exactly what
// was asked, else it is unknown: an unlinked alternate has no weight, so a
// per-cwt price on it reads "cannot compute: no weight per foot" rather than
// borrowing the requested section's weight. A length alternate takes the length
// written in the offered description or none; every other offer is priced at
// the requested length (the vendor was asked for that length). A linked plate
// offer that writes a sheet size ("PL1/2 60x120") is weighed at that size
// (offeredSheetSize); without one, a thickness alternate is weighed at the
// requested size and a same-thickness "dimension" alternate has no size at all.
//
// The quantity priced is in the request line's unit. When the request has a
// quantity but no unit, the unit stays unknown (cost.ts then prices per_pc as
// pieces and refuses every other basis) rather than taking the vendor's unit;
// the vendor's unit is adopted only when the request names no quantity at all.
//
// Selection is per request line (rule 5): selectionSummary() gives selected,
// remaining, and the over-selection warning; groupSelectionsForPurchase() turns
// the selections into one group per branch with totals that are null when any
// part is unknown, for confirmPurchase.
//
// The default order is vendor name then branch name (rule 6). Nothing here
// sorts by price unless asked.

import { formatFraction, parseFraction } from "@/lib/catalog/normalize";
import type {
  AlternateType,
  Availability,
  FreightBasis,
  LineUnit,
  MaterialCategory,
  OfferStatus,
  PriceBasis,
} from "@/lib/db/enums";
import type { Json, Tables } from "@/lib/db/types";
import { parseLengthFt } from "@/lib/parsing/length";
import { stripTrailingLength } from "@/lib/parsing/offers-normalize";
import { compareText } from "@/lib/routing/match";
import {
  earlyPaySavings,
  extendedCost,
  hasValue,
  perFootPrice,
  round4,
  type CostInput,
  type CostResult,
  type PlateDims,
} from "./cost";

// ---------------------------------------------------------------------------
// Inputs (the database rows, or the parts of them this module reads)
// ---------------------------------------------------------------------------

export type Dims = Record<string, number | string>;

export type RequestLineInput = Pick<
  Tables<"request_lines">,
  | "id"
  | "line_no"
  | "raw_text"
  | "description"
  | "catalog_item_id"
  | "category"
  | "dims"
  | "grade_spec"
  | "qty"
  | "unit"
  | "length_ft"
  | "length_text"
  | "status"
>;

export type OfferInput = Pick<
  Tables<"vendor_offers">,
  | "id"
  | "rfq_id"
  | "branch_id"
  | "message_id"
  | "attachment_id"
  | "status"
  | "received_at"
  | "quote_expires_at"
  | "payment_terms"
  | "early_pay_pct"
  | "early_pay_days"
  | "freight_amount"
  | "freight_basis"
  | "notes"
>;

export type OfferLineInput = Pick<
  Tables<"offer_lines">,
  | "id"
  | "offer_id"
  | "request_line_id"
  | "offered_catalog_item_id"
  | "offered_desc"
  | "is_exact_match"
  | "alternate_types"
  | "available_qty"
  | "unit"
  | "availability"
  | "ready_date"
  | "delivery_estimate_text"
  | "unit_price"
  | "price_basis"
  | "flags"
  | "confidence"
>;

export type RfqInput = Pick<Tables<"rfqs">, "id" | "branch_id" | "status" | "sent_at">;

export type BranchInput = { id: string; name: string; vendor_name: string };

export type SelectionInput = Pick<Tables<"sourcing_selections">, "id" | "request_line_id" | "offer_line_id" | "qty" | "note">;

export type CatalogItemInput = {
  designation: string;
  category: MaterialCategory;
  dims: Json;
  weight_per_ft: number | null;
};

export type BuildInput = {
  lines: RequestLineInput[];
  offers: OfferInput[];
  offerLines: OfferLineInput[];
  rfqs: RfqInput[];
  branches: BranchInput[];
  selections: SelectionInput[];
  catalogById: Map<string, CatalogItemInput>;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type OfferCell = {
  offer_line_id: string;
  /** The request line this offer line answers; a selection must sit under the same line to be bought. */
  request_line_id: string;
  offer_id: string;
  rfq_id: string;
  branch_id: string;
  vendor_name: string;
  branch_name: string;
  /** vendor_offers.status: a declined offer's lines stay visible but are marked. */
  offer_status: OfferStatus;
  offered_desc: string;
  offered_designation: string | null;
  is_exact_match: boolean;
  alternate_types: AlternateType[];
  /** Human text per alternate type, in alternate_types order (describeChanges). */
  changed: string[];
  available_qty: number | null;
  unit: LineUnit | null;
  /** Whether the available quantity is in the request's unit (unitsAgree); false when either unit is unknown beside a quantity. */
  same_unit: boolean;
  /** Requested minus available when the vendor has less, 0 when enough, null when unknown or the units differ. */
  unfilled: number | null;
  availability: Availability;
  ready_date: string | null;
  delivery_estimate_text: string | null;
  unit_price: number | null;
  price_basis: PriceBasis | null;
  /** Extended material cost for cost_input.qty_pcs, or the reason it cannot be computed. */
  extended: CostResult;
  per_ft: CostResult;
  /** What `extended` was computed from; qty_pcs is the quantity it priced. */
  cost_input: CostInput;
  freight_amount: number | null;
  freight_basis: FreightBasis;
  payment_terms: string | null;
  early_pay: { pct: number | null; days: number | null; savings: CostResult };
  quote_expires_at: string | null;
  /** True when the price, the freight, or the extended cost is unknown (PRD rule 1). */
  incomplete: boolean;
  source: { message_id: string | null; attachment_id: string | null };
  flags: string[];
  confidence: number;
};

export type LineSelection = { selection_id: string; offer_line_id: string; qty: number; note: string | null };

export type LineComparison = {
  line: {
    id: string;
    line_no: number;
    designation: string | null;
    description: string;
    raw_text: string;
    qty: number | null;
    unit: LineUnit | null;
    length_ft: number | null;
    length_text: string | null;
    grade_spec: string | null;
    category: MaterialCategory | null;
    dims: Dims;
  };
  /** In the default order: vendor name, then branch name. */
  offers: OfferCell[];
  selections: LineSelection[];
  selected_qty: number;
  remaining: number | null;
  over_selected: boolean;
};

export type ComparisonModel = {
  lines: LineComparison[];
  declined: Array<{ rfq_id: string; vendor_name: string; branch_name: string; reason: string | null }>;
  awaiting: Array<{ rfq_id: string; vendor_name: string; branch_name: string; sent_at: string | null }>;
};

export type SortKey = "vendor" | "price" | "ready_date" | "availability";

export const SORT_KEYS: readonly SortKey[] = ["vendor", "price", "ready_date", "availability"];

export type PurchaseGroup = {
  branch_id: string;
  vendor_name: string;
  branch_name: string;
  selection_ids: string[];
  /** The distinct offers the selections came from, for freight. */
  offer_ids: string[];
  /** Sum of the extended cost of every selection at its selected quantity; null when any is unknown. */
  total_material: number | null;
  /** Sum of the stated freight per distinct offer (included counts as 0); null when any offer's freight is unknown. */
  total_freight: number | null;
  /** Why a total is null, one entry per unknown part. */
  unknowns: string[];
};

const UNKNOWN_VENDOR = "Unknown vendor";
const UNKNOWN_BRANCH = "Unknown branch";

export const DECLINED_OFFER_ERROR = "This vendor declined the RFQ. Undo the decline on the Offers tab to select from it.";
export const MOVED_SELECTION_ERROR = "A selection points at an offer line that now answers another request line. Remove it and select again.";
export const ORPHAN_SELECTION_ERROR = "A selection points at an offer line that is not on this request. Remove it and select again.";

const TUBULAR: ReadonlySet<MaterialCategory> = new Set<MaterialCategory>(["hss_square", "hss_rectangular", "hss_round", "pipe"]);
const PLATE_LIKE: ReadonlySet<MaterialCategory> = new Set<MaterialCategory>(["plate", "sheet"]);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** request_lines.dims or catalog_items.dims as a flat record; anything that is not an object is {}. */
export function dimsRecord(value: Json | null | undefined): Dims {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Dims = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
    else if (typeof entry === "string" && entry.trim() !== "") out[key] = entry.trim();
  }
  return out;
}

/** A numeric dim, reading a fraction string ("3/8") through parseFraction. */
export function numDim(dims: Dims, key: string): number | null {
  const value = dims[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return parseFraction(value);
  return null;
}

/** The length a vendor wrote onto the end of an offered item ("W12x26 x 50'" is 50), or null. */
export function offeredLengthFt(offeredDesc: string): number | null {
  const trimmed = offeredDesc.trim();
  const stripped = stripTrailingLength(trimmed);
  if (stripped === trimmed) return null;
  return parseLengthFt(trimmed.slice(stripped.length));
}

// Sheet size written on a plate or sheet offer: two whole or decimal numbers
// joined by x, neither part of a fraction or a mixed number, each optionally
// marked as inches or feet. Feet are converted; a bare pair with a side under
// 12 ("4x8") is as likely feet as inches and is left unknown.
const SHEET_SIZE = /(?<![\d./-])(\d+(?:\.\d+)?)\s*(['’]|ft\b|"|”|in\b)?\s*[x×]\s*(\d+(?:\.\d+)?)(?![\d./-])\s*(['’]|ft\b|"|”|in\b)?/i;

function sheetSide(text: string, mark: string | undefined): number | null {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  const feet = mark !== undefined && (mark === "'" || mark === "’" || mark.toLowerCase() === "ft");
  return feet ? value * 12 : value;
}

/**
 * The sheet size written on a plate or sheet offer, in inches: "PL1/2 60x120"
 * is 60 by 120, "1/2 plate 4'x8'" is 48 by 96, "PL1/2" has none. Only
 * meaningful for plate and sheet (a beam's "W12x26" also has two numbers).
 */
export function offeredSheetSize(offeredDesc: string): { w_in: number; l_in: number } | null {
  const match = SHEET_SIZE.exec(offeredDesc);
  if (!match) return null;
  const [, wText, wMark, lText, lMark] = match;
  const w_in = sheetSide(wText, wMark);
  const l_in = sheetSide(lText, lMark);
  if (w_in === null || l_in === null) return null;
  const bare = wMark === undefined && lMark === undefined;
  if (bare && (w_in < 12 || l_in < 12)) return null;
  return { w_in, l_in };
}

export type QtyWithUnit = { qty: number | null; unit: LineUnit | null };

/**
 * Whether the requested and available quantities can be netted against each
 * other: both units are known and equal, or the side with no unit has no
 * quantity either (there is nothing to mix). A known quantity in an unknown
 * unit never agrees with anything: 8 of something is not 8 feet.
 */
export function unitsAgree(request: QtyWithUnit, offer: QtyWithUnit): boolean {
  if (request.unit !== null && offer.unit !== null) return request.unit === offer.unit;
  if (request.unit === null && request.qty !== null) return false;
  if (offer.unit === null && offer.qty !== null) return false;
  return true;
}

/**
 * The quantity an offer is priced for: the smaller of requested and available
 * when both are known in one unit, else the requested quantity, else the
 * available one, else null.
 */
export function fillableQty(requested: number | null, available: number | null, sameUnit: boolean): number | null {
  if (available !== null && sameUnit) {
    return requested !== null ? Math.min(requested, available) : available;
  }
  return requested;
}

/** Requested minus available when the vendor has less, 0 when enough, null when either is unknown or the units differ. */
export function unfilledQty(requested: number | null, available: number | null, sameUnit: boolean): number | null {
  if (requested === null || available === null || !sameUnit) return null;
  return round4(Math.max(requested - available, 0));
}

/** Freight is known when an amount is stated or the offer says it is included in the price. */
export function freightKnown(offer: Pick<OfferInput, "freight_amount" | "freight_basis">): boolean {
  return offer.freight_amount !== null || offer.freight_basis === "included";
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function feet(value: number): string {
  return `${formatFraction(value)}'`;
}

// ---------------------------------------------------------------------------
// Alternates: what changed, in words
// ---------------------------------------------------------------------------

export type ChangeSource = {
  alternate_types: AlternateType[];
  requested: { dims: Dims; grade_spec: string | null; length_ft: number | null; category: MaterialCategory | null };
  /** The offered catalog item's dims when the offer line is linked, else null. */
  offered: { dims: Dims | null; length_ft: number | null };
};

// Dims keys that can differ, with the word a broker uses for each. Thickness
// is reported under "dimension" only when "wall" is not also listed, so one
// change is not written twice. a and b are reported together as the size.
const DIM_LABELS: ReadonlyArray<{ key: string; label: (category: MaterialCategory | null) => string }> = [
  { key: "d", label: (c) => (c === "round_bar" || c === "rebar" || c === "hss_round" ? "diameter" : "depth") },
  { key: "wt", label: () => "weight" },
  { key: "od", label: () => "OD" },
  { key: "nominal", label: () => "size" },
  { key: "nps", label: () => "size" },
  { key: "w", label: () => "width" },
  { key: "l", label: () => "length" },
  { key: "gauge", label: () => "gauge" },
  { key: "bar_number", label: () => "bar" },
  { key: "series", label: () => "series" },
  { key: "schedule", label: () => "schedule" },
  { key: "t", label: () => "thickness" },
];

function dimText(dims: Dims, key: string): string | null {
  const value = dims[key];
  if (typeof value === "number") return formatFraction(value);
  if (typeof value === "string") {
    const parsed = parseFraction(value);
    return parsed === null ? value : formatFraction(parsed);
  }
  return null;
}

function sizeText(dims: Dims): string | null {
  const a = dimText(dims, "a");
  if (a === null) return null;
  const b = dimText(dims, "b");
  return b === null ? a : `${a}x${b}`;
}

/** A plate's sheet size "48x96" from dims.w and dims.l, when both are present. */
function sheetText(dims: Dims): string | null {
  const w = dimText(dims, "w");
  const l = dimText(dims, "l");
  return w === null || l === null ? null : `${w}x${l}`;
}

/**
 * The dims that differ between the request and the offered item, as "label
 * from to to" parts: the a/b size pair first, then each labelled dim, then the
 * sheet size when both sides have a width and a length ("size 48x96 to
 * 60x120"; width and length are then not reported one by one).
 */
export function dimensionChanges(requested: Dims, offered: Dims, category: MaterialCategory | null, skipThickness: boolean): string[] {
  const parts: string[] = [];
  const requestedSize = sizeText(requested);
  const offeredSize = sizeText(offered);
  if (requestedSize !== null && offeredSize !== null && requestedSize !== offeredSize) {
    parts.push(`size ${requestedSize} to ${offeredSize}`);
  }
  const requestedSheet = sheetText(requested);
  const offeredSheet = sheetText(offered);
  const sheetPair = requestedSheet !== null && offeredSheet !== null;
  for (const { key, label } of DIM_LABELS) {
    if (key === "t" && skipThickness) continue;
    if (sheetPair && (key === "w" || key === "l")) continue;
    const from = dimText(requested, key);
    const to = dimText(offered, key);
    if (from === null || to === null || from === to) continue;
    parts.push(`${label(category)} ${from} to ${to}`);
  }
  if (sheetPair && requestedSheet !== offeredSheet) {
    parts.push(`size ${requestedSheet} to ${offeredSheet}`);
  }
  return parts;
}

/**
 * One line of text per alternate type, in the order given:
 *   wall       "wall 3/8 to 1/2" from dims.t on both sides, else "wall"
 *   dimension  the differing dims ("depth 12 to 10, weight 26 to 22",
 *              "size 8x8 to 8x6", "thickness 3/8 to 1/2"), else "dimension"
 *   grade      "grade (requested A36)" when the request names one, else "grade"
 *   length     "length 40' to 50'" when both are known, "length (requested 40')"
 *              when only the request's is, else "length"
 */
export function describeChanges(source: ChangeSource): string[] {
  const { requested, offered } = source;
  const skipThickness = source.alternate_types.includes("wall");
  return source.alternate_types.map((type) => {
    switch (type) {
      case "wall": {
        const from = dimText(requested.dims, "t");
        const to = offered.dims === null ? null : dimText(offered.dims, "t");
        return from !== null && to !== null && from !== to ? `wall ${from} to ${to}` : "wall";
      }
      case "dimension": {
        if (offered.dims === null) return "dimension";
        const parts = dimensionChanges(requested.dims, offered.dims, requested.category, skipThickness);
        return parts.length === 0 ? "dimension" : parts.join(", ");
      }
      case "grade":
        return requested.grade_spec === null ? "grade" : `grade (requested ${requested.grade_spec})`;
      case "length": {
        if (requested.length_ft === null) return "length";
        if (offered.length_ft === null || offered.length_ft === requested.length_ft) return `length (requested ${feet(requested.length_ft)})`;
        return `length ${feet(requested.length_ft)} to ${feet(offered.length_ft)}`;
      }
    }
  });
}

type AlternateLine = Pick<RequestLineInput, "dims" | "grade_spec" | "length_ft" | "category" | "catalog_item_id">;
type AlternateOfferLine = Pick<OfferLineInput, "alternate_types" | "offered_catalog_item_id" | "offered_desc" | "is_exact_match">;

/** The two sides of an alternate comparison, read once for the functions below. */
function alternateSides(line: AlternateLine, offerLine: AlternateOfferLine, catalogById: ReadonlyMap<string, CatalogItemInput>) {
  const lineItem = line.catalog_item_id ? (catalogById.get(line.catalog_item_id) ?? null) : null;
  const offeredItem = offerLine.offered_catalog_item_id ? (catalogById.get(offerLine.offered_catalog_item_id) ?? null) : null;
  const category = lineItem?.category ?? line.category;
  // The request's own dims first, the linked item filling in what the parser did not write.
  const requestedDims: Dims = { ...(lineItem ? dimsRecord(lineItem.dims) : {}), ...dimsRecord(line.dims) };
  // The offered item's dims, plus the sheet size written on a plate offer (catalog plate items carry the thickness only).
  const sheet = category !== null && PLATE_LIKE.has(category) ? offeredSheetSize(offerLine.offered_desc) : null;
  const sheetDims: Dims = sheet ? { w: sheet.w_in, l: sheet.l_in } : {};
  const offeredDims: Dims | null = offeredItem ? { ...dimsRecord(offeredItem.dims), ...sheetDims } : sheet ? sheetDims : null;
  return { lineItem, offeredItem, category, requestedDims, offeredDims, sheet, writtenLength: offeredLengthFt(offerLine.offered_desc) };
}

/**
 * The alternate types an offer line carries plus the ones the data shows and
 * the row does not flag (code computes, PRD section 8 rule 3):
 *   - "dimension" when the offered catalog item is not the request line's item
 *     ("wall" instead when the only differing dim is the wall of a tube or
 *     pipe), unless the row already names a dimension or wall change;
 *   - "dimension" when the sheet size written on a plate offer is not the
 *     requested one;
 *   - "length" when the length written on the offer is not the requested one.
 * Each comparison needs both sides known; an unlinked offer or a missing
 * length adds nothing.
 */
export function effectiveAlternateTypes(line: AlternateLine, offerLine: AlternateOfferLine, catalogById: ReadonlyMap<string, CatalogItemInput>): AlternateType[] {
  const types: AlternateType[] = [...offerLine.alternate_types];
  const add = (type: AlternateType) => {
    if (!types.includes(type)) types.push(type);
  };
  const sides = alternateSides(line, offerLine, catalogById);

  const bothLinked = line.catalog_item_id !== null && offerLine.offered_catalog_item_id !== null;
  if (bothLinked && line.catalog_item_id !== offerLine.offered_catalog_item_id && !types.includes("dimension") && !types.includes("wall")) {
    const parts = dimensionChanges(sides.requestedDims, sides.offeredDims ?? {}, sides.category, false);
    const wallOnly = parts.length === 1 && parts[0].startsWith("thickness ") && sides.category !== null && TUBULAR.has(sides.category);
    add(wallOnly ? "wall" : "dimension");
  }

  if (sides.sheet !== null) {
    const requestedW = numDim(sides.requestedDims, "w");
    const requestedL = numDim(sides.requestedDims, "l");
    if (requestedW !== null && requestedL !== null && (sides.sheet.w_in !== requestedW || sides.sheet.l_in !== requestedL)) add("dimension");
  }

  if (sides.writtenLength !== null && line.length_ft !== null && sides.writtenLength !== line.length_ft) add("length");

  return types;
}

/** Whether an offer line is an alternate: the row says so, or the data shows a difference (effectiveAlternateTypes). */
export function isAlternate(line: AlternateLine, offerLine: AlternateOfferLine, catalogById: ReadonlyMap<string, CatalogItemInput>): boolean {
  return !offerLine.is_exact_match || effectiveAlternateTypes(line, offerLine, catalogById).length > 0;
}

/** The changed text for one offer line against its request line, from the catalog items it and the line link to; empty for an exact match. */
export function changesForOfferLine(line: AlternateLine, offerLine: AlternateOfferLine, catalogById: ReadonlyMap<string, CatalogItemInput>): string[] {
  const types = effectiveAlternateTypes(line, offerLine, catalogById);
  if (offerLine.is_exact_match && types.length === 0) return [];
  const sides = alternateSides(line, offerLine, catalogById);
  return describeChanges({
    alternate_types: types,
    requested: { dims: sides.requestedDims, grade_spec: line.grade_spec, length_ft: line.length_ft, category: sides.category },
    offered: { dims: sides.offeredDims, length_ft: sides.writtenLength },
  });
}

// ---------------------------------------------------------------------------
// Cost inputs for one offer line
// ---------------------------------------------------------------------------

/**
 * The conversion data for pricing one offer line: the offered item's weight
 * (or the requested item's when the vendor offers exactly what was asked), the
 * length (the offered one for a length alternate, else the requested one, else
 * the one written on the offer), and the plate dims for plate and sheet.
 */
export function costInputFor(
  line: Pick<RequestLineInput, "dims" | "qty" | "unit" | "length_ft" | "category" | "catalog_item_id" | "grade_spec">,
  offerLine: Pick<
    OfferLineInput,
    "alternate_types" | "offered_catalog_item_id" | "offered_desc" | "is_exact_match" | "available_qty" | "unit" | "unit_price" | "price_basis"
  >,
  catalogById: ReadonlyMap<string, CatalogItemInput>,
): CostInput {
  const lineItem = line.catalog_item_id ? (catalogById.get(line.catalog_item_id) ?? null) : null;
  const offeredItem = offerLine.offered_catalog_item_id ? (catalogById.get(offerLine.offered_catalog_item_id) ?? null) : null;
  const item = offeredItem ?? (offerLine.is_exact_match ? lineItem : null);
  const category = item?.category ?? line.category;
  const lineDims = dimsRecord(line.dims);
  const itemDims = item ? dimsRecord(item.dims) : {};
  const types = effectiveAlternateTypes(line, offerLine, catalogById);

  const writtenLength = offeredLengthFt(offerLine.offered_desc);
  const length_ft = types.includes("length") ? writtenLength : (line.length_ft ?? writtenLength);

  const sameUnit = unitsAgree({ qty: line.qty, unit: line.unit }, { qty: offerLine.available_qty, unit: offerLine.unit });
  // The vendor's unit stands in only when the request names no quantity at all.
  const unit = line.unit ?? (line.qty === null ? offerLine.unit : null);
  const qty_pcs = fillableQty(line.qty, offerLine.available_qty, sameUnit);

  let plate: PlateDims | null = null;
  if (category !== null && PLATE_LIKE.has(category)) {
    const requestedT = numDim(lineDims, "t") ?? (lineItem ? numDim(dimsRecord(lineItem.dims), "t") : null);
    const t_in = numDim(itemDims, "t") ?? requestedT;
    // The sheet size the vendor wrote counts only on a linked offer (its
    // thickness is then known too); an unlinked plate alternate stays unknown.
    const written = offeredItem ? offeredSheetSize(offerLine.offered_desc) : null;
    // A "dimension" alternate on plate that keeps the thickness and writes no
    // sheet size must be a different sheet size the offer does not state:
    // width and length are then unknown rather than the requested ones.
    const sheetSizeUnknown = written === null && types.includes("dimension") && (requestedT === null || t_in === requestedT);
    plate = {
      t_in,
      w_in: written ? written.w_in : sheetSizeUnknown ? null : numDim(lineDims, "w"),
      l_in: written ? written.l_in : sheetSizeUnknown ? null : numDim(lineDims, "l"),
      weight_per_sqft: numDim(itemDims, "weight_per_sqft"),
    };
  }

  return {
    price_basis: offerLine.price_basis,
    unit_price: offerLine.unit_price,
    qty_pcs,
    unit,
    length_ft,
    weight_per_ft: item?.weight_per_ft ?? null,
    plate,
  };
}

/** The extended cost of a cell's offer at another quantity (the selected one), in the request line's unit. */
export function offerCellExtendedForQty(cell: Pick<OfferCell, "cost_input">, qty: number): CostResult {
  return extendedCost({ ...cell.cost_input, qty_pcs: qty });
}

// ---------------------------------------------------------------------------
// Selections
// ---------------------------------------------------------------------------

/** Selected total against the requested quantity (PRD rule 5); remaining is null when the request has no quantity. */
export function selectionSummary(
  requestedQty: number | null,
  selections: ReadonlyArray<{ qty: number }>,
): { selected_qty: number; remaining: number | null; over_selected: boolean } {
  let selected = 0;
  for (const selection of selections) {
    if (Number.isFinite(selection.qty)) selected += selection.qty;
  }
  const selected_qty = round4(selected);
  if (requestedQty === null || !Number.isFinite(requestedQty)) {
    return { selected_qty, remaining: null, over_selected: false };
  }
  return {
    selected_qty,
    remaining: round4(Math.max(requestedQty - selected_qty, 0)),
    over_selected: selected_qty > requestedQty,
  };
}

/** Why an offer line cannot be selected or bought, from its offer's status, or null when it can. */
export function selectionBlockedReason(offerStatus: OfferStatus): string | null {
  return offerStatus === "declined" ? DECLINED_OFFER_ERROR : null;
}

/**
 * One purchase per branch from the selections (AC-11.1). Every selection must
 * point at a cell of the model under the same request line, on an offer the
 * vendor did not decline; otherwise the purchase cannot be priced or
 * attributed and this throws. Totals are null, with the reasons in `unknowns`,
 * whenever any part is unknown (rule 1).
 */
export function groupSelectionsForPurchase(cells: ReadonlyArray<OfferCell>, selections: ReadonlyArray<SelectionInput>): PurchaseGroup[] {
  const cellByOfferLine = new Map(cells.map((cell) => [cell.offer_line_id, cell]));
  const groups = new Map<string, PurchaseGroup & { material: number; freight: number; materialKnown: boolean; freightKnown: boolean }>();

  for (const selection of selections) {
    const cell = cellByOfferLine.get(selection.offer_line_id);
    if (!cell) {
      throw new Error(ORPHAN_SELECTION_ERROR);
    }
    if (cell.request_line_id !== selection.request_line_id) {
      throw new Error(MOVED_SELECTION_ERROR);
    }
    const blocked = selectionBlockedReason(cell.offer_status);
    if (blocked !== null) {
      throw new Error(`${cell.vendor_name} ${cell.branch_name}: ${blocked}`);
    }
    let group = groups.get(cell.branch_id);
    if (!group) {
      group = {
        branch_id: cell.branch_id,
        vendor_name: cell.vendor_name,
        branch_name: cell.branch_name,
        selection_ids: [],
        offer_ids: [],
        total_material: null,
        total_freight: null,
        unknowns: [],
        material: 0,
        freight: 0,
        materialKnown: true,
        freightKnown: true,
      };
      groups.set(cell.branch_id, group);
    }
    group.selection_ids.push(selection.id);

    const extended = offerCellExtendedForQty(cell, selection.qty);
    if (hasValue(extended)) {
      group.material += extended.value;
    } else {
      group.materialKnown = false;
      group.unknowns.push(`material for ${cell.offered_desc}: ${extended.reason}`);
    }

    if (!group.offer_ids.includes(cell.offer_id)) {
      group.offer_ids.push(cell.offer_id);
      if (cell.freight_amount !== null) {
        group.freight += cell.freight_amount;
      } else if (cell.freight_basis !== "included") {
        group.freightKnown = false;
        group.unknowns.push(`freight from ${cell.vendor_name} ${cell.branch_name}: unknown`);
      }
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => compareText(a.vendor_name, b.vendor_name) || compareText(a.branch_name, b.branch_name) || compareText(a.branch_id, b.branch_id))
    .map(({ material, freight, materialKnown, freightKnown: freightIsKnown, ...group }) => ({
      ...group,
      total_material: materialKnown ? round4(material) : null,
      total_freight: freightIsKnown ? round4(freight) : null,
    }));
}

// ---------------------------------------------------------------------------
// Sorting (PRD rule 6)
// ---------------------------------------------------------------------------

const AVAILABILITY_RANK: Record<Availability, number> = { stock: 0, rolling: 1, unknown: 2 };

function compareVendor(a: OfferCell, b: OfferCell): number {
  return compareText(a.vendor_name, b.vendor_name) || compareText(a.branch_name, b.branch_name);
}

function compareNullableAsc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compareDates(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function priceGroup(cell: OfferCell): number {
  if (hasValue(cell.per_ft)) return 0;
  if (hasValue(cell.extended)) return 1;
  return 2;
}

function valueOrNull(result: CostResult): number | null {
  return hasValue(result) ? result.value : null;
}

function compareCells(a: OfferCell, b: OfferCell, key: SortKey): number {
  switch (key) {
    case "vendor":
      return compareVendor(a, b);
    case "price":
      return (
        priceGroup(a) - priceGroup(b) ||
        compareNullableAsc(valueOrNull(a.per_ft), valueOrNull(b.per_ft)) ||
        compareNullableAsc(valueOrNull(a.extended), valueOrNull(b.extended)) ||
        compareVendor(a, b)
      );
    case "ready_date":
      return compareDates(a.ready_date, b.ready_date) || compareVendor(a, b);
    case "availability":
      return AVAILABILITY_RANK[a.availability] - AVAILABILITY_RANK[b.availability] || compareDates(a.ready_date, b.ready_date) || compareVendor(a, b);
  }
}

/**
 * A sorted copy. vendor: vendor then branch name. price: per-foot price when
 * known, then cells with only an extended cost by that cost, then the rest
 * (unknown last), ties by vendor. ready_date: soonest first, none last.
 * availability: stock, rolling, unknown, then ready date, then vendor. Stable:
 * equal cells keep their order.
 */
export function sortOffers(cells: ReadonlyArray<OfferCell>, key: SortKey): OfferCell[] {
  return cells
    .map((cell, index) => ({ cell, index }))
    .sort((a, b) => compareCells(a.cell, b.cell, key) || a.index - b.index)
    .map(({ cell }) => cell);
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

function branchNames(branches: ReadonlyMap<string, BranchInput>, branchId: string): { vendor_name: string; branch_name: string } {
  const branch = branches.get(branchId);
  return { vendor_name: branch?.vendor_name ?? UNKNOWN_VENDOR, branch_name: branch?.name ?? UNKNOWN_BRANCH };
}

/** One OfferCell from an offer line, its offer, and the request line it answers. */
export function buildOfferCell(
  line: RequestLineInput,
  offerLine: OfferLineInput,
  offer: OfferInput,
  branches: ReadonlyMap<string, BranchInput>,
  catalogById: ReadonlyMap<string, CatalogItemInput>,
): OfferCell {
  const cost_input = costInputFor(line, offerLine, catalogById);
  const extended = extendedCost(cost_input);
  const per_ft = perFootPrice({
    price_basis: cost_input.price_basis,
    unit_price: cost_input.unit_price,
    weight_per_ft: cost_input.weight_per_ft,
    length_ft: cost_input.length_ft,
  });
  const offeredItem = offerLine.offered_catalog_item_id ? (catalogById.get(offerLine.offered_catalog_item_id) ?? null) : null;
  const sameUnit = unitsAgree({ qty: line.qty, unit: line.unit }, { qty: offerLine.available_qty, unit: offerLine.unit });
  const alternateTypes = effectiveAlternateTypes(line, offerLine, catalogById);
  const alternate = !offerLine.is_exact_match || alternateTypes.length > 0;

  return {
    offer_line_id: offerLine.id,
    request_line_id: offerLine.request_line_id,
    offer_id: offer.id,
    rfq_id: offer.rfq_id,
    branch_id: offer.branch_id,
    ...branchNames(branches, offer.branch_id),
    offer_status: offer.status,
    offered_desc: offerLine.offered_desc,
    offered_designation: offeredItem?.designation ?? null,
    is_exact_match: !alternate,
    alternate_types: alternateTypes,
    changed: changesForOfferLine(line, offerLine, catalogById),
    available_qty: offerLine.available_qty,
    unit: offerLine.unit,
    same_unit: sameUnit,
    unfilled: unfilledQty(line.qty, offerLine.available_qty, sameUnit),
    availability: offerLine.availability,
    ready_date: offerLine.ready_date,
    delivery_estimate_text: offerLine.delivery_estimate_text,
    unit_price: offerLine.unit_price,
    price_basis: offerLine.price_basis,
    extended,
    per_ft,
    cost_input,
    freight_amount: offer.freight_amount,
    freight_basis: offer.freight_basis,
    payment_terms: offer.payment_terms,
    early_pay: {
      pct: offer.early_pay_pct,
      days: offer.early_pay_days,
      savings: earlyPaySavings(extended, offer.early_pay_pct),
    },
    quote_expires_at: offer.quote_expires_at,
    incomplete: offerLine.unit_price === null || !freightKnown(offer) || !hasValue(extended),
    source: { message_id: offer.message_id, attachment_id: offer.attachment_id },
    flags: [...offerLine.flags],
    confidence: offerLine.confidence,
  };
}

/**
 * The whole comparison for one request: a block per live request line with its
 * offers in vendor order, its selections and their summary; the declined
 * offers; and the RFQs still out. Unknown values stay unknown throughout.
 */
export function buildComparison(input: BuildInput): ComparisonModel {
  const branches = new Map(input.branches.map((branch) => [branch.id, branch]));
  const offerById = new Map(input.offers.map((offer) => [offer.id, offer]));

  const lines = input.lines
    .filter((line) => line.status !== "removed")
    .sort((a, b) => a.line_no - b.line_no || compareText(a.id, b.id))
    .map((line): LineComparison => {
      const cells: OfferCell[] = [];
      for (const offerLine of input.offerLines) {
        if (offerLine.request_line_id !== line.id) continue;
        const offer = offerById.get(offerLine.offer_id);
        if (!offer) continue;
        cells.push(buildOfferCell(line, offerLine, offer, branches, input.catalogById));
      }
      const selections: LineSelection[] = input.selections
        .filter((selection) => selection.request_line_id === line.id)
        .map((selection) => ({
          selection_id: selection.id,
          offer_line_id: selection.offer_line_id,
          qty: selection.qty,
          note: selection.note,
        }));
      const lineItem = line.catalog_item_id ? (input.catalogById.get(line.catalog_item_id) ?? null) : null;
      return {
        line: {
          id: line.id,
          line_no: line.line_no,
          designation: lineItem?.designation ?? null,
          description: line.description,
          raw_text: line.raw_text,
          qty: line.qty,
          unit: line.unit,
          length_ft: line.length_ft,
          length_text: line.length_text,
          grade_spec: line.grade_spec,
          category: lineItem?.category ?? line.category,
          dims: dimsRecord(line.dims),
        },
        offers: sortOffers(cells, "vendor"),
        selections,
        ...selectionSummary(line.qty, selections),
      };
    });

  const declined = input.offers
    .filter((offer) => offer.status === "declined")
    .map((offer) => ({ rfq_id: offer.rfq_id, ...branchNames(branches, offer.branch_id), reason: clean(offer.notes) }))
    .sort((a, b) => compareText(a.vendor_name, b.vendor_name) || compareText(a.branch_name, b.branch_name));

  const awaiting = input.rfqs
    .filter((rfq) => rfq.status === "sent")
    .map((rfq) => ({ rfq_id: rfq.id, ...branchNames(branches, rfq.branch_id), sent_at: rfq.sent_at }))
    .sort((a, b) => compareText(a.vendor_name, b.vendor_name) || compareText(a.branch_name, b.branch_name));

  return { lines, declined, awaiting };
}

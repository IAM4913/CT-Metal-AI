// Extended material cost (PRD section 8, PLAN Step 7). Pure functions, no I/O.
//
// Every formula here is the one PRD section 8 writes down, and every answer is
// either { value } or { reason }: a missing price, basis, quantity, length,
// weight, or plate dimension yields a reason, never a zero (AC-10.3, AC-10.4).
//
//   per_ft    unit_price * length_ft * qty_pcs
//   per_pc    unit_price * qty_pcs
//   per_cwt   unit_price * (weight_per_ft * length_ft * qty_pcs) / 100
//   per_lb    unit_price * weight_per_ft * length_ft * qty_pcs
//   per_ton   unit_price * (weight_per_ft * length_ft * qty_pcs) / 2000
//   per_sqft  unit_price * (w_in * l_in / 144) * qty_pcs            (plate)
//   plate per_cwt, per_lb, per_ton: the piece weight is
//             weight_per_sqft * (w_in * l_in / 144), with weight_per_sqft the
//             catalog value when the item carries one, else 40.8 * t_in (the
//             same rule as plateWeightPerSqft in src/lib/catalog/generate.ts).
//
// The quantity's unit decides whether the formula applies. "pcs" (or a null
// unit when the basis is per_pc) is a piece count and takes the full formula.
// A quantity already in the priced unit (ft with per_ft, lbs with per_lb, cwt
// with per_cwt, tons with per_ton, sqft with per_sqft) is unit_price * qty.
// Any other pairing is "unit <u> not comparable with <basis>" (PRD rule 2:
// normalize only when conversion data exists; in and the cross-weight pairs
// have none here).
//
// perFootPrice() is the comparability column: per-cwt, per-lb, and per-ton
// need weight_per_ft, per-pc needs the length, per-sqft has no per-foot form.
// earlyPaySavings() is the scenario row (rule 4): the saving on an extended
// cost, never a discount applied to the base price.

import type { LineUnit, PriceBasis } from "@/lib/db/enums";

export type CostResult = { value: number } | { reason: string };

export type PlateDims = {
  /** Thickness in inches. */
  t_in: number | null;
  /** Width in inches. */
  w_in: number | null;
  /** Length in inches. */
  l_in: number | null;
  /**
   * Pounds per square foot when the catalog states it (plate items carry
   * 40.8 * t rounded, sheet items carry the gauge table). Omitted or null means
   * 40.8 * t_in.
   */
  weight_per_sqft?: number | null;
};

export type CostInput = {
  price_basis: PriceBasis | null;
  unit_price: number | null;
  /** The quantity the cost is for, in `unit`. */
  qty_pcs: number | null;
  /** The unit of qty_pcs; null is read as pieces only when the basis is per_pc. */
  unit: LineUnit | null;
  length_ft: number | null;
  weight_per_ft: number | null;
  /** Set for plate and sheet; null for every other shape. */
  plate: PlateDims | null;
};

export type PerFootInput = {
  price_basis: PriceBasis | null;
  unit_price: number | null;
  weight_per_ft: number | null;
  length_ft: number | null;
};

/** Pounds per square foot of steel plate per inch of thickness (plateWeightPerSqft in generate.ts). */
export const PLATE_LB_PER_SQFT_PER_INCH = 40.8;

export const REASON_NO_PRICE = "no price";
export const REASON_NO_BASIS = "no price basis";
export const REASON_NO_QTY = "no quantity";
export const REASON_NO_LENGTH = "no length";
export const REASON_NO_WEIGHT = "no weight per foot";
export const REASON_NO_PLATE_DIMS = "no plate dimensions";
export const REASON_NO_EARLY_PAY = "no early-pay terms";
export const REASON_SQFT_PER_FOOT = "per_sqft not comparable per foot";

export function hasValue(result: CostResult): result is { value: number } {
  return "value" in result;
}

export function hasReason(result: CostResult): result is { reason: string } {
  return "reason" in result;
}

/** The reason a quantity in this unit cannot be priced on this basis. */
export function unitMixReason(unit: LineUnit | null, basis: PriceBasis): string {
  return `unit ${unit ?? "unknown"} not comparable with ${basis}`;
}

/** Round to cents. The 15-digit pass drops binary noise first so 1.005 rounds up, not down. */
export function roundCents(value: number): number {
  return Math.round(Number((value * 100).toPrecision(15))) / 100;
}

/** Round to four decimals, for per-foot prices that are quoted below the cent (a mill's $0.4325/lb). */
export function round4(value: number): number {
  return Math.round(Number((value * 10000).toPrecision(15))) / 10000;
}

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The unit whose quantity is already what the basis prices, or null for per_pc (pieces). */
function nativeUnit(basis: PriceBasis): LineUnit | null {
  switch (basis) {
    case "per_ft":
      return "ft";
    case "per_lb":
      return "lbs";
    case "per_cwt":
      return "cwt";
    case "per_ton":
      return "tons";
    case "per_sqft":
      return "sqft";
    case "per_pc":
      return null;
  }
}

/**
 * Pounds of one plate or sheet piece from its dimensions, or a reason. The
 * catalog's weight_per_sqft wins when present; otherwise 40.8 lb per square
 * foot per inch of thickness.
 */
export function plateWeightLb(plate: PlateDims | null): CostResult {
  if (plate === null || !positive(plate.w_in) || !positive(plate.l_in)) return { reason: REASON_NO_PLATE_DIMS };
  const area = (plate.w_in * plate.l_in) / 144;
  if (positive(plate.weight_per_sqft)) return { value: plate.weight_per_sqft * area };
  if (!positive(plate.t_in)) return { reason: REASON_NO_PLATE_DIMS };
  return { value: PLATE_LB_PER_SQFT_PER_INCH * plate.t_in * area };
}

/**
 * Extended material cost per PRD section 8 for `qty_pcs` in `unit`, rounded
 * to cents. Reasons, in the order they are checked: "no price", "no price
 * basis", "no quantity", then per basis "no length", "no weight per foot",
 * "no plate dimensions", or "unit <u> not comparable with <basis>".
 */
export function extendedCost(input: CostInput): CostResult {
  const { price_basis: basis, unit_price: price, qty_pcs: qty, unit } = input;
  if (!positive(price)) return { reason: REASON_NO_PRICE };
  if (basis === null) return { reason: REASON_NO_BASIS };
  if (!positive(qty)) return { reason: REASON_NO_QTY };

  // The quantity is already in the priced unit: nothing to convert.
  if (unit !== null && unit === nativeUnit(basis)) return { value: roundCents(price * qty) };

  const pieces = unit === "pcs" || (unit === null && basis === "per_pc");
  if (!pieces) return { reason: unitMixReason(unit, basis) };

  switch (basis) {
    case "per_pc":
      return { value: roundCents(price * qty) };
    case "per_ft": {
      if (!positive(input.length_ft)) return { reason: REASON_NO_LENGTH };
      return { value: roundCents(price * input.length_ft * qty) };
    }
    case "per_sqft": {
      const plate = input.plate;
      if (plate === null || !positive(plate.w_in) || !positive(plate.l_in)) return { reason: REASON_NO_PLATE_DIMS };
      return { value: roundCents(price * ((plate.w_in * plate.l_in) / 144) * qty) };
    }
    case "per_cwt":
    case "per_lb":
    case "per_ton": {
      const pounds = totalPounds(input, qty);
      if (hasReason(pounds)) return pounds;
      const divisor = basis === "per_cwt" ? 100 : basis === "per_ton" ? 2000 : 1;
      return { value: roundCents((price * pounds.value) / divisor) };
    }
  }
}

/** Total pounds of `qty` pieces: plate dims when the item is plate, else weight_per_ft * length_ft. */
function totalPounds(input: CostInput, qty: number): CostResult {
  if (input.plate !== null) {
    const piece = plateWeightLb(input.plate);
    return hasReason(piece) ? piece : { value: piece.value * qty };
  }
  if (!positive(input.weight_per_ft)) return { reason: REASON_NO_WEIGHT };
  if (!positive(input.length_ft)) return { reason: REASON_NO_LENGTH };
  return { value: input.weight_per_ft * input.length_ft * qty };
}

/**
 * The conditional early-pay saving on an extended cost (PRD rule 4), rounded
 * to cents. "no early-pay terms" when the offer states no percentage; the
 * extended cost's own reason when that could not be computed.
 */
export function earlyPaySavings(extended: CostResult, pct: number | null): CostResult {
  if (!positive(pct)) return { reason: REASON_NO_EARLY_PAY };
  if (hasReason(extended)) return extended;
  return { value: roundCents((extended.value * pct) / 100) };
}

/**
 * The price per foot a quote amounts to, for the comparability column, to four
 * decimals. per_ft as quoted; per_cwt, per_lb, and per_ton through
 * weight_per_ft ("no weight per foot" without it); per_pc through the length
 * ("no length" without it); per_sqft has no per-foot form.
 */
export function perFootPrice(input: PerFootInput): CostResult {
  const { price_basis: basis, unit_price: price } = input;
  if (!positive(price)) return { reason: REASON_NO_PRICE };
  if (basis === null) return { reason: REASON_NO_BASIS };
  switch (basis) {
    case "per_ft":
      return { value: round4(price) };
    case "per_cwt":
    case "per_lb":
    case "per_ton": {
      if (!positive(input.weight_per_ft)) return { reason: REASON_NO_WEIGHT };
      const divisor = basis === "per_cwt" ? 100 : basis === "per_ton" ? 2000 : 1;
      return { value: round4((price * input.weight_per_ft) / divisor) };
    }
    case "per_pc": {
      if (!positive(input.length_ft)) return { reason: REASON_NO_LENGTH };
      return { value: round4(price / input.length_ft) };
    }
    case "per_sqft":
      return { reason: REASON_SQFT_PER_FOOT };
  }
}

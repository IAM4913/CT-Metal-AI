import { describe, expect, it } from "vitest";
import { plateWeightPerSqft } from "@/lib/catalog/generate";
import { lineUnitValues, priceBasisValues, type LineUnit, type PriceBasis } from "@/lib/db/enums";
import {
  earlyPaySavings,
  extendedCost,
  hasReason,
  hasValue,
  perFootPrice,
  PLATE_LB_PER_SQFT_PER_INCH,
  plateWeightLb,
  REASON_NO_BASIS,
  REASON_NO_EARLY_PAY,
  REASON_NO_LENGTH,
  REASON_NO_PLATE_DIMS,
  REASON_NO_PRICE,
  REASON_NO_QTY,
  REASON_NO_WEIGHT,
  REASON_SQFT_PER_FOOT,
  round4,
  roundCents,
  unitMixReason,
  type CostInput,
} from "./cost";

const EM_DASH = String.fromCharCode(0x2014);

/** 20 pcs of HSS8x8x3/8 (37.69 lb/ft) at 40', a piece count with every conversion input known. */
function tube(overrides: Partial<CostInput> = {}): CostInput {
  return {
    price_basis: "per_cwt",
    unit_price: 64.5,
    qty_pcs: 20,
    unit: "pcs",
    length_ft: 40,
    weight_per_ft: 37.69,
    plate: null,
    ...overrides,
  };
}

/** 10 pcs of 3/8 plate 48x96 (the mixed-list fixture line). */
function plate(overrides: Partial<CostInput> = {}): CostInput {
  return {
    price_basis: "per_lb",
    unit_price: 0.62,
    qty_pcs: 10,
    unit: "pcs",
    length_ft: null,
    weight_per_ft: null,
    plate: { t_in: 0.375, w_in: 48, l_in: 96 },
    ...overrides,
  };
}

describe("type guards", () => {
  it("tell a value from a reason", () => {
    expect(hasValue({ value: 1 })).toBe(true);
    expect(hasValue({ reason: "no price" })).toBe(false);
    expect(hasReason({ reason: "no price" })).toBe(true);
    expect(hasReason({ value: 0 })).toBe(false);
  });
});

describe("rounding", () => {
  it("rounds to cents, with the half-cent binary noise case rounding up", () => {
    expect(roundCents(1.005)).toBe(1.01);
    expect(roundCents(2.675)).toBe(2.68);
    expect(roundCents(19.6)).toBe(19.6);
    expect(roundCents(0.98 * 20)).toBe(19.6);
    expect(roundCents(6708)).toBe(6708);
    expect(roundCents(11164.032)).toBe(11164.03);
    expect(roundCents(11164.035)).toBe(11164.04);
  });

  it("rounds per-foot prices to four decimals", () => {
    expect(round4(412 / 24)).toBe(17.1667);
    expect(round4(0.98)).toBe(0.98);
    expect(round4(66 * 35.24 / 100)).toBe(23.2584);
  });
});

describe("extendedCost: the PRD section 8 formulas", () => {
  it("per_ft: unit_price * length_ft * qty_pcs", () => {
    expect(extendedCost(tube({ price_basis: "per_ft", unit_price: 0.98, qty_pcs: 40, length_ft: 20 }))).toEqual({ value: 784 });
  });

  it("per_pc: unit_price * qty_pcs, needing neither length nor weight", () => {
    expect(extendedCost(tube({ price_basis: "per_pc", unit_price: 412, length_ft: null, weight_per_ft: null }))).toEqual({ value: 8240 });
  });

  it("per_cwt: unit_price * (weight_per_ft * length_ft * qty_pcs) / 100", () => {
    // 37.69 * 40 * 20 = 30152 lb = 301.52 cwt; * 64.50 = 19448.04
    expect(extendedCost(tube())).toEqual({ value: 19448.04 });
    // W12x26 x 50' x 8 at $64.50/cwt: 26 * 50 * 8 = 10400 lb
    expect(extendedCost(tube({ weight_per_ft: 26, length_ft: 50, qty_pcs: 8 }))).toEqual({ value: 6708 });
  });

  it("per_lb: unit_price * weight_per_ft * length_ft * qty_pcs", () => {
    expect(extendedCost(tube({ price_basis: "per_lb", unit_price: 0.645 }))).toEqual({ value: 19448.04 });
  });

  it("per_ton: unit_price * (weight_per_ft * length_ft * qty_pcs) / 2000", () => {
    // 30152 lb = 15.076 tons; * 1290 = 19448.04
    expect(extendedCost(tube({ price_basis: "per_ton", unit_price: 1290 }))).toEqual({ value: 19448.04 });
  });

  it("rounds the value to cents", () => {
    // 66 * (35.24 * 24 * 20) / 100 = 11164.032
    expect(extendedCost(tube({ unit_price: 66, weight_per_ft: 35.24, length_ft: 24 }))).toEqual({ value: 11164.03 });
    expect(extendedCost(tube({ price_basis: "per_ft", unit_price: 1.005, qty_pcs: 1, length_ft: 1 }))).toEqual({ value: 1.01 });
  });
});

describe("extendedCost: missing inputs are reasons, never zero", () => {
  it("no price", () => {
    expect(extendedCost(tube({ unit_price: null }))).toEqual({ reason: REASON_NO_PRICE });
    expect(extendedCost(tube({ unit_price: 0 }))).toEqual({ reason: REASON_NO_PRICE });
    expect(extendedCost(tube({ unit_price: -5 }))).toEqual({ reason: REASON_NO_PRICE });
    expect(extendedCost(tube({ unit_price: Number.NaN }))).toEqual({ reason: REASON_NO_PRICE });
  });

  it("no price basis, checked after the price", () => {
    expect(extendedCost(tube({ price_basis: null }))).toEqual({ reason: REASON_NO_BASIS });
    expect(extendedCost(tube({ price_basis: null, unit_price: null }))).toEqual({ reason: REASON_NO_PRICE });
  });

  it("no quantity, checked after price and basis", () => {
    expect(extendedCost(tube({ qty_pcs: null }))).toEqual({ reason: REASON_NO_QTY });
    expect(extendedCost(tube({ qty_pcs: 0 }))).toEqual({ reason: REASON_NO_QTY });
    expect(extendedCost(tube({ qty_pcs: -1 }))).toEqual({ reason: REASON_NO_QTY });
    expect(extendedCost(tube({ qty_pcs: null, price_basis: null }))).toEqual({ reason: REASON_NO_BASIS });
  });

  it("per_ft needs the length", () => {
    expect(extendedCost(tube({ price_basis: "per_ft", length_ft: null }))).toEqual({ reason: REASON_NO_LENGTH });
    expect(extendedCost(tube({ price_basis: "per_ft", length_ft: 0 }))).toEqual({ reason: REASON_NO_LENGTH });
  });

  it("per_cwt, per_lb, and per_ton need the weight per foot and then the length", () => {
    for (const basis of ["per_cwt", "per_lb", "per_ton"] as const) {
      expect(extendedCost(tube({ price_basis: basis, weight_per_ft: null })), basis).toEqual({ reason: REASON_NO_WEIGHT });
      expect(extendedCost(tube({ price_basis: basis, weight_per_ft: 0 })), basis).toEqual({ reason: REASON_NO_WEIGHT });
      expect(extendedCost(tube({ price_basis: basis, length_ft: null })), basis).toEqual({ reason: REASON_NO_LENGTH });
      expect(extendedCost(tube({ price_basis: basis, weight_per_ft: null, length_ft: null })), basis).toEqual({ reason: REASON_NO_WEIGHT });
    }
  });

  it("never returns a zero value for a missing input", () => {
    const missing: Array<Partial<CostInput>> = [
      { unit_price: null },
      { price_basis: null },
      { qty_pcs: null },
      { length_ft: null },
      { weight_per_ft: null },
      { price_basis: "per_sqft", plate: null },
    ];
    for (const patch of missing) {
      const result = extendedCost(tube(patch));
      expect(hasReason(result), JSON.stringify(patch)).toBe(true);
    }
  });
});

describe("extendedCost: plate", () => {
  it("per_sqft: unit_price * (w_in * l_in / 144) * qty_pcs, needing width and length only", () => {
    // 48 x 96 = 32 sqft per sheet; 10 sheets at $9.50/sqft
    expect(extendedCost(plate({ price_basis: "per_sqft", unit_price: 9.5 }))).toEqual({ value: 3040 });
    expect(extendedCost(plate({ price_basis: "per_sqft", unit_price: 9.5, plate: { t_in: null, w_in: 48, l_in: 96 } }))).toEqual({ value: 3040 });
  });

  it("per_sqft without plate dimensions is a reason", () => {
    expect(extendedCost(plate({ price_basis: "per_sqft", plate: null }))).toEqual({ reason: REASON_NO_PLATE_DIMS });
    expect(extendedCost(plate({ price_basis: "per_sqft", plate: { t_in: 0.375, w_in: null, l_in: 96 } }))).toEqual({ reason: REASON_NO_PLATE_DIMS });
    expect(extendedCost(plate({ price_basis: "per_sqft", plate: { t_in: 0.375, w_in: 48, l_in: null } }))).toEqual({ reason: REASON_NO_PLATE_DIMS });
    expect(extendedCost(plate({ price_basis: "per_sqft", plate: { t_in: 0.375, w_in: 0, l_in: 96 } }))).toEqual({ reason: REASON_NO_PLATE_DIMS });
  });

  it("per_lb, per_cwt, and per_ton weigh the plate as 40.8 * t * (w * l / 144) per piece", () => {
    // 40.8 * 0.375 = 15.3 lb/sqft; * 32 sqft = 489.6 lb per sheet; * 10 = 4896 lb
    expect(extendedCost(plate())).toEqual({ value: 3035.52 });
    expect(extendedCost(plate({ price_basis: "per_cwt", unit_price: 62 }))).toEqual({ value: 3035.52 });
    expect(extendedCost(plate({ price_basis: "per_ton", unit_price: 1240 }))).toEqual({ value: 3035.52 });
  });

  it("uses the catalog weight_per_sqft when the plate carries one (sheet gauges are not 40.8 * t)", () => {
    // 16 ga: t 0.0598 but 2.5 lb/sqft by the gauge table; 32 sqft * 2.5 = 80 lb per sheet; 4 sheets = 320 lb
    const sheet = plate({ unit_price: 1, qty_pcs: 4, plate: { t_in: 0.0598, w_in: 48, l_in: 96, weight_per_sqft: 2.5 } });
    expect(extendedCost(sheet)).toEqual({ value: 320 });
    expect(plateWeightLb({ t_in: 0.0598, w_in: 48, l_in: 96, weight_per_sqft: 2.5 })).toEqual({ value: 80 });
    expect(plateWeightLb({ t_in: 0.0598, w_in: 48, l_in: 96, weight_per_sqft: null })).toEqual({ value: 40.8 * 0.0598 * 32 });
  });

  it("weight bases need thickness, width, and length (or a stated weight per sqft)", () => {
    for (const basis of ["per_cwt", "per_lb", "per_ton"] as const) {
      expect(extendedCost(plate({ price_basis: basis, plate: { t_in: null, w_in: 48, l_in: 96 } })), basis).toEqual({ reason: REASON_NO_PLATE_DIMS });
      expect(extendedCost(plate({ price_basis: basis, plate: { t_in: 0.375, w_in: null, l_in: 96 } })), basis).toEqual({ reason: REASON_NO_PLATE_DIMS });
      expect(extendedCost(plate({ price_basis: basis, plate: { t_in: 0.375, w_in: 48, l_in: null } })), basis).toEqual({ reason: REASON_NO_PLATE_DIMS });
      expect(extendedCost(plate({ price_basis: basis, plate: { t_in: null, w_in: 48, l_in: 96, weight_per_sqft: 15.3 } })), basis).toEqual(
        extendedCost(plate({ price_basis: basis })),
      );
    }
    expect(plateWeightLb(null)).toEqual({ reason: REASON_NO_PLATE_DIMS });
    const sheet = plateWeightLb({ t_in: 0.375, w_in: 48, l_in: 96 });
    expect(hasValue(sheet) && Math.abs(sheet.value - 489.6) < 1e-9).toBe(true);
  });

  it("per_pc and per_ft on plate follow the general rules", () => {
    expect(extendedCost(plate({ price_basis: "per_pc", unit_price: 303.55 }))).toEqual({ value: 3035.5 });
    expect(extendedCost(plate({ price_basis: "per_ft", unit_price: 40 }))).toEqual({ reason: REASON_NO_LENGTH });
    expect(extendedCost(plate({ price_basis: "per_ft", unit_price: 40, length_ft: 8 }))).toEqual({ value: 3200 });
  });

  it("agrees with the catalog's plate weight rule", () => {
    for (const t of [0.1875, 0.25, 0.375, 0.5, 1, 2]) {
      expect(PLATE_LB_PER_SQFT_PER_INCH * t).toBeCloseTo(plateWeightPerSqft(t), 10);
    }
  });
});

describe("extendedCost: quantity units", () => {
  it("treats a null unit as pieces only when the basis is per_pc", () => {
    expect(extendedCost(tube({ price_basis: "per_pc", unit_price: 412, unit: null }))).toEqual({ value: 8240 });
    expect(extendedCost(tube({ unit: null }))).toEqual({ reason: unitMixReason(null, "per_cwt") });
    expect(extendedCost(tube({ price_basis: "per_ft", unit: null }))).toEqual({ reason: "unit unknown not comparable with per_ft" });
  });

  it("prices a quantity already in the basis unit as unit_price * qty", () => {
    expect(extendedCost(tube({ price_basis: "per_ft", unit_price: 0.98, unit: "ft", qty_pcs: 800, length_ft: null }))).toEqual({ value: 784 });
    expect(extendedCost(tube({ price_basis: "per_lb", unit_price: 0.62, unit: "lbs", qty_pcs: 4896, weight_per_ft: null, length_ft: null }))).toEqual({
      value: 3035.52,
    });
    expect(extendedCost(tube({ price_basis: "per_cwt", unit: "cwt", qty_pcs: 301.52, weight_per_ft: null, length_ft: null }))).toEqual({ value: 19448.04 });
    expect(extendedCost(tube({ price_basis: "per_ton", unit_price: 1290, unit: "tons", qty_pcs: 15.076, weight_per_ft: null }))).toEqual({ value: 19448.04 });
    expect(extendedCost(tube({ price_basis: "per_sqft", unit_price: 9.5, unit: "sqft", qty_pcs: 320 }))).toEqual({ value: 3040 });
  });

  it("names the unit and basis of any other pairing", () => {
    expect(extendedCost(tube({ price_basis: "per_ft", unit: "lbs" }))).toEqual({ reason: "unit lbs not comparable with per_ft" });
    expect(extendedCost(tube({ price_basis: "per_lb", unit: "ft" }))).toEqual({ reason: "unit ft not comparable with per_lb" });
    expect(extendedCost(tube({ price_basis: "per_pc", unit: "ft" }))).toEqual({ reason: "unit ft not comparable with per_pc" });
    expect(extendedCost(tube({ price_basis: "per_ft", unit: "in" }))).toEqual({ reason: "unit in not comparable with per_ft" });
    expect(extendedCost(tube({ price_basis: "per_cwt", unit: "tons" }))).toEqual({ reason: "unit tons not comparable with per_cwt" });
  });

  it("decides every unit and basis the database knows without throwing", () => {
    for (const unit of [...lineUnitValues, null] as Array<LineUnit | null>) {
      for (const basis of priceBasisValues as readonly PriceBasis[]) {
        const result = extendedCost(tube({ unit, price_basis: basis, plate: { t_in: 0.375, w_in: 48, l_in: 96 } }));
        expect(hasValue(result) || hasReason(result), `${unit} ${basis}`).toBe(true);
        if (hasValue(result)) expect(result.value).toBeGreaterThan(0);
        if (hasReason(result)) expect(result.reason).not.toContain(EM_DASH);
      }
    }
  });
});

describe("earlyPaySavings", () => {
  it("is a scenario on the extended cost, rounded to cents", () => {
    expect(earlyPaySavings({ value: 6708 }, 1)).toEqual({ value: 67.08 });
    expect(earlyPaySavings({ value: 3035.52 }, 1)).toEqual({ value: 30.36 });
    expect(earlyPaySavings({ value: 784 }, 2.5)).toEqual({ value: 19.6 });
  });

  it("has no answer without a percentage", () => {
    expect(earlyPaySavings({ value: 6708 }, null)).toEqual({ reason: REASON_NO_EARLY_PAY });
    expect(earlyPaySavings({ value: 6708 }, 0)).toEqual({ reason: REASON_NO_EARLY_PAY });
    expect(earlyPaySavings({ reason: REASON_NO_PRICE }, null)).toEqual({ reason: REASON_NO_EARLY_PAY });
  });

  it("carries the extended cost's reason when that is unknown", () => {
    expect(earlyPaySavings({ reason: REASON_NO_PRICE }, 1)).toEqual({ reason: REASON_NO_PRICE });
    expect(earlyPaySavings({ reason: REASON_NO_WEIGHT }, 1)).toEqual({ reason: REASON_NO_WEIGHT });
  });
});

describe("perFootPrice (PRD rule 2)", () => {
  const base = { price_basis: "per_cwt" as PriceBasis, unit_price: 64.5, weight_per_ft: 26, length_ft: 50 };

  it("per_ft is the quoted price", () => {
    expect(perFootPrice({ ...base, price_basis: "per_ft", unit_price: 17.1 })).toEqual({ value: 17.1 });
    expect(perFootPrice({ ...base, price_basis: "per_ft", unit_price: 0.98, weight_per_ft: null, length_ft: null })).toEqual({ value: 0.98 });
  });

  it("per_cwt and per_lb to per_ft require weight_per_ft", () => {
    expect(perFootPrice(base)).toEqual({ value: 16.77 });
    expect(perFootPrice({ ...base, price_basis: "per_lb", unit_price: 0.645 })).toEqual({ value: 16.77 });
    expect(perFootPrice({ ...base, weight_per_ft: null })).toEqual({ reason: REASON_NO_WEIGHT });
    expect(perFootPrice({ ...base, price_basis: "per_lb", weight_per_ft: null })).toEqual({ reason: REASON_NO_WEIGHT });
    expect(perFootPrice({ ...base, weight_per_ft: 0 })).toEqual({ reason: REASON_NO_WEIGHT });
  });

  it("per_ton to per_ft requires weight_per_ft", () => {
    expect(perFootPrice({ ...base, price_basis: "per_ton", unit_price: 1290 })).toEqual({ value: 16.77 });
    expect(perFootPrice({ ...base, price_basis: "per_ton", weight_per_ft: null })).toEqual({ reason: REASON_NO_WEIGHT });
  });

  it("per_pc to per_ft requires the length", () => {
    expect(perFootPrice({ ...base, price_basis: "per_pc", unit_price: 412, length_ft: 24 })).toEqual({ value: 17.1667 });
    expect(perFootPrice({ ...base, price_basis: "per_pc", unit_price: 412, length_ft: null })).toEqual({ reason: REASON_NO_LENGTH });
    expect(perFootPrice({ ...base, price_basis: "per_pc", unit_price: 412, length_ft: 0 })).toEqual({ reason: REASON_NO_LENGTH });
  });

  it("per_sqft has no per-foot form", () => {
    expect(perFootPrice({ ...base, price_basis: "per_sqft", unit_price: 9.5 })).toEqual({ reason: REASON_SQFT_PER_FOOT });
  });

  it("needs a price and a basis first", () => {
    expect(perFootPrice({ ...base, unit_price: null })).toEqual({ reason: REASON_NO_PRICE });
    expect(perFootPrice({ ...base, unit_price: 0 })).toEqual({ reason: REASON_NO_PRICE });
    expect(perFootPrice({ ...base, price_basis: null })).toEqual({ reason: REASON_NO_BASIS });
    expect(perFootPrice({ ...base, price_basis: null, unit_price: null })).toEqual({ reason: REASON_NO_PRICE });
  });

  it("rounds to four decimals, never to a cent that hides a mill price", () => {
    expect(perFootPrice({ ...base, price_basis: "per_lb", unit_price: 0.4325, weight_per_ft: 1 })).toEqual({ value: 0.4325 });
    expect(perFootPrice({ ...base, unit_price: 66, weight_per_ft: 35.24 })).toEqual({ value: 23.2584 });
  });
});

describe("reason text", () => {
  it("writes no em dash", () => {
    for (const reason of [
      REASON_NO_PRICE,
      REASON_NO_BASIS,
      REASON_NO_QTY,
      REASON_NO_LENGTH,
      REASON_NO_WEIGHT,
      REASON_NO_PLATE_DIMS,
      REASON_NO_EARLY_PAY,
      REASON_SQFT_PER_FOOT,
      unitMixReason("ft", "per_lb"),
    ]) {
      expect(reason).not.toContain(EM_DASH);
    }
  });
});

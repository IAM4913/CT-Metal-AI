import { describe, expect, it } from "vitest";
import {
  aliasCarriesSize,
  aliasToLearn,
  canConfirm,
  mergeLineValues,
  recomputeFlags,
  type ConfirmableLine,
  type MergeSource,
} from "./review";

const ITEM = "33333333-3333-4333-8333-333333333333";

function line(overrides: Partial<ConfirmableLine> = {}): ConfirmableLine {
  return { line_no: 1, qty: 8, unit: "pcs", catalog_item_id: ITEM, status: "parsed", ...overrides };
}

describe("canConfirm (AC-3.3)", () => {
  it("passes when every line has qty, unit, and a catalog link", () => {
    expect(canConfirm([line(), line({ line_no: 2, status: "confirmed" })])).toEqual({ ok: true, problems: [] });
  });

  it("accepts a custom line without a catalog link", () => {
    expect(canConfirm([line({ catalog_item_id: null, status: "custom" })]).ok).toBe(true);
  });

  it("rejects a missing quantity, naming the line", () => {
    const result = canConfirm([line(), line({ line_no: 2, qty: null })]);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["Line 2 needs a quantity."]);
  });

  it("rejects a missing unit", () => {
    expect(canConfirm([line({ unit: null })]).problems).toEqual(["Line 1 needs a unit."]);
  });

  it("rejects an unlinked line that is not marked custom", () => {
    expect(canConfirm([line({ catalog_item_id: null })]).problems).toEqual([
      "Line 1 needs a catalog link or the custom item status.",
    ]);
  });

  it("lists every missing piece of one line in one sentence", () => {
    expect(canConfirm([line({ line_no: 3, qty: null, unit: null, catalog_item_id: null })]).problems).toEqual([
      "Line 3 needs a quantity, a unit and a catalog link or the custom item status.",
    ]);
  });

  it("reports every incomplete line", () => {
    const result = canConfirm([line({ qty: null }), line({ line_no: 2 }), line({ line_no: 3, unit: null })]);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toMatch(/^Line 1/);
    expect(result.problems[1]).toMatch(/^Line 3/);
  });

  it("ignores removed lines", () => {
    expect(canConfirm([line(), line({ line_no: 2, qty: null, unit: null, catalog_item_id: null, status: "removed" })]).ok).toBe(
      true,
    );
  });

  it("does not let a request with no live lines through", () => {
    expect(canConfirm([])).toEqual({ ok: false, problems: ["There are no lines to confirm."] });
    expect(canConfirm([line({ status: "removed" })]).ok).toBe(false);
  });

  it("does not require a grade", () => {
    expect(canConfirm([line()]).ok).toBe(true);
  });
});

describe("recomputeFlags", () => {
  const complete = {
    qty: 8,
    unit: "pcs" as const,
    length_ft: 50,
    length_text: "50'",
    grade_spec: "A992",
    catalog_item_id: ITEM,
    category: "w_beam" as const,
    flags: [] as string[],
  };

  it("derives the missing_* flags from the current values", () => {
    expect(recomputeFlags(complete)).toEqual([]);
    expect(recomputeFlags({ ...complete, qty: null, grade_spec: null })).toEqual(["missing_grade", "missing_qty"]);
    expect(recomputeFlags({ ...complete, catalog_item_id: null })).toEqual(["unmatched_item"]);
  });

  it("carries the model's judgment flags and drops unknown strings", () => {
    expect(recomputeFlags({ ...complete, flags: ["alternate_mentioned", "possible_duplicate", "ambiguous_size", "bogus"] })).toEqual([
      "ambiguous_size",
      "possible_duplicate",
      "alternate_mentioned",
    ]);
  });

  it("keeps ambiguous_unit only while the unit is blank", () => {
    expect(recomputeFlags({ ...complete, unit: null, flags: ["ambiguous_unit"] })).toEqual(["ambiguous_unit"]);
    expect(recomputeFlags({ ...complete, unit: null, qty: 8, flags: [] })).toEqual(["ambiguous_unit"]);
    expect(recomputeFlags({ ...complete, unit: "pcs", flags: ["ambiguous_unit"] })).toEqual([]);
    expect(recomputeFlags({ ...complete, unit: null, qty: null, flags: [] })).toEqual(["missing_qty"]);
  });
});

describe("aliasToLearn (AC-3.5)", () => {
  const item = { designation: "HSS8x8x5/8" };

  it("learns the normalized description of an unmatched line", () => {
    expect(aliasToLearn({ catalog_item_id: null, description: '8" sq tube 5/8 wall' }, item)).toBe("8 sq hss 5/8 wall");
  });

  it("learns nothing when the line was already linked (re-linking must not alias one designation to another item)", () => {
    expect(aliasToLearn({ catalog_item_id: ITEM, description: "HSS8x8x1/2" }, item)).toBeNull();
  });

  it("learns nothing from a blank description or from the item's own designation", () => {
    expect(aliasToLearn({ catalog_item_id: null, description: "   " }, item)).toBeNull();
    expect(aliasToLearn({ catalog_item_id: null, description: "hss8x8x5/8" }, item)).toBeNull();
  });

  it("learns nothing from a description with no size in it (a bare shape word would match every later line of that shape)", () => {
    const angle = { designation: "L2x2x1/4" };
    expect(aliasToLearn({ catalog_item_id: null, description: "angle" }, angle)).toBeNull();
    expect(aliasToLearn({ catalog_item_id: null, description: "plate" }, { designation: "PL3/8" })).toBeNull();
    expect(aliasToLearn({ catalog_item_id: null, description: "some channel for clips" }, { designation: "C12x30" })).toBeNull();
    expect(aliasToLearn({ catalog_item_id: null, description: "clip angle" }, angle)).toBeNull();
    // A vulgar fraction is a size: normalizeAlias turns it into digits first.
    expect(aliasToLearn({ catalog_item_id: null, description: "½ plate" }, { designation: "PL1/2" })).toBe("1/2 plate");
    expect(aliasToLearn({ catalog_item_id: null, description: "2x2 clip angle 1/4" }, angle)).toBe("2x2 clip angle 1/4");
  });

  it("aliasCarriesSize is the digit test", () => {
    expect(aliasCarriesSize("angle")).toBe(false);
    expect(aliasCarriesSize("8 sq hss 5/8 wall")).toBe(true);
    expect(aliasCarriesSize("")).toBe(false);
  });
});

describe("mergeLineValues", () => {
  const base: MergeSource = {
    raw_text: "W12x26 x 50' qty 8",
    description: "W12x26",
    unit: "pcs",
    grade_spec: null,
    length_text: null,
    length_ft: null,
    delivery_notes: null,
    category: "w_beam",
    catalog_item_id: ITEM,
    dims: { d: 12, wt: 26 },
    cut_to_length: false,
    flags: ["missing_grade", "possible_duplicate"],
  };

  it("joins the texts, fills blanks from the dropped line, and drops possible_duplicate", () => {
    const keep: MergeSource = { ...base, catalog_item_id: null, category: null, dims: {} };
    const drop: MergeSource = {
      ...base,
      raw_text: "8 pcs W12x26 A992 deliver to Waco",
      description: "W12x26 A992",
      grade_spec: "A992",
      delivery_notes: "deliver to Waco",
      length_text: "50'",
      length_ft: 50,
      cut_to_length: true,
      flags: ["alternate_mentioned", "possible_duplicate"],
    };
    expect(mergeLineValues(keep, drop)).toEqual({
      raw_text: "W12x26 x 50' qty 8 / 8 pcs W12x26 A992 deliver to Waco",
      description: "W12x26 / W12x26 A992",
      unit: "pcs",
      grade_spec: "A992",
      length_text: "50'",
      length_ft: 50,
      delivery_notes: "deliver to Waco",
      category: "w_beam",
      catalog_item_id: ITEM,
      dims: { d: 12, wt: 26 },
      cut_to_length: true,
      flags: ["missing_grade", "alternate_mentioned"],
    });
  });

  it("takes the length pair from one line, so length_ft always belongs to length_text", () => {
    // A kept "40' or 48'" does not parse (length_ft null, see parseLengthFt); the
    // dropped line's 50 must not be paired with it.
    const keep: MergeSource = { ...base, length_text: "40' or 48'", length_ft: null };
    const drop: MergeSource = { ...base, length_text: "50'", length_ft: 50 };
    expect(mergeLineValues(keep, drop)).toMatchObject({ length_text: "40' or 48'", length_ft: null });
    // A kept number without text (the model gave length_ft alone) keeps its pair too.
    expect(mergeLineValues({ ...base, length_ft: 40 }, drop)).toMatchObject({ length_text: null, length_ft: 40 });
    // Only a kept line with neither half takes the dropped line's pair.
    expect(mergeLineValues(base, drop)).toMatchObject({ length_text: "50'", length_ft: 50 });
    expect(mergeLineValues(base, base)).toMatchObject({ length_text: null, length_ft: null });
  });

  it("keeps the kept line's values when both are set", () => {
    const keep: MergeSource = { ...base, grade_spec: "A36", unit: "ft", category: "channel", dims: { d: 12, wt: 30 } };
    const drop: MergeSource = { ...base, grade_spec: "A992", unit: "pcs" };
    expect(mergeLineValues(keep, drop)).toMatchObject({ grade_spec: "A36", unit: "ft", category: "channel", dims: { d: 12, wt: 30 } });
  });
});

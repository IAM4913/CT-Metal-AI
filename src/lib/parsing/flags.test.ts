import { describe, expect, it } from "vitest";
import { requestLineFlagValues, type RequestLineFlag } from "@/lib/db/enums";
import { computeLineFlags, manualDuplicateDims, markPossibleDuplicates, orderFlags, type FlagInput } from "./flags";

// A line with nothing missing: no flags at all.
const complete: FlagInput = {
  qty: 8,
  unit: "pcs",
  length_ft: 50,
  length_text: "50'",
  grade_spec: "A992",
  catalog_item_id: "33333333-3333-4333-8333-333333333333",
  category: "w_beam",
  alternates_mentioned: [],
  ambiguous_size: false,
  ambiguous_unit: false,
};

describe("computeLineFlags", () => {
  it("returns no flags for a complete line", () => {
    expect(computeLineFlags(complete)).toEqual([]);
  });

  it("missing_qty when qty is null", () => {
    expect(computeLineFlags({ ...complete, qty: null })).toEqual(["missing_qty"]);
    expect(computeLineFlags({ ...complete, qty: 0 })).toEqual([]);
  });

  it("missing_grade when grade_spec is null or blank", () => {
    expect(computeLineFlags({ ...complete, grade_spec: null })).toEqual(["missing_grade"]);
    expect(computeLineFlags({ ...complete, grade_spec: "" })).toEqual(["missing_grade"]);
    expect(computeLineFlags({ ...complete, grade_spec: "   " })).toEqual(["missing_grade"]);
    expect(computeLineFlags({ ...complete, grade_spec: "A36" })).toEqual([]);
  });

  it("missing_length when neither length_ft nor length_text is present", () => {
    expect(computeLineFlags({ ...complete, length_ft: null, length_text: null })).toEqual(["missing_length"]);
    expect(computeLineFlags({ ...complete, length_ft: null, length_text: "  " })).toEqual(["missing_length"]);
    // Either one is enough: unparsed text is still a length the reviewer can read.
    expect(computeLineFlags({ ...complete, length_ft: null, length_text: "random" })).toEqual([]);
    expect(computeLineFlags({ ...complete, length_ft: 40, length_text: null })).toEqual([]);
    // Unknown category counts as needing a length.
    expect(computeLineFlags({ ...complete, length_ft: null, length_text: null, category: null })).toEqual([
      "missing_length",
    ]);
  });

  it("does not flag missing_length on plate or sheet", () => {
    expect(computeLineFlags({ ...complete, length_ft: null, length_text: null, category: "plate" })).toEqual([]);
    expect(computeLineFlags({ ...complete, length_ft: null, length_text: null, category: "sheet" })).toEqual([]);
    // Other flags still apply to plate.
    expect(computeLineFlags({ ...complete, length_ft: null, length_text: null, category: "plate", qty: null })).toEqual([
      "missing_qty",
    ]);
  });

  it("unmatched_item when catalog_item_id is null", () => {
    expect(computeLineFlags({ ...complete, catalog_item_id: null })).toEqual(["unmatched_item"]);
  });

  it("alternate_mentioned when alternates_mentioned is non-empty", () => {
    expect(computeLineFlags({ ...complete, alternates_mentioned: ["3/8 wall"] })).toEqual(["alternate_mentioned"]);
    expect(computeLineFlags({ ...complete, alternates_mentioned: [] })).toEqual([]);
  });

  it("passes ambiguous_size and ambiguous_unit through when true", () => {
    expect(computeLineFlags({ ...complete, ambiguous_size: true })).toEqual(["ambiguous_size"]);
    expect(computeLineFlags({ ...complete, ambiguous_unit: true })).toEqual(["ambiguous_unit"]);
    expect(computeLineFlags({ ...complete, ambiguous_size: true, ambiguous_unit: true })).toEqual([
      "ambiguous_size",
      "ambiguous_unit",
    ]);
  });

  it("never emits possible_duplicate on its own", () => {
    const everything: FlagInput = {
      qty: null,
      unit: null,
      length_ft: null,
      length_text: null,
      grade_spec: null,
      catalog_item_id: null,
      category: null,
      alternates_mentioned: ["1/2 wall"],
      ambiguous_size: true,
      ambiguous_unit: true,
    };
    expect(computeLineFlags(everything)).not.toContain("possible_duplicate");
  });

  it("returns flags in requestLineFlagValues order regardless of which rules fired", () => {
    const everything: FlagInput = {
      qty: null,
      unit: null,
      length_ft: null,
      length_text: null,
      grade_spec: null,
      catalog_item_id: null,
      category: "hss_square",
      alternates_mentioned: ["1/2 wall"],
      ambiguous_size: true,
      ambiguous_unit: true,
    };
    const flags = computeLineFlags(everything);
    expect(flags).toEqual([
      "missing_grade",
      "missing_qty",
      "missing_length",
      "ambiguous_size",
      "ambiguous_unit",
      "unmatched_item",
      "alternate_mentioned",
    ]);
    const expectedOrder = requestLineFlagValues.filter((f) => flags.includes(f));
    expect(flags).toEqual(expectedOrder);
  });

  it("orderFlags sorts and dedupes", () => {
    const messy: RequestLineFlag[] = ["unmatched_item", "missing_qty", "missing_grade", "missing_qty"];
    expect(orderFlags(messy)).toEqual(["missing_grade", "missing_qty", "unmatched_item"]);
  });
});

describe("markPossibleDuplicates", () => {
  type Line = { description: string; dims: Record<string, unknown>; flags: RequestLineFlag[]; id: number };

  it("flags every line whose normalized description and dims match another line", () => {
    // Three spellings that normalizeAlias folds to "8x8x5/8 hss"; dims key order differs on the last.
    const lines: Line[] = [
      { id: 1, description: "8x8x5/8 tube", dims: { a: "8", b: "8", t: "5/8" }, flags: ["missing_grade"] },
      { id: 2, description: "W12x26", dims: { d: "12", wt: "26" }, flags: [] },
      { id: 3, description: "8X8X5/8 Tubing", dims: { a: "8", b: "8", t: "5/8" }, flags: [] },
      { id: 4, description: "8 x 8 x 5/8 HSS", dims: { t: "5/8", b: "8", a: "8" }, flags: ["missing_qty"] },
    ];
    const marked = markPossibleDuplicates(lines);
    expect(marked.map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(marked[0].flags).toEqual(["missing_grade", "possible_duplicate"]);
    expect(marked[1].flags).toEqual([]);
    expect(marked[2].flags).toEqual(["possible_duplicate"]);
    expect(marked[3].flags).toEqual(["missing_qty", "possible_duplicate"]);
  });

  it("does not flag lines that differ in dims or description", () => {
    const lines: Line[] = [
      { id: 1, description: "8x8x5/8 tube", dims: { a: "8", b: "8", t: "5/8" }, flags: [] },
      { id: 2, description: "8x8x3/8 tube", dims: { a: "8", b: "8", t: "3/8" }, flags: [] },
      { id: 3, description: "8x8x5/8 tube", dims: { a: "8", b: "8", t: "5/8", note: "cut" }, flags: [] },
      { id: 4, description: "8x6x5/8 tube", dims: { a: "8", b: "8", t: "5/8" }, flags: [] },
    ];
    for (const line of markPossibleDuplicates(lines)) {
      expect(line.flags).toEqual([]);
    }
  });

  it("does not mutate the input, keeps extra fields, and is idempotent", () => {
    const lines: Line[] = [
      { id: 1, description: "3/8 plate", dims: {}, flags: [] },
      { id: 2, description: "3/8 PLATE", dims: {}, flags: ["missing_qty"] },
    ];
    const snapshot = JSON.parse(JSON.stringify(lines)) as Line[];
    const once = markPossibleDuplicates(lines);
    expect(lines).toEqual(snapshot);
    expect(once[0]).toEqual({ id: 1, description: "3/8 plate", dims: {}, flags: ["possible_duplicate"] });
    expect(once[1].flags).toEqual(["missing_qty", "possible_duplicate"]);
    expect(markPossibleDuplicates(once)).toEqual(once);
  });

  it("returns an empty array for no lines and the same lines for a single line", () => {
    expect(markPossibleDuplicates([])).toEqual([]);
    const single: Line[] = [{ id: 1, description: "W12x26", dims: {}, flags: [] }];
    expect(markPossibleDuplicates(single)).toEqual(single);
  });
});

describe("manualDuplicateDims", () => {
  type Typed = Parameters<typeof manualDuplicateDims>[0];
  const w12: Typed = { qty: 8, unit: "pcs", length_ft: 40, length_text: "40'", grade_spec: "A992" };
  const line = (id: number, typed: Typed, description = "W12x26") => ({
    id,
    description,
    dims: manualDuplicateDims(typed),
    flags: [] as RequestLineFlag[],
  });

  it("keeps same-section lines in different lengths, grades, or quantities apart", () => {
    const lines = [
      line(1, w12),
      line(2, { ...w12, length_ft: 50, length_text: "50'" }),
      line(3, { ...w12, grade_spec: "A36" }),
      line(4, { ...w12, qty: 12 }),
      line(5, { ...w12, unit: "ft" }),
      line(6, { ...w12, grade_spec: null }),
      line(7, { ...w12, length_ft: null, length_text: null }),
    ];
    for (const marked of markPossibleDuplicates(lines)) {
      expect(marked.flags).toEqual([]);
    }
  });

  it("flags the same typed line entered twice, whatever the spelling of its length and grade", () => {
    const lines = [
      line(1, w12),
      line(2, { ...w12, length_text: "40 ft", grade_spec: " a992 " }, "w12 x 26"),
      line(3, { ...w12, length_ft: 50, length_text: "50'" }),
    ];
    const marked = markPossibleDuplicates(lines);
    expect(marked[0].flags).toEqual(["possible_duplicate"]);
    expect(marked[1].flags).toEqual(["possible_duplicate"]);
    expect(marked[2].flags).toEqual([]);
  });

  it("uses the length text when it did not parse and folds blank fields to null", () => {
    expect(manualDuplicateDims({ qty: null, unit: null, length_ft: null, length_text: "Random", grade_spec: null })).toEqual({
      qty: null,
      unit: null,
      length: "random",
      grade: null,
    });
    expect(manualDuplicateDims({ qty: null, unit: null, length_ft: null, length_text: "  ", grade_spec: "" })).toEqual({
      qty: null,
      unit: null,
      length: null,
      grade: null,
    });
  });
});

import { describe, expect, it } from "vitest";
import { generateCatalog } from "@/lib/catalog/generate";
import { aliasIndexFromCatalog } from "./alias-index";
import { buildExtractionDocument, SOURCE_TEXT_HEADER, type ExtractionDocument } from "./document";
import {
  designationCandidates,
  dimsToObject,
  inferUnit,
  lengthFromRawText,
  normalizeExtractedLines,
} from "./normalize";
import type { ExtractedLine, ExtractMaterialLinesOutput } from "./schema";

const index = aliasIndexFromCatalog(generateCatalog());

/** A model line with every field null or empty; tests override what they need. */
function modelLine(rawText: string, doc: ExtractionDocument, overrides: Partial<ExtractedLine> = {}): ExtractedLine {
  const start = doc.text.indexOf(rawText);
  return {
    raw_text: rawText,
    span: { start, end: start + rawText.length },
    product_type: null,
    category: null,
    dims: [],
    grade_spec: null,
    qty: null,
    unit: null,
    length_ft: null,
    length_text: null,
    cut_to_length: false,
    delivery_notes: null,
    alternates_mentioned: [],
    confidence: 0.9,
    flags: [],
    ...overrides,
  };
}

function textDoc(text: string): ExtractionDocument {
  return buildExtractionDocument([{ kind: "text", text }]);
}

function run(doc: ExtractionDocument, lines: ExtractedLine[]) {
  const output: ExtractMaterialLinesOutput = { lines, notes: null };
  return normalizeExtractedLines(output, doc, index);
}

describe("dimsToObject", () => {
  it("turns fractions and numbers into numbers and keeps other strings", () => {
    expect(
      dimsToObject([
        { key: "a", value: "8" },
        { key: "b", value: " 8 " },
        { key: "t", value: "5/8" },
        { key: "series", value: "C" },
        { key: "wt", value: "31.8" },
        { key: "nps", value: "1-1/2" },
      ]),
    ).toEqual({ a: 8, b: 8, t: 0.625, series: "C", wt: 31.8, nps: 1.5 });
  });

  it("skips blank keys and blank values", () => {
    expect(dimsToObject([{ key: "", value: "8" }, { key: "t", value: "  " }])).toEqual({});
  });
});

describe("inferUnit", () => {
  it("keeps the model's unit", () => {
    expect(inferUnit("ft", 100, "100 ft of angle")).toBe("ft");
  });

  it("reads pcs only from an explicit piece word beside a quantity", () => {
    expect(inferUnit(null, 6, "6 pcs at 40 ft")).toBe("pcs");
    expect(inferUnit(null, 6, "6 PCS")).toBe("pcs");
    expect(inferUnit(null, 6, "6 ea")).toBe("pcs");
    expect(inferUnit(null, 6, "six pieces, 6 each")).toBe("pcs");
    expect(inferUnit(null, 6, "qty 6 piece")).toBe("pcs");
  });

  it("stays null without a piece word or without a quantity", () => {
    expect(inferUnit(null, 20, "8 square 3/8 x 40 - 20")).toBeNull();
    expect(inferUnit(null, 20, "20 of the 8x8 tubes")).toBeNull();
    expect(inferUnit(null, null, "some pcs of angle")).toBeNull();
    expect(inferUnit(null, 6, "6 specimens")).toBeNull();
  });
});

describe("lengthFromRawText", () => {
  it("reads a foot-marked token", () => {
    expect(lengthFromRawText("W12x26 x 50' qty 8")).toEqual({ length_ft: 50, length_text: "50'" });
    expect(lengthFromRawText("6 pcs at 40 ft")).toEqual({ length_ft: 40, length_text: "40 ft" });
    expect(lengthFromRawText("40ft. lengths")).toEqual({ length_ft: 40, length_text: "40ft." });
    expect(lengthFromRawText("20 feet long")).toEqual({ length_ft: 20, length_text: "20 feet" });
    expect(lengthFromRawText("12-1/2' sticks")).toEqual({ length_ft: 12.5, length_text: "12-1/2'" });
  });

  it("reads feet and inches together", () => {
    expect(lengthFromRawText("cut to 20'6\"")).toEqual({ length_ft: 20.5, length_text: "20'6\"" });
    expect(lengthFromRawText("40'-0\" lengths")).toEqual({ length_ft: 40, length_text: "40'-0\"" });
  });

  it("reads a mixed number written with a space as one number, as parseLengthFt does", () => {
    expect(lengthFromRawText("angle 12 1/2' long, 6 pcs")).toEqual({ length_ft: 12.5, length_text: "12 1/2'" });
    expect(lengthFromRawText("12 1/2 ft")).toEqual({ length_ft: 12.5, length_text: "12 1/2 ft" });
    expect(lengthFromRawText("8 1/2' lengths")).toEqual({ length_ft: 8.5, length_text: "8 1/2'" });
    expect(lengthFromRawText("x 12 1/2'")).toEqual({ length_ft: 12.5, length_text: "12 1/2'" });
    expect(lengthFromRawText("20' 6 1/2\"")).toEqual({ length_ft: 20.5417, length_text: "20' 6 1/2\"" });
    expect(lengthFromRawText("12 1⁄2'")).toEqual({ length_ft: 12.5, length_text: "12 1⁄2'" });
    expect(lengthFromRawText("12½'")).toEqual({ length_ft: 12.5, length_text: "12½'" });
  });

  it("reads an inch-marked length only after x, @, or at", () => {
    expect(lengthFromRawText('HSS4x4x1/4 x 480"')).toEqual({ length_ft: 40, length_text: '480"' });
    expect(lengthFromRawText('L2x2x1/4 x 240"')).toEqual({ length_ft: 20, length_text: '240"' });
    expect(lengthFromRawText('8x8x5/8 x 480"')).toEqual({ length_ft: 40, length_text: '480"' });
    expect(lengthFromRawText('1/4 x 2 flat bar x 240"')).toEqual({ length_ft: 20, length_text: '240"' });
    expect(lengthFromRawText('1/2" rd x 240"')).toEqual({ length_ft: 20, length_text: '240"' });
    expect(lengthFromRawText("flat bar at 240 in")).toEqual({ length_ft: 20, length_text: "240 in" });
    expect(lengthFromRawText('C12x30 @ 480"')).toEqual({ length_ft: 40, length_text: '480"' });
    expect(lengthFromRawText('6" sq 3/8 wall, 20 pcs')).toBeNull();
  });

  it("does not read a cross-section dimension inside an A x B x T chain as a length", () => {
    expect(lengthFromRawText('1/4" x 2" flat bar, 10 pcs')).toBeNull();
    expect(lengthFromRawText('3/8 x 4" flat bar, 10 pcs')).toBeNull();
    expect(lengthFromRawText('6" x 6" x 3/8" wall tube, 20 pcs')).toBeNull();
    expect(lengthFromRawText('6 x 6" x 3/8 wall')).toBeNull();
    expect(lengthFromRawText('plate 3/8" x 48" x 96", 4 pcs')).toBeNull();
    // Conservative: the 240" here is a length, but it follows an inch-marked
    // operand like the 2" before it, so it stays null rather than becoming 2".
    expect(lengthFromRawText('angle 2" x 2" x 1/4" x 240"')).toBeNull();
  });

  it("does not read a foot-marked sheet size as a length", () => {
    expect(lengthFromRawText("3/8 plate 4' x 8', 4 pcs")).toBeNull();
    expect(lengthFromRawText("4' x 8' x 3/8 plate")).toBeNull();
    expect(lengthFromRawText("16 ga sheet 4' x 10' qty 3")).toBeNull();
    // A wall or leg before the x is not a foot-marked operand; the length stands.
    expect(lengthFromRawText("6\" sq 3/8 x 24' qty 20")).toEqual({ length_ft: 24, length_text: "24'" });
    expect(lengthFromRawText("2\" x 6\" x 40'")).toEqual({ length_ft: 40, length_text: "40'" });
    expect(lengthFromRawText("20' lengths x 6 pcs")).toEqual({ length_ft: 20, length_text: "20'" });
  });

  it("never reads a bare number", () => {
    expect(lengthFromRawText("8 square 3/8 x 40 - 20 pcs")).toBeNull();
    expect(lengthFromRawText("W12x26 qty 8")).toBeNull();
    expect(lengthFromRawText("3/8 plate 48x96 qty 10 A36")).toBeNull();
  });
});

describe("designationCandidates", () => {
  it("builds the catalog designation from category and dims", () => {
    expect(designationCandidates("hss_square", { a: 8, b: 8, t: 0.625 })).toEqual(["HSS8x8x5/8"]);
    expect(designationCandidates("hss_square", { a: 6, t: 0.375 })).toEqual(["HSS6x6x3/8"]);
    expect(designationCandidates("hss_rectangular", { a: 4, b: 8, t: 0.25 })).toEqual(["HSS8x4x1/4"]);
    expect(designationCandidates("hss_round", { nominal: 8, od: 8.625, t: 0.375 })).toEqual(["HSS8x3/8", "HSS8-5/8x3/8"]);
    expect(designationCandidates("pipe", { nps: 2, sch: 40 })).toEqual(["PIPE2STD"]);
    expect(designationCandidates("pipe", { nps: 1.5, schedule: "XS" })).toEqual(["PIPE1-1/2XS"]);
    expect(designationCandidates("pipe", { nps: 2, schedule: "standard" })).toEqual(["PIPE2STD"]);
    expect(designationCandidates("w_beam", { d: 12, wt: 26 })).toEqual(["W12x26"]);
    expect(designationCandidates("s_beam", { d: 12, wt: 31.8 })).toEqual(["S12x31.8"]);
    expect(designationCandidates("channel", { d: 12, wt: 30 })).toEqual(["C12x30"]);
    expect(designationCandidates("channel", { d: 8, wt: 11.5, series: "C" })).toEqual(["C8x11.5"]);
    expect(designationCandidates("channel", { d: 12, wt: 31, series: "mc" })).toEqual(["MC12x31"]);
    expect(designationCandidates("angle", { a: 2, b: 2, t: 0.25 })).toEqual(["L2x2x1/4"]);
    expect(designationCandidates("angle", { a: 3, b: 4, t: 0.25 })).toEqual(["L4x3x1/4"]);
    expect(designationCandidates("flat_bar", { t: 0.25, w: 2 })).toEqual(["FB1/4x2"]);
    expect(designationCandidates("round_bar", { d: 1.5 })).toEqual(["RB1-1/2"]);
    expect(designationCandidates("square_bar", { a: 1 })).toEqual(["SQ1"]);
    expect(designationCandidates("plate", { t: 0.375, w: 48, l: 96 })).toEqual(["PL3/8"]);
    expect(designationCandidates("sheet", { gauge: 16 })).toEqual(["SH16GA"]);
    expect(designationCandidates("rebar", { bar_number: 4 })).toEqual(["REBAR#4"]);
  });

  it("builds nothing when the dims are incomplete, non-numeric, or the category is null", () => {
    expect(designationCandidates(null, { a: 8, b: 8, t: 0.625 })).toEqual([]);
    expect(designationCandidates("hss_square", { a: 8 })).toEqual([]);
    expect(designationCandidates("hss_square", { a: "eight", b: 8, t: 0.625 })).toEqual([]);
    expect(designationCandidates("pipe", { nps: 2 })).toEqual([]);
    expect(designationCandidates("pipe", { nps: 2, sch: 160 })).toEqual([]);
    expect(designationCandidates("channel", { d: 12 })).toEqual([]);
  });

  it("reads a pipe schedule as STD or XS only through the sizes where they coincide", () => {
    // generate.ts: sch 40 is STD through NPS 10, sch 80 is XS through NPS 8.
    expect(designationCandidates("pipe", { nps: 10, sch: 40 })).toEqual(["PIPE10STD"]);
    expect(designationCandidates("pipe", { nps: 8, sch: 80 })).toEqual(["PIPE8XS"]);
    // 12" sch 40 is 0.406 wall, PIPE12STD is 0.375; 10" sch 80 is 0.594, PIPE10XS is 0.500.
    expect(designationCandidates("pipe", { nps: 12, sch: 40 })).toEqual([]);
    expect(designationCandidates("pipe", { nps: 12, schedule: "sch 40" })).toEqual([]);
    expect(designationCandidates("pipe", { nps: 10, sch: 80 })).toEqual([]);
    expect(designationCandidates("pipe", { nps: 12, sch: 80 })).toEqual([]);
    // The class words carry no size limit.
    expect(designationCandidates("pipe", { nps: 12, schedule: "XS" })).toEqual(["PIPE12XS"]);
    expect(designationCandidates("pipe", { nps: 12, schedule: "std" })).toEqual(["PIPE12STD"]);
  });
});

describe("normalizeExtractedLines", () => {
  const SINGLE = "Need pricing on 100 pcs 8x8x5/8 HSS, 40' lengths, A500 Gr B, delivered Fort Worth. If 5/8 is too heavy can look at 3/8.";

  it("parses fraction dims, links the item, and reads the length from length_text", () => {
    const doc = textDoc(SINGLE);
    const raw = "100 pcs 8x8x5/8 HSS, 40' lengths, A500 Gr B, delivered Fort Worth";
    const [line] = run(doc, [
      modelLine(raw, doc, {
        product_type: "HSS 8x8x5/8",
        category: "hss_square",
        dims: [
          { key: "a", value: "8" },
          { key: "b", value: "8" },
          { key: "t", value: "5/8" },
        ],
        grade_spec: "A500 Gr B",
        qty: 100,
        unit: "pcs",
        length_text: "40'",
        delivery_notes: "delivered Fort Worth",
        alternates_mentioned: ["3/8 if 5/8 is too heavy"],
        flags: ["alternate_mentioned"],
        confidence: 0.95,
      }),
    ]);

    expect(line).toMatchObject({
      line_no: 1,
      raw_text: raw,
      description: "HSS8x8x5/8",
      product_type: "HSS 8x8x5/8",
      category: "hss_square",
      catalog_item_id: "HSS8x8x5/8",
      dims: { a: 8, b: 8, t: 0.625 },
      grade_spec: "A500 Gr B",
      qty: 100,
      unit: "pcs",
      length_ft: 40,
      length_text: "40'",
      cut_to_length: false,
      delivery_notes: "delivered Fort Worth",
      alternates_mentioned: ["3/8 if 5/8 is too heavy"],
      flags: ["alternate_mentioned"],
      confidence: 0.95,
      span_verified: true,
    });
    expect(line.source_span).toEqual({ kind: "text", start: SINGLE.indexOf(raw), end: SINGLE.indexOf(raw) + raw.length });
  });

  it("lets the matched item override the model's category and sets the description to the designation", () => {
    const doc = textDoc("12 inch channel 30# or heavier, 6 pcs at 40 ft");
    const [line] = run(doc, [
      modelLine("12 inch channel 30# or heavier, 6 pcs at 40 ft", doc, {
        product_type: "12 inch channel 30#",
        category: "w_beam",
        qty: 6,
        unit: "pcs",
        length_text: "40 ft",
        alternates_mentioned: ["or heavier"],
      }),
    ]);
    expect(line.catalog_item_id).toBe("C12x30");
    expect(line.category).toBe("channel");
    expect(line.description).toBe("C12x30");
    expect(line.length_ft).toBe(40);
    expect(line.flags).toEqual(["missing_grade", "alternate_mentioned"]);
  });

  it("builds the designation from category and dims when the words alone do not match", () => {
    const doc = textDoc("6\" sq 3/8 x 24' qty 20");
    const [line] = run(doc, [
      modelLine("6\" sq 3/8 x 24' qty 20", doc, {
        product_type: "square tube",
        category: "hss_square",
        dims: [
          { key: "a", value: "6" },
          { key: "b", value: "6" },
          { key: "t", value: "3/8" },
        ],
        qty: 20,
        unit: "pcs",
        length_ft: 24,
        length_text: "24'",
      }),
    ]);
    expect(line.catalog_item_id).toBe("HSS6x6x3/8");
    expect(line.description).toBe("HSS6x6x3/8");
    expect(line.length_ft).toBe(24);
  });

  it("infers pcs only from an explicit piece word, otherwise flags ambiguous_unit", () => {
    const doc = textDoc("W12x26 x 50' 8 pcs\nW12x26 x 50' 8");
    const [withWord, bare] = run(doc, [
      modelLine("W12x26 x 50' 8 pcs", doc, { product_type: "W12x26", qty: 8, length_text: "50'", grade_spec: "A992" }),
      modelLine("W12x26 x 50' 8", doc, { product_type: "W12x26", qty: 8, length_text: "50'", grade_spec: "A992" }),
    ]);
    expect(withWord.unit).toBe("pcs");
    expect(withWord.flags).toEqual(["possible_duplicate"]);
    expect(bare.unit).toBeNull();
    expect(bare.flags).toEqual(["ambiguous_unit", "possible_duplicate"]);
  });

  it("reads a marked length from raw_text when the model gave none, and never a bare number", () => {
    const doc = textDoc("L2x2x1/4 x 20' qty 40\n8 square 3/8 x 40 - 20 pcs");
    const [angle, hss] = run(doc, [
      modelLine("L2x2x1/4 x 20' qty 40", doc, { product_type: "L2x2x1/4", qty: 40, unit: "pcs" }),
      modelLine("8 square 3/8 x 40 - 20 pcs", doc, { product_type: "8 square 3/8", qty: 20, unit: "pcs" }),
    ]);
    expect(angle).toMatchObject({ catalog_item_id: "L2x2x1/4", length_ft: 20, length_text: "20'" });
    expect(angle.flags).toEqual(["missing_grade"]);
    expect(hss).toMatchObject({ catalog_item_id: "HSS8x8x3/8", length_ft: null, length_text: null });
    expect(hss.flags).toEqual(["missing_grade", "missing_length"]);
  });

  it("leaves the length null on a plate or sheet line even when the raw text carries a marked sheet size", () => {
    const doc = textDoc("3/8 plate 4' x 8', 4 pcs\nplate 3/8\" x 48\" x 96\", 4 pcs\n16 ga sheet 4' x 10' qty 3");
    const [plateFeet, plateInches, sheet] = run(doc, [
      modelLine("3/8 plate 4' x 8', 4 pcs", doc, {
        product_type: "3/8 plate",
        category: "plate",
        dims: [
          { key: "t", value: "3/8" },
          { key: "w", value: "4'" },
          { key: "l", value: "8'" },
        ],
        qty: 4,
        unit: "pcs",
      }),
      // No category from the model: the plate is known only through the catalog match.
      modelLine("plate 3/8\" x 48\" x 96\", 4 pcs", doc, { product_type: "3/8 plate", qty: 4, unit: "pcs" }),
      modelLine("16 ga sheet 4' x 10' qty 3", doc, {
        product_type: "16 ga sheet",
        category: "sheet",
        dims: [{ key: "gauge", value: "16" }],
        qty: 3,
        unit: "pcs",
      }),
    ]);
    expect(plateFeet).toMatchObject({ catalog_item_id: "PL3/8", category: "plate", length_ft: null, length_text: null });
    expect(plateFeet.flags).toEqual(["missing_grade"]);
    expect(plateInches).toMatchObject({ catalog_item_id: "PL3/8", category: "plate", length_ft: null, length_text: null });
    expect(plateInches.flags).toEqual(["missing_grade"]);
    expect(sheet).toMatchObject({ catalog_item_id: "SH16GA", category: "sheet", length_ft: null, length_text: null });
    expect(sheet.flags).toEqual(["missing_grade"]);
  });

  it("does not fabricate a length from a cross-section dimension, and flags the length missing instead", () => {
    const doc = textDoc('1/4" x 2" flat bar, 10 pcs\n6" x 6" x 3/8" wall tube, 20 pcs');
    const [bar, tube] = run(doc, [
      modelLine('1/4" x 2" flat bar, 10 pcs', doc, {
        product_type: "flat bar",
        category: "flat_bar",
        dims: [
          { key: "t", value: "1/4" },
          { key: "w", value: "2" },
        ],
        qty: 10,
        unit: "pcs",
      }),
      modelLine('6" x 6" x 3/8" wall tube, 20 pcs', doc, {
        product_type: "square tube",
        category: "hss_square",
        dims: [
          { key: "a", value: "6" },
          { key: "b", value: "6" },
          { key: "t", value: "3/8" },
        ],
        qty: 20,
        unit: "pcs",
      }),
    ]);
    expect(bar).toMatchObject({ catalog_item_id: "FB1/4x2", length_ft: null, length_text: null });
    expect(bar.flags).toEqual(["missing_grade", "missing_length"]);
    expect(tube).toMatchObject({ catalog_item_id: "HSS6x6x3/8", length_ft: null, length_text: null });
    expect(tube.flags).toEqual(["missing_grade", "missing_length"]);
  });

  it("reads a spaced mixed number in raw_text as the whole number, not its fraction", () => {
    const doc = textDoc("L2x2x1/4 x 12 1/2' long, 6 pcs");
    const [angle] = run(doc, [modelLine("L2x2x1/4 x 12 1/2' long, 6 pcs", doc, { product_type: "L2x2x1/4", qty: 6, unit: "pcs" })]);
    expect(angle).toMatchObject({ catalog_item_id: "L2x2x1/4", length_ft: 12.5, length_text: "12 1/2'" });
    expect(angle.flags).toEqual(["missing_grade"]);
  });

  it("leaves a pipe past the schedule cutoff unmatched instead of linking the wrong wall", () => {
    const doc = textDoc('12" sch 40 pipe x 21\' qty 4\n2" sch 40 pipe x 21\' qty 4');
    const [twelve, two] = run(doc, [
      modelLine('12" sch 40 pipe x 21\' qty 4', doc, {
        product_type: '12" sch 40 pipe',
        category: "pipe",
        dims: [
          { key: "nps", value: "12" },
          { key: "sch", value: "40" },
        ],
        qty: 4,
        unit: "pcs",
        length_text: "21'",
      }),
      modelLine('2" sch 40 pipe x 21\' qty 4', doc, {
        product_type: '2" sch 40 pipe',
        category: "pipe",
        dims: [
          { key: "nps", value: "2" },
          { key: "sch", value: "40" },
        ],
        qty: 4,
        unit: "pcs",
        length_text: "21'",
      }),
    ]);
    expect(twelve).toMatchObject({ catalog_item_id: null, category: "pipe", description: '12" sch 40 pipe' });
    expect(twelve.flags).toEqual(["missing_grade", "unmatched_item"]);
    expect(two).toMatchObject({ catalog_item_id: "PIPE2STD", description: "PIPE2STD" });
    expect(two.flags).toEqual(["missing_grade"]);
  });

  it("drops ambiguous_unit once the unit is known, whether the model or a piece word settled it", () => {
    // Three lengths, so no line is another's possible_duplicate.
    const doc = textDoc("6 pcs C12x30 x 40'\n6 pcs C12x30 x 30' A36\n6 C12x30 x 20'");
    const [inferred, modelUnit, bare] = run(doc, [
      modelLine("6 pcs C12x30 x 40'", doc, { product_type: "C12x30", qty: 6, length_text: "40'", flags: ["ambiguous_unit"] }),
      modelLine("6 pcs C12x30 x 30' A36", doc, {
        product_type: "C12x30",
        qty: 6,
        unit: "pcs",
        length_text: "30'",
        grade_spec: "A36",
        flags: ["ambiguous_unit"],
      }),
      modelLine("6 C12x30 x 20'", doc, { product_type: "C12x30", qty: 6, length_text: "20'", flags: ["ambiguous_unit"] }),
    ]);
    expect(inferred.unit).toBe("pcs");
    expect(inferred.flags).toEqual(["missing_grade"]);
    expect(modelUnit.unit).toBe("pcs");
    expect(modelUnit.flags).toEqual([]);
    expect(bare.unit).toBeNull();
    expect(bare.flags).toEqual(["missing_grade", "ambiguous_unit"]);
  });

  it("parses the bare number the model put in length_text, and inches", () => {
    const doc = textDoc("8 square 3/8 x 40 - 20 pcs\nangle x 480\"");
    const [hss, angle] = run(doc, [
      modelLine("8 square 3/8 x 40 - 20 pcs", doc, { product_type: "8 square 3/8", qty: 20, unit: "pcs", length_text: "x 40" }),
      modelLine("angle x 480\"", doc, { product_type: "angle", category: "angle", length_text: "480\"" }),
    ]);
    expect(hss.length_ft).toBe(40);
    expect(angle.length_ft).toBe(40);
  });

  it("flags every missing value and an unmatched item, and plate needs no length", () => {
    const doc = textDoc("some angle for clips\n3/8 plate 48x96 qty 10 A36");
    const [angle, plate] = run(doc, [
      modelLine("some angle for clips", doc, { product_type: "angle", category: "angle", flags: ["ambiguous_size"] }),
      modelLine("3/8 plate 48x96 qty 10 A36", doc, {
        product_type: "3/8 plate",
        category: "plate",
        dims: [
          { key: "t", value: "3/8" },
          { key: "w", value: "48" },
          { key: "l", value: "96" },
        ],
        qty: 10,
        unit: "pcs",
        grade_spec: "A36",
      }),
    ]);
    expect(angle).toMatchObject({ category: "angle", catalog_item_id: null, description: "angle", qty: null, unit: null });
    expect(angle.flags).toEqual(["missing_grade", "missing_qty", "missing_length", "ambiguous_size", "unmatched_item"]);
    expect(plate).toMatchObject({
      catalog_item_id: "PL3/8",
      description: "PL3/8",
      category: "plate",
      dims: { t: 0.375, w: 48, l: 96 },
      grade_spec: "A36",
    });
    expect(plate.flags).toEqual([]);
  });

  it("falls back to the trimmed raw text as the description when the model names no product type", () => {
    const doc = textDoc("  a few sticks of something  ");
    const [line] = run(doc, [modelLine("  a few sticks of something  ", doc)]);
    expect(line.description).toBe("a few sticks of something");
    expect(line.catalog_item_id).toBeNull();
  });

  it("marks duplicates across lines and keeps the model's duplicate flag", () => {
    const doc = textDoc("W12x26 x 50' qty 8\nW12x26 x 50' qty 8\nC12x30 x 40' qty 6");
    const second = doc.text.lastIndexOf("W12x26 x 50' qty 8");
    const lines = run(doc, [
      modelLine("W12x26 x 50' qty 8", doc, { product_type: "W12x26", qty: 8, unit: "pcs", length_text: "50'", grade_spec: "A992" }),
      {
        ...modelLine("W12x26 x 50' qty 8", doc, { product_type: "W12x26", qty: 8, unit: "pcs", length_text: "50'", grade_spec: "A992" }),
        span: { start: second, end: second + "W12x26 x 50' qty 8".length },
        flags: ["possible_duplicate"],
      },
      modelLine("C12x30 x 40' qty 6", doc, { product_type: "C12x30", qty: 6, unit: "pcs", length_text: "40'", grade_spec: "A36" }),
    ]);
    expect(lines.map((l) => l.flags)).toEqual([["possible_duplicate"], ["possible_duplicate"], []]);
    expect(lines.map((l) => l.line_no)).toEqual([1, 2, 3]);
    expect(lines[1].source_span).toEqual({ kind: "text", start: 19, end: 37 });
  });

  it("keeps the same section in different lengths or grades as separate lines, and flags a repeat at one length", () => {
    const text = "W12x26 x 50' qty 8\nW12x26 x 40' qty 4\nW12x26 x 50' qty 2 A36\nW12x26 x 50' qty 6";
    const doc = textDoc(text);
    const at = (raw: string, nth: number) => {
      let from = -1;
      for (let i = 0; i <= nth; i += 1) from = doc.text.indexOf(raw, from + 1);
      return { start: from, end: from + raw.length };
    };
    const beam = (raw: string, qty: number, lengthText: string, grade: string | null) =>
      modelLine(raw, doc, {
        product_type: "W12x26",
        category: "w_beam",
        dims: [
          { key: "d", value: "12" },
          { key: "wt", value: "26" },
        ],
        qty,
        unit: "pcs",
        length_text: lengthText,
        grade_spec: grade,
      });
    const lines = run(doc, [
      beam("W12x26 x 50' qty 8", 8, "50'", null),
      beam("W12x26 x 40' qty 4", 4, "40'", null),
      beam("W12x26 x 50' qty 2 A36", 2, "50'", "A36"),
      { ...beam("W12x26 x 50' qty 6", 6, "50'", null), span: at("W12x26 x 50' qty 6", 0) },
    ]);
    expect(lines.map((l) => l.catalog_item_id)).toEqual(["W12x26", "W12x26", "W12x26", "W12x26"]);
    expect(lines.map((l) => l.dims)).toEqual([
      { d: 12, wt: 26 },
      { d: 12, wt: 26 },
      { d: 12, wt: 26 },
      { d: 12, wt: 26 },
    ]);
    // 1 and 4: same section, same length, same (missing) grade, different counts: a repeat.
    // 2 (another length) and 3 (a grade) are their own lines.
    expect(lines.map((l) => l.flags)).toEqual([
      ["missing_grade", "possible_duplicate"],
      ["missing_grade"],
      [],
      ["missing_grade", "possible_duplicate"],
    ]);
  });

  it("clamps confidence to [0, 1]", () => {
    const doc = textDoc("W12x26\nC12x30");
    const [high, low] = run(doc, [
      modelLine("W12x26", doc, { product_type: "W12x26", confidence: 1.4 }),
      modelLine("C12x30", doc, { product_type: "C12x30", confidence: -0.2 }),
    ]);
    expect(high.confidence).toBe(1);
    expect(low.confidence).toBe(0);
  });

  it("repairs a span that is off by a few characters and reports an unlocatable one", () => {
    const doc = textDoc("Caleb,\n\nW12x26 x 50' qty 8\n\nThanks");
    const raw = "W12x26 x 50' qty 8";
    const good = doc.text.indexOf(raw);
    const [repaired, lost] = run(doc, [
      { ...modelLine(raw, doc), span: { start: good + 4, end: good + raw.length + 4 } },
      // An absolute hint inside the source segment that names text the document does not hold.
      { ...modelLine("C12x30 x 40' qty 6", doc), span: { start: SOURCE_TEXT_HEADER.length + 7, end: SOURCE_TEXT_HEADER.length + 25 } },
    ]);
    expect(repaired.span_verified).toBe(true);
    expect(repaired.source_span).toEqual({ kind: "text", start: 8, end: 8 + raw.length });
    expect(lost.span_verified).toBe(false);
    expect(lost.source_span).toEqual({ kind: "text", start: 7, end: 25 });
  });

  it("maps a line from an attachment page to an attachment span", () => {
    const page = "Item Description Qty Length Grade\nHSS4x4x1/4 4x4x1/4 square tube 30 pcs 24' A500 Gr B\nPIPE2STD 2\" sch 40 pipe 12 pcs 21' A53 Gr B";
    const doc = buildExtractionDocument([
      { kind: "text", text: "See attached list." },
      { kind: "attachment", attachmentId: "fixture-attachment-1", filename: "bryan-shop-list.pdf", page: 1, text: page },
    ]);
    const hssRaw = "HSS4x4x1/4 4x4x1/4 square tube 30 pcs 24' A500 Gr B";
    const pipeRaw = "PIPE2STD 2\" sch 40 pipe 12 pcs 21' A53 Gr B";
    const [hss, pipe] = run(doc, [
      modelLine(hssRaw, doc, {
        product_type: "HSS4x4x1/4",
        category: "hss_square",
        dims: [
          { key: "a", value: "4" },
          { key: "b", value: "4" },
          { key: "t", value: "1/4" },
        ],
        qty: 30,
        unit: "pcs",
        length_text: "24'",
        grade_spec: "A500 Gr B",
      }),
      modelLine(pipeRaw, doc, {
        product_type: "2\" sch 40 pipe",
        category: "pipe",
        dims: [
          { key: "nps", value: "2" },
          { key: "sch", value: "40" },
        ],
        qty: 12,
        unit: "pcs",
        length_text: "21'",
        grade_spec: "A53 Gr B",
      }),
    ]);
    expect(hss.catalog_item_id).toBe("HSS4x4x1/4");
    expect(hss.source_span).toEqual({
      kind: "attachment",
      attachment_id: "fixture-attachment-1",
      page: 1,
      start: page.indexOf(hssRaw),
      end: page.indexOf(hssRaw) + hssRaw.length,
    });
    expect(hss.flags).toEqual([]);
    expect(pipe).toMatchObject({ catalog_item_id: "PIPE2STD", description: "PIPE2STD", category: "pipe", length_ft: 21, flags: [] });
    expect(pipe.source_span).toMatchObject({ kind: "attachment", page: 1, start: page.indexOf(pipeRaw) });
  });

  it("drops a non-positive quantity and blank strings to null", () => {
    const doc = textDoc("W12x26 qty 0");
    const [line] = run(doc, [
      modelLine("W12x26 qty 0", doc, { product_type: "W12x26", qty: 0, grade_spec: "  ", length_text: " ", delivery_notes: "" }),
    ]);
    expect(line).toMatchObject({ qty: null, grade_spec: null, length_text: null, length_ft: null, delivery_notes: null });
    expect(line.flags).toEqual(["missing_grade", "missing_qty", "missing_length"]);
  });

  it("keeps the alternate_mentioned flag the model set even without alternates listed", () => {
    const doc = textDoc("W12x26 or heavier");
    const [line] = run(doc, [modelLine("W12x26 or heavier", doc, { product_type: "W12x26", flags: ["alternate_mentioned"] })]);
    expect(line.flags).toContain("alternate_mentioned");
    expect(line.alternates_mentioned).toEqual([]);
  });
});

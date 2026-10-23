import { describe, expect, it } from "vitest";
import { buildManualRequest, manualLineInputSchema, manualLinesInputSchema, type ManualLineInput } from "./manual";

const three: ManualLineInput[] = [
  { description: "W12x26", qty: 8, unit: "pcs", length_text: "50'", grade_spec: "A992", notes: null },
  { description: "L2x2x1/4 angle", qty: 40, unit: "pcs", length_text: "20 ft", grade_spec: null, notes: "clips" },
  { description: "3/8 plate 48x96", qty: 10, unit: null, length_text: null, grade_spec: "A36", notes: "  " },
];

describe("buildManualRequest", () => {
  it("writes one source line per input in the agreed shape", () => {
    const { source_text } = buildManualRequest(three);
    expect(source_text).toBe(["8 pcs W12x26 x 50' A992", "40 pcs L2x2x1/4 angle x 20 ft", "10 3/8 plate 48x96 A36"].join("\n"));
  });

  it("gives every line a span that slices back to exactly its raw_text", () => {
    const { source_text, lines } = buildManualRequest(three);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.source_span.kind).toBe("text");
      expect(source_text.slice(line.source_span.start, line.source_span.end)).toBe(line.raw_text);
    }
    expect(lines.map((l) => l.line_no)).toEqual([1, 2, 3]);
    expect(lines[0].source_span).toEqual({ kind: "text", start: 0, end: "8 pcs W12x26 x 50' A992".length });
    expect(lines[1].source_span.start).toBe(lines[0].source_span.end + 1);
    expect(lines[2].source_span.end).toBe(source_text.length);
  });

  it("derives length_ft from length_text and keeps the text", () => {
    const { lines } = buildManualRequest(three);
    expect(lines[0].length_text).toBe("50'");
    expect(lines[0].length_ft).toBe(50);
    expect(lines[1].length_text).toBe("20 ft");
    expect(lines[1].length_ft).toBe(20);
    expect(lines[2].length_text).toBeNull();
    expect(lines[2].length_ft).toBeNull();

    const [unreadable] = buildManualRequest([
      { description: "W12x26", qty: 1, unit: "pcs", length_text: "random", grade_spec: null, notes: null },
    ]).lines;
    expect(unreadable.length_text).toBe("random");
    expect(unreadable.length_ft).toBeNull();
  });

  it("carries the other fields through without defaults", () => {
    const { lines } = buildManualRequest(three);
    expect(lines[0]).toMatchObject({ description: "W12x26", qty: 8, unit: "pcs", grade_spec: "A992", delivery_notes: null });
    expect(lines[1]).toMatchObject({ qty: 40, unit: "pcs", grade_spec: null, delivery_notes: "clips" });
    expect(lines[2]).toMatchObject({ qty: 10, unit: null, grade_spec: "A36", delivery_notes: null });
  });

  it("treats blank strings as null and trims the description", () => {
    const { source_text, lines } = buildManualRequest([
      { description: "  C12x30  ", qty: null, unit: null, length_text: "   ", grade_spec: "", notes: "" },
    ]);
    expect(source_text).toBe("C12x30");
    expect(lines[0]).toMatchObject({
      raw_text: "C12x30",
      description: "C12x30",
      qty: null,
      unit: null,
      length_text: null,
      length_ft: null,
      grade_spec: null,
      delivery_notes: null,
      source_span: { kind: "text", start: 0, end: 6 },
    });
  });

  it("keeps each line on one line even when the input has line breaks", () => {
    const { source_text, lines } = buildManualRequest([
      { description: "W12x26\nwide flange", qty: 2, unit: "pcs", length_text: null, grade_spec: null, notes: null },
      { description: "C12x30", qty: 1, unit: "pcs", length_text: null, grade_spec: null, notes: null },
    ]);
    expect(source_text).toBe("2 pcs W12x26 wide flange\n1 pcs C12x30");
    expect(source_text.slice(lines[1].source_span.start, lines[1].source_span.end)).toBe("1 pcs C12x30");
  });

  it("returns an empty request for no lines", () => {
    expect(buildManualRequest([])).toEqual({ source_text: "", lines: [] });
  });
});

describe("manualLineInputSchema", () => {
  const valid: ManualLineInput = { description: "W12x26", qty: 8, unit: "pcs", length_text: "50'", grade_spec: null, notes: null };

  it("accepts a complete line and a line with nulls", () => {
    expect(manualLineInputSchema.parse(valid)).toEqual(valid);
    const sparse: ManualLineInput = { description: "x", qty: null, unit: null, length_text: null, grade_spec: null, notes: null };
    expect(manualLineInputSchema.parse(sparse)).toEqual(sparse);
  });

  it("requires a non-blank description", () => {
    expect(manualLineInputSchema.safeParse({ ...valid, description: "" }).success).toBe(false);
    expect(manualLineInputSchema.safeParse({ ...valid, description: "   " }).success).toBe(false);
    expect(manualLineInputSchema.parse({ ...valid, description: "  W12x26 " }).description).toBe("W12x26");
  });

  it("requires qty to be positive or null", () => {
    expect(manualLineInputSchema.safeParse({ ...valid, qty: 0 }).success).toBe(false);
    expect(manualLineInputSchema.safeParse({ ...valid, qty: -1 }).success).toBe(false);
    expect(manualLineInputSchema.safeParse({ ...valid, qty: "8" }).success).toBe(false);
    expect(manualLineInputSchema.safeParse({ ...valid, qty: 0.5 }).success).toBe(true);
  });

  it("requires unit to be a line_unit or null", () => {
    expect(manualLineInputSchema.safeParse({ ...valid, unit: "each" }).success).toBe(false);
    expect(manualLineInputSchema.safeParse({ ...valid, unit: "ft" }).success).toBe(true);
  });

  it("manualLinesInputSchema needs at least one line", () => {
    expect(manualLinesInputSchema.safeParse([]).success).toBe(false);
    expect(manualLinesInputSchema.safeParse([valid]).success).toBe(true);
  });
});

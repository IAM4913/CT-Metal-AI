// Manual entry: the lines Caleb types on /requests/new, turned into a request.
//
// buildManualRequest() writes one source line per input so the manual request
// has the same shape as a pasted one: a source_text the Review tab can show and
// a source_span per line that slices back to exactly that line's text. The
// line text is "<qty> <unit> <description> x <length_text> <grade>" with only
// the present parts, joined by single spaces. length_ft comes from
// parseLengthFt(length_text); nothing else is derived or defaulted.
//
// No catalog lookup happens here. Step 4 does alias lookup and category
// inference when it normalizes; a manual line starts with catalog_item_id null,
// category null, and the unmatched_item flag.

import { z } from "zod";
import { lineUnitSchema, type LineUnit } from "@/lib/db/enums";
import { parseLengthFt } from "./length";

export type ManualLineInput = {
  description: string;
  qty: number | null;
  unit: LineUnit | null;
  length_text: string | null;
  grade_spec: string | null;
  notes: string | null;
};

export const manualLineInputSchema = z.object({
  description: z.string().trim().min(1, "Description is required"),
  qty: z.number().positive().nullable(),
  unit: lineUnitSchema.nullable(),
  length_text: z.string().nullable(),
  grade_spec: z.string().nullable(),
  notes: z.string().nullable(),
});

export const manualLinesInputSchema = z.array(manualLineInputSchema).min(1, "Add at least one line");

export type ManualBuiltLine = {
  line_no: number;
  raw_text: string;
  description: string;
  qty: number | null;
  unit: LineUnit | null;
  length_text: string | null;
  length_ft: number | null;
  grade_spec: string | null;
  delivery_notes: string | null;
  source_span: { kind: "text"; start: number; end: number };
};

function clean(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// One line of source text, internal whitespace collapsed so the line stays one line.
function formatLine(line: {
  description: string;
  qty: number | null;
  unit: LineUnit | null;
  length_text: string | null;
  grade_spec: string | null;
}): string {
  const parts: string[] = [];
  if (line.qty !== null) parts.push(String(line.qty));
  if (line.unit !== null) parts.push(line.unit);
  parts.push(line.description);
  if (line.length_text !== null) parts.push(`x ${line.length_text}`);
  if (line.grade_spec !== null) parts.push(line.grade_spec);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function buildManualRequest(lines: ManualLineInput[]): { source_text: string; lines: ManualBuiltLine[] } {
  let source_text = "";
  const built: ManualBuiltLine[] = [];

  lines.forEach((input, i) => {
    const description = input.description.trim();
    const length_text = clean(input.length_text);
    const grade_spec = clean(input.grade_spec);
    const raw_text = formatLine({ description, qty: input.qty, unit: input.unit, length_text, grade_spec });

    if (i > 0) source_text += "\n";
    const start = source_text.length;
    source_text += raw_text;
    const end = source_text.length;

    built.push({
      line_no: i + 1,
      raw_text,
      description,
      qty: input.qty,
      unit: input.unit,
      length_text,
      length_ft: parseLengthFt(length_text),
      grade_spec,
      delivery_notes: clean(input.notes),
      source_span: { kind: "text", start, end },
    });
  });

  return { source_text, lines: built };
}

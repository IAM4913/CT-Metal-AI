// Request line flags (PRD AC-2.2), computed by code, never by the model.
//
// computeLineFlags() applies the rules below to one normalized line and returns
// the flags in requestLineFlagValues order so stored arrays are stable and
// comparable in tests. possible_duplicate is a cross-line flag and comes from
// markPossibleDuplicates() instead.
//
//   missing_qty          qty is null
//   missing_grade        grade_spec is null or blank
//   missing_length       length_ft is null, length_text is null or blank, and
//                        the category is neither plate nor sheet (flat stock is
//                        sold by sheet size, not length)
//   unmatched_item       catalog_item_id is null
//   alternate_mentioned  alternates_mentioned is non-empty
//   ambiguous_size       passed through when true
//   ambiguous_unit       passed through when true
//
// manualDuplicateDims() gives markPossibleDuplicates() a key for lines typed by
// hand, which have no section dims; parsedDuplicateDims() adds the length and
// grade to a parsed line's key, since a designation's section dims alone cannot
// tell two W12x26 lines in different lengths apart.

import { normalizeAlias } from "@/lib/catalog/normalize";
import {
  requestLineFlagValues,
  type LineUnit,
  type MaterialCategory,
  type RequestLineFlag,
} from "@/lib/db/enums";

export type FlagInput = {
  qty: number | null;
  unit: LineUnit | null;
  length_ft: number | null;
  length_text: string | null;
  grade_spec: string | null;
  catalog_item_id: string | null;
  category: MaterialCategory | null;
  alternates_mentioned: string[];
  ambiguous_size: boolean;
  ambiguous_unit: boolean;
};

const LENGTHLESS_CATEGORIES: ReadonlySet<MaterialCategory> = new Set<MaterialCategory>(["plate", "sheet"]);

/**
 * Plate and sheet are bought by sheet size, not by length: no missing_length
 * flag, and the parser never reads a length for them out of the raw text (a
 * "4' x 8'" there is the sheet).
 */
export function isLengthlessCategory(category: MaterialCategory | null): boolean {
  return category !== null && LENGTHLESS_CATEGORIES.has(category);
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/** Sort flags into requestLineFlagValues order and drop repeats. */
export function orderFlags(flags: Iterable<RequestLineFlag>): RequestLineFlag[] {
  const present = new Set(flags);
  return requestLineFlagValues.filter((f) => present.has(f));
}

export function computeLineFlags(input: FlagInput): RequestLineFlag[] {
  const flags = new Set<RequestLineFlag>();
  if (input.qty === null) flags.add("missing_qty");
  if (isBlank(input.grade_spec)) flags.add("missing_grade");
  if (input.length_ft === null && isBlank(input.length_text) && !isLengthlessCategory(input.category)) {
    flags.add("missing_length");
  }
  if (input.catalog_item_id === null) flags.add("unmatched_item");
  if (input.alternates_mentioned.length > 0) flags.add("alternate_mentioned");
  if (input.ambiguous_size) flags.add("ambiguous_size");
  if (input.ambiguous_unit) flags.add("ambiguous_unit");
  return orderFlags(flags);
}

// JSON with keys sorted at every level, so {a:"8",t:"5/8"} and {t:"5/8",a:"8"}
// compare equal.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function duplicateKey(line: { description: string; dims: Record<string, unknown> }): string {
  return `${normalizeAlias(line.description)}|${stableJson(line.dims)}`;
}

function foldText(value: string | null): string | null {
  if (value === null) return null;
  const folded = value.trim().toLowerCase().replace(/\s+/g, " ");
  return folded === "" ? null : folded;
}

/**
 * Duplicate key fields for a line the broker typed (createManualRequest).
 * A manual line has no section dims yet, so with dims {} the key would be
 * the description alone and two W12x26 lines in different lengths, grades,
 * or quantities would both be flagged. The typed fields stand in: qty, unit,
 * the parsed length in feet (or the length text when it did not parse), and
 * the grade, case and spacing folded. For the key only; stored dims stay {}.
 */
export function manualDuplicateDims(line: {
  qty: number | null;
  unit: LineUnit | null;
  length_ft: number | null;
  length_text: string | null;
  grade_spec: string | null;
}): Record<string, unknown> {
  return {
    qty: line.qty,
    unit: line.unit,
    length: line.length_ft ?? foldText(line.length_text),
    grade: foldText(line.grade_spec),
  };
}

/**
 * Duplicate key fields for a parsed line (normalizeExtractedLines), used beside
 * its section dims. For a linked line the description is the designation and
 * the section dims follow from it, so on dims alone two W12x26 lines in
 * different lengths or grades would both be flagged; the length (feet, or the
 * text when it did not parse) and the folded grade tell them apart, as they do
 * for manual lines. Quantity and unit stay out of this key: the same item
 * listed twice with different counts is the repeat the flag exists for, and a
 * unit the code inferred from a piece word must not split a pair. For the key
 * only; stored dims are unchanged.
 */
export function parsedDuplicateDims(line: {
  length_ft: number | null;
  length_text: string | null;
  grade_spec: string | null;
}): Record<string, unknown> {
  return {
    length: line.length_ft ?? foldText(line.length_text),
    grade: foldText(line.grade_spec),
  };
}

/**
 * Adds possible_duplicate to every line whose normalized description plus dims
 * matches another line's. Lines are not mutated; changed lines are copied with
 * their flags re-ordered. Line order is preserved.
 */
export function markPossibleDuplicates<
  T extends { description: string; dims: Record<string, unknown>; flags: RequestLineFlag[] },
>(lines: T[]): T[] {
  const keys = lines.map(duplicateKey);
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return lines.map((line, i) => {
    if ((counts.get(keys[i]) ?? 0) < 2 || line.flags.includes("possible_duplicate")) return line;
    return { ...line, flags: orderFlags([...line.flags, "possible_duplicate"]) };
  });
}

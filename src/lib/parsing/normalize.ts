// Deterministic pass over the model's extract_material_lines output.
//
// The model returned strings and judgments; this module turns them into the
// request_lines shape with code only. No LLM, no I/O. Steps per line, in order:
//
//   1. span          locateSpan verifies or repairs the model's offsets, then
//                    toSourceSpan expresses them relative to the segment (the
//                    source text, or an attachment page).
//   2. dims          {key, value} pairs become an object; a value becomes a
//                    number through parseFraction when it parses ("5/8" -> 0.625,
//                    "48" -> 48) and stays a trimmed string otherwise ("C", "STD").
//   3. unit          the model's enum value. A null unit beside a quantity
//                    becomes "pcs" only when raw_text contains a piece word
//                    (pcs, pc, pieces, piece, ea, each). Otherwise it stays null
//                    and the line carries ambiguous_unit.
//   4. catalog       lookupItem over [designation built from category and dims,
//                    product_type, raw_text]. A match sets catalog_item_id and
//                    overrides the model's category with the item's; the
//                    description becomes the designation. A pipe schedule names
//                    a wall class only through the sizes where the two coincide
//                    (sch 40 is STD through NPS 10, sch 80 is XS through NPS 8,
//                    the cutoffs src/lib/catalog/generate.ts uses); past them no
//                    designation is built and the line stays unmatched.
//   5. length        length_ft from the model when given; else parseLengthFt on
//                    length_text; else, for products sold by length (never plate
//                    or sheet, which are bought by sheet size), parseLengthFt on
//                    a token in raw_text that carries an explicit foot or inch
//                    marker (40', 12 1/2 ft, x 480") and sits where a length
//                    sits, not inside a size chain (1/4" x 2" flat bar). A bare
//                    number is never a length.
//   6. flags         computeLineFlags (missing_*, unmatched_item, alternate_mentioned,
//                    ambiguous passthrough) merged with the model's judgment flags,
//                    then markPossibleDuplicates across lines, in enum order.
//                    ambiguous_unit stands only while the unit is null, the same
//                    rule src/lib/server/review.ts applies on every edit.
//                    possible_duplicate means the same item at the same length
//                    and grade (parsedDuplicateDims), not merely the same section.
//   7. confidence    clamped to [0, 1].
//
// Nothing here fills a grade, quantity, or length. Missing stays null plus a flag.

import { formatFraction, parseFraction } from "@/lib/catalog/normalize";
import type { LineUnit, MaterialCategory, RequestLineFlag } from "@/lib/db/enums";
import { lookupItem, type AliasIndex } from "./alias-index";
import { locateSpan, toSourceSpan, type ExtractionDocument, type SourceSpan } from "./document";
import {
  computeLineFlags,
  isLengthlessCategory,
  markPossibleDuplicates,
  orderFlags,
  parsedDuplicateDims,
} from "./flags";
import { LENGTH_QUANTITY, parseLengthFt } from "./length";
import type { ExtractedLine, ExtractMaterialLinesOutput } from "./schema";

export type NormalizedLine = {
  line_no: number;
  raw_text: string;
  description: string;
  product_type: string | null;
  category: MaterialCategory | null;
  catalog_item_id: string | null;
  dims: Record<string, number | string>;
  grade_spec: string | null;
  qty: number | null;
  unit: LineUnit | null;
  length_ft: number | null;
  length_text: string | null;
  cut_to_length: boolean;
  delivery_notes: string | null;
  alternates_mentioned: string[];
  flags: RequestLineFlag[];
  confidence: number;
  source_span: SourceSpan;
  span_verified: boolean;
};

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** {key, value} pairs to an object; numeric strings and fractions become numbers. */
export function dimsToObject(pairs: Array<{ key: string; value: string }>): Record<string, number | string> {
  const dims: Record<string, number | string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (key === "") continue;
    const text = pair.value.trim();
    if (text === "") continue;
    const parsed = parseFraction(text);
    dims[key] = parsed === null ? text : parsed;
  }
  return dims;
}

const PIECE_WORD = /\b(?:pcs|pc|pieces|piece|ea|each)\b/i;

/**
 * A count with no unit becomes "pcs" only when the text says so with a piece
 * word. Anything else keeps the model's unit (or null).
 */
export function inferUnit(unit: LineUnit | null, qty: number | null, rawText: string): LineUnit | null {
  if (unit !== null) return unit;
  if (qty === null) return null;
  return PIECE_WORD.test(rawText) ? "pcs" : null;
}

const FOOT_MARK = `(?:['’′]|ft\\b\\.?|feet\\b|foot\\b)`;
const INCH_MARK = `(?:["”″]|in\\b\\.?|inches\\b)`;

// A number with a foot marker, optionally followed by inches: 40', 40 ft, 40ft.,
// 40 feet, 12-1/2', 12 1/2', 20'6", 40'-0", 20' 6 1/2", 40 ft 6 in. Curly quotes
// and the prime are accepted. The number grammar is parseLengthFt's own
// (LENGTH_QUANTITY), so a spaced mixed number is one number here as it is there.
const FOOT_TOKEN = new RegExp(
  `${LENGTH_QUANTITY}\\s?${FOOT_MARK}(?:\\s?-?\\s?${LENGTH_QUANTITY}\\s?${INCH_MARK})?`,
  "gi",
);
// An inch-marked number after "x", "@", or "at" ("x 480\"", "at 240 in"), the
// connector captured. "6\" sq 3/8" has no connector and is a size, not a length.
const INCH_LENGTH_TOKEN = new RegExp(`(\\bx|@|\\bat)\\s*(\\d+(?:\\.\\d+)?\\s?${INCH_MARK})`, "gi");

// A size chain is "A x B x C" where the operands are bare sizes. The guards
// below keep a marked number out of length_ft when it is the next operand of
// such a chain rather than a length:
//
//   SIZE_BEFORE_X   the operand before the "x" is a bare size (a number,
//                   decimal, or fraction, inch-marked or not): in `1/4" x 2"
//                   flat bar`, `3/8 x 4" flat bar`, and `plate 3/8 x 48 x 96"`
//                   the inch token is a dimension. `HSS4x4x1/4 x 480"` and
//                   `angle x 480"` pass: a designation or a word precedes the x.
//   FEET_BEFORE_X   the operand before the "x" is itself foot-marked: `4' x 8'`
//                   is a sheet size. `3/8 x 24'` passes: a wall, then the length.
//   CHAINED_AFTER   another "x" operand or a wall or thickness word follows the
//                   token: `6 x 6" x 3/8 wall`, `4' x 8' plate`.
const SIZE_BEFORE_X = new RegExp(`(?:^|\\s)${LENGTH_QUANTITY}\\s?(?:["”″]|in\\.?|inch(?:es)?)?\\s*x\\s*$`, "i");
const FEET_BEFORE_X = new RegExp(`(?:^|\\s)${LENGTH_QUANTITY}\\s?${FOOT_MARK}\\s*x\\s*$`, "i");
const CHAINED_AFTER = /^\s*(?:x\s*\S|wall\b|wl\b|thk\b|thick(?:ness)?\b)/i;

function footTokenIsLength(rawText: string, start: number, end: number): boolean {
  return !CHAINED_AFTER.test(rawText.slice(end)) && !FEET_BEFORE_X.test(rawText.slice(0, start));
}

function inchTokenIsLength(rawText: string, connector: string, start: number, end: number): boolean {
  if (CHAINED_AFTER.test(rawText.slice(end))) return false;
  // "x" joins sizes as readily as it introduces a length; "@" and "at" do not.
  if (connector.toLowerCase() !== "x") return true;
  return !SIZE_BEFORE_X.test(rawText.slice(0, start + connector.length));
}

/**
 * The first length in raw_text that carries an explicit foot or inch marker and
 * stands where a length stands (see the guards above), parsed by parseLengthFt.
 * Returns the token verbatim as length_text so the reviewer sees where the
 * number came from. Null when the text has no such length; a bare number is
 * never read as one, and neither is a marked number inside a size chain
 * (`1/4" x 2" flat bar`, `6" x 6" x 3/8" wall`, `plate 3/8" x 48" x 96"`).
 */
export function lengthFromRawText(rawText: string): { length_ft: number; length_text: string } | null {
  for (const match of rawText.matchAll(FOOT_TOKEN)) {
    const start = match.index;
    if (!footTokenIsLength(rawText, start, start + match[0].length)) continue;
    const token = match[0].trim();
    const feet = parseLengthFt(token);
    if (feet !== null) return { length_ft: feet, length_text: token };
  }
  for (const match of rawText.matchAll(INCH_LENGTH_TOKEN)) {
    const start = match.index;
    if (!inchTokenIsLength(rawText, match[1], start, start + match[0].length)) continue;
    const token = match[2].trim();
    const feet = parseLengthFt(token);
    if (feet !== null) return { length_ft: feet, length_text: token };
  }
  return null;
}

function num(dims: Record<string, number | string>, key: string): number | null {
  const value = dims[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function str(dims: Record<string, number | string>, key: string): string | null {
  const value = dims[key];
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Plain decimal for depths and weights: 26 -> "26", 31.8 -> "31.8", 11.5 -> "11.5". */
function dec(n: number): string {
  return String(Number(n.toFixed(4)));
}

type PipeClass = "STD" | "XS" | "XXS";

// A wall class word, or a schedule number that names a wall class only through
// the sizes where the two coincide (ASME B36.10, the same cutoffs
// src/lib/catalog/generate.ts applies to its "sch" aliases): schedule 40 is STD
// through NPS 10 and schedule 80 is XS through NPS 8. A 12" sch 40 pipe is
// 0.406 wall, PIPE12STD is 0.375; a 10" sch 80 is 0.594, PIPE10XS is 0.500.
type PipeClassWord = { cls: PipeClass; max_nps: number | null };
const STD: PipeClassWord = { cls: "STD", max_nps: null };
const XS: PipeClassWord = { cls: "XS", max_nps: null };
const XXS: PipeClassWord = { cls: "XXS", max_nps: null };
const SCH_40: PipeClassWord = { cls: "STD", max_nps: 10 };
const SCH_80: PipeClassWord = { cls: "XS", max_nps: 8 };

const PIPE_CLASS_WORDS: ReadonlyMap<string, PipeClassWord> = new Map([
  ["std", STD],
  ["standard", STD],
  ["standard weight", STD],
  ["std wt", STD],
  ["40", SCH_40],
  ["sch 40", SCH_40],
  ["sch40", SCH_40],
  ["schedule 40", SCH_40],
  ["xs", XS],
  ["xh", XS],
  ["extra strong", XS],
  ["extra heavy", XS],
  ["80", SCH_80],
  ["sch 80", SCH_80],
  ["sch80", SCH_80],
  ["schedule 80", SCH_80],
  ["xxs", XXS],
  ["xxh", XXS],
  ["double extra strong", XXS],
  ["double extra heavy", XXS],
]);

/**
 * The wall class the dims name for a pipe of this NPS, or null when they name
 * none, or name a schedule past the size where it still means STD or XS. In
 * that case no designation is built and the line stays unmatched_item for the
 * broker to link: a confident wrong wall is worse than a miss.
 */
function pipeClass(nps: number, dims: Record<string, number | string>): PipeClass | null {
  for (const key of ["schedule", "sch", "class", "wall_class"]) {
    const value = str(dims, key);
    if (value === null) continue;
    const word = PIPE_CLASS_WORDS.get(value.toLowerCase().replace(/\s+/g, " ").trim());
    if (!word) continue;
    if (word.max_nps !== null && nps > word.max_nps) return null;
    return word.cls;
  }
  return null;
}

/**
 * Canonical designations the category plus dims could name, in the formats
 * src/lib/catalog/generate.ts uses. Empty when the dims do not carry enough.
 * Sides and legs are ordered largest first, as the catalog does.
 */
export function designationCandidates(
  category: MaterialCategory | null,
  dims: Record<string, number | string>,
): string[] {
  if (category === null) return [];
  const f = formatFraction;
  switch (category) {
    case "hss_square":
    case "hss_rectangular": {
      const a = num(dims, "a");
      const b = num(dims, "b") ?? (category === "hss_square" ? a : null);
      const t = num(dims, "t");
      if (a === null || b === null || t === null) return [];
      const [big, small] = a >= b ? [a, b] : [b, a];
      return [`HSS${f(big)}x${f(small)}x${f(t)}`];
    }
    case "hss_round": {
      const t = num(dims, "t");
      if (t === null) return [];
      const out: string[] = [];
      for (const key of ["nominal", "od", "d", "a"]) {
        const size = num(dims, key);
        if (size !== null) out.push(`HSS${f(size)}x${f(t)}`);
      }
      return Array.from(new Set(out));
    }
    case "pipe": {
      const nps = num(dims, "nps") ?? num(dims, "size");
      if (nps === null) return [];
      const cls = pipeClass(nps, dims);
      if (cls === null) return [];
      return [`PIPE${f(nps)}${cls}`];
    }
    case "w_beam":
    case "s_beam": {
      const d = num(dims, "d");
      const wt = num(dims, "wt");
      if (d === null || wt === null) return [];
      return [`${category === "w_beam" ? "W" : "S"}${dec(d)}x${dec(wt)}`];
    }
    case "channel": {
      const d = num(dims, "d");
      const wt = num(dims, "wt");
      if (d === null || wt === null) return [];
      const series = (str(dims, "series") ?? "C").toUpperCase();
      return [`${series === "MC" ? "MC" : "C"}${dec(d)}x${dec(wt)}`];
    }
    case "angle": {
      const a = num(dims, "a");
      const b = num(dims, "b") ?? a;
      const t = num(dims, "t");
      if (a === null || b === null || t === null) return [];
      const [big, small] = a >= b ? [a, b] : [b, a];
      return [`L${f(big)}x${f(small)}x${f(t)}`];
    }
    case "flat_bar": {
      const t = num(dims, "t");
      const w = num(dims, "w");
      if (t === null || w === null) return [];
      return [`FB${f(t)}x${f(w)}`];
    }
    case "round_bar": {
      const d = num(dims, "d");
      return d === null ? [] : [`RB${f(d)}`];
    }
    case "square_bar": {
      const a = num(dims, "a");
      return a === null ? [] : [`SQ${f(a)}`];
    }
    case "plate": {
      const t = num(dims, "t");
      return t === null ? [] : [`PL${f(t)}`];
    }
    case "sheet": {
      const gauge = num(dims, "gauge");
      return gauge === null ? [] : [`SH${dec(gauge)}GA`];
    }
    case "rebar": {
      const bar = num(dims, "bar_number") ?? num(dims, "bar");
      return bar === null ? [] : [`REBAR#${dec(bar)}`];
    }
  }
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function positiveOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

function normalizeOne(line: ExtractedLine, lineNo: number, doc: ExtractionDocument, index: AliasIndex): NormalizedLine {
  // 1. span
  const located = locateSpan(doc, line.raw_text, line.span);
  const source_span = toSourceSpan(doc, located);

  // 2. dims
  const dims = dimsToObject(line.dims);

  // 3. qty and unit
  const qty = positiveOrNull(line.qty);
  const unit = inferUnit(line.unit, qty, line.raw_text);

  // 4. catalog
  const product_type = clean(line.product_type);
  const candidates = [...designationCandidates(line.category, dims), product_type ?? "", line.raw_text];
  const item = lookupItem(index, candidates);
  const catalog_item_id = item ? item.catalog_item_id : null;
  const category = item ? item.category : line.category;
  const description = item ? item.designation : (product_type ?? clean(line.raw_text) ?? "(no text)");

  // 5. length. The raw_text fallback waits for the category: plate and sheet are
  //    bought by sheet size, and a "4' x 8'" or "x 96\"" there is the sheet, not
  //    a length, so for them the model's nulls stand.
  let length_ft = positiveOrNull(line.length_ft);
  let length_text = clean(line.length_text);
  if (length_ft === null && length_text !== null) {
    length_ft = parseLengthFt(length_text);
  }
  if (length_ft === null && length_text === null && !isLengthlessCategory(category)) {
    const fromRaw = lengthFromRawText(line.raw_text);
    if (fromRaw) {
      length_ft = fromRaw.length_ft;
      length_text = fromRaw.length_text;
    }
  }

  // 6. flags (possible_duplicate across lines is added by the caller).
  //    ambiguous_unit is settled here, not carried: it stands only while the
  //    unit is null, whether the model raised it or a count has no unit word.
  //    Once a unit is known (the model's, or "pcs" from a piece word) the flag
  //    is gone, as review.ts drops it on the first edit.
  const grade_spec = clean(line.grade_spec);
  const alternates_mentioned = line.alternates_mentioned.map((a) => a.trim()).filter((a) => a !== "");
  const judgment = new Set<RequestLineFlag>(line.flags);
  const computed = computeLineFlags({
    qty,
    unit,
    length_ft,
    length_text,
    grade_spec,
    catalog_item_id,
    category,
    alternates_mentioned,
    ambiguous_size: judgment.has("ambiguous_size"),
    ambiguous_unit: unit === null && (judgment.has("ambiguous_unit") || qty !== null),
  });
  const judgmentKept = [...judgment].filter((flag) => flag !== "ambiguous_unit");
  const flags = orderFlags([...computed, ...judgmentKept]);

  return {
    line_no: lineNo,
    raw_text: line.raw_text,
    description,
    product_type,
    category,
    catalog_item_id,
    dims,
    grade_spec,
    qty,
    unit,
    length_ft,
    length_text,
    cut_to_length: line.cut_to_length,
    delivery_notes: clean(line.delivery_notes),
    alternates_mentioned,
    flags,
    confidence: clampConfidence(line.confidence),
    source_span,
    span_verified: located.verified,
  };
}

export function normalizeExtractedLines(
  output: ExtractMaterialLinesOutput,
  doc: ExtractionDocument,
  index: AliasIndex,
): NormalizedLine[] {
  const lines = output.lines.map((line, i) => normalizeOne(line, i + 1, doc, index));
  // possible_duplicate: the same item at the same length and grade. The key is
  // the normalized description plus the section dims, as markPossibleDuplicates
  // builds it, widened with parsedDuplicateDims (length, folded grade) so that
  // two W12x26 lines in different lengths stay two lines, the rule the manual
  // path already follows. The widened dims exist for the key only; the stored
  // dims are the section dims.
  const keyed = markPossibleDuplicates(
    lines.map((line) => ({
      description: line.description,
      dims: { section: line.dims, ...parsedDuplicateDims(line) },
      flags: line.flags,
    })),
  );
  return lines.map((line, i) => ({ ...line, flags: keyed[i].flags }));
}

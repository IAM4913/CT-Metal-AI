// Deterministic pass over the model's extract_offer_lines output.
//
// The model returned strings and judgments; this module turns them into the
// vendor_offers and offer_lines shape with code only. No LLM, no I/O. Per line:
//
//   1. span            locateSpan verifies or repairs the model's offsets, then
//                      toSourceSpan expresses them relative to the segment (the
//                      reply text, or an attachment page).
//   2. request line    kept only when the id is one of the RFQ's context lines;
//                      anything else is null plus unmatched_line. Never reassigned.
//   3. price           unit_price = parseMoney(unit_price_text); the basis is the
//                      model's enum value. No conversion between bases here.
//   4. quantity        available_qty when positive and finite, else null.
//   5. ready date      parseReadyDate(ready_date_text, receivedAt) as yyyy-MM-dd;
//                      text that names no day ("mid November") is kept for the
//                      reviewer in delivery_estimate_text instead of being lost.
//   6. catalog         offered_catalog_item_id = lookupItem(index, candidates): the
//                      offered description as written, then without a trailing
//                      length fragment ("W12x26 x 50'" -> "W12x26", "C12x30 40'" ->
//                      "C12x30"; offeredItemCandidates), then the context line's
//                      designation when the line is an exact match. Table and PDF
//                      quotes write the length into the item, and Step 7's per_cwt,
//                      per_lb, and per_ton math needs the offered item's weight.
//   7. flags           computeOfferFlags (missing_price unless declined, missing_qty,
//                      missing_availability, unmatched_line, the model's judgment
//                      flags) then markOfferDuplicates across lines (same request
//                      line and offered description), in offerFlagValues order.
//   8. confidence      clamped to [0, 1].
//
// Meta: early pay from parseEarlyPay over early_pay_pct_text, else payment_terms
// (where the slash form needs a terms marker, so "Net 30, due 11/30" is not an
// 11 percent discount), with the model's early_pay_days standing in only when
// the parser finds no window; freight_amount = parseMoney(freight_amount_text); quote_expires_at =
// parseQuoteExpiry(quote_valid_text, receivedAt) as an ISO timestamp. Text the
// parsers could not read (a freight note, a validity phrase) is carried into
// notes so nothing the vendor wrote disappears.
//
// Nothing here fills a price, quantity, or date. Missing stays null plus a flag.

import { normalizeAlias } from "@/lib/catalog/normalize";
import type { AlternateType, Availability, FreightBasis, LineUnit, PriceBasis } from "@/lib/db/enums";
import { lookupItem, type AliasIndex } from "./alias-index";
import { locateSpan, toSourceSpan, type ExtractionDocument, type SourceSpan } from "./document";
import { parseEarlyPay, parseMoney, parseQuoteExpiry, parseReadyDate, toIsoDate } from "./money";
import type { OfferContextLine } from "./offers-prompt";
import { offerFlagValues, type ExtractedOfferLine, type ExtractOfferLinesOutput, type OfferFlag } from "./offers-schema";

export type NormalizedOfferLine = {
  request_line_id: string | null;
  raw_text: string;
  offered_desc: string;
  offered_catalog_item_id: string | null;
  is_exact_match: boolean;
  alternate_types: AlternateType[];
  available_qty: number | null;
  unit: LineUnit | null;
  availability: Availability;
  /** ISO date yyyy-MM-dd. */
  ready_date: string | null;
  delivery_estimate_text: string | null;
  unit_price: number | null;
  price_basis: PriceBasis | null;
  flags: OfferFlag[];
  confidence: number;
  source_span: SourceSpan;
  span_verified: boolean;
};

export type NormalizedOfferMeta = {
  declined: boolean;
  decline_reason: string | null;
  payment_terms: string | null;
  early_pay_pct: number | null;
  early_pay_days: number | null;
  freight_amount: number | null;
  freight_basis: FreightBasis;
  /** ISO timestamp. */
  quote_expires_at: string | null;
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests and for the manual-offer path)
// ---------------------------------------------------------------------------

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Sort flags into offerFlagValues order and drop repeats. */
export function orderOfferFlags(flags: Iterable<OfferFlag>): OfferFlag[] {
  const present = new Set(flags);
  return offerFlagValues.filter((f) => present.has(f));
}

export type OfferFlagInput = {
  request_line_id: string | null;
  unit_price: number | null;
  available_qty: number | null;
  availability: Availability;
  /** The offer as a whole is a decline: a line with no price is then not missing one. */
  declined: boolean;
  /** Judgment flags the model proposed (or a stored row carries): ambiguous_unit, ambiguous_basis, possible_duplicate. */
  judgment?: Iterable<OfferFlag>;
};

const JUDGMENT_FLAGS: ReadonlySet<OfferFlag> = new Set<OfferFlag>(["ambiguous_unit", "ambiguous_basis", "possible_duplicate"]);

/**
 * The flags of one offer line from its values, in offerFlagValues order:
 *   missing_price         unit_price null and the offer is not declined
 *   missing_qty           available_qty null (an unknown quantity is still unknown)
 *   missing_availability  availability unknown
 *   unmatched_line        request_line_id null
 * plus the judgment flags passed through. possible_duplicate across lines is
 * added by markOfferDuplicates().
 */
export function computeOfferFlags(input: OfferFlagInput): OfferFlag[] {
  const flags = new Set<OfferFlag>();
  if (input.unit_price === null && !input.declined) flags.add("missing_price");
  if (input.available_qty === null) flags.add("missing_qty");
  if (input.availability === "unknown") flags.add("missing_availability");
  if (input.request_line_id === null) flags.add("unmatched_line");
  for (const flag of input.judgment ?? []) {
    if (JUDGMENT_FLAGS.has(flag)) flags.add(flag);
  }
  return orderOfferFlags(flags);
}

/** The judgment flags among a stored row's flags (unknown strings dropped). */
export function carriedOfferFlags(flags: readonly string[]): OfferFlag[] {
  return flags.filter((f): f is OfferFlag => JUDGMENT_FLAGS.has(f as OfferFlag));
}

export type DuplicateSource = {
  request_line_id: string | null;
  offered_desc: string;
  /** When both lines link to the same catalog item they are the same offered item however it was spelled. */
  offered_catalog_item_id?: string | null;
  flags: OfferFlag[];
};

/**
 * The key two lines must share to be possible duplicates of each other: the
 * request line plus the offered item, folded (the catalog item when linked,
 * else the normalized description with whitespace removed). Null for an
 * untied line, which is never paired. The server recomputes duplicates after
 * an edit with the same key.
 */
export function offerDuplicateKey(line: Pick<DuplicateSource, "request_line_id" | "offered_desc" | "offered_catalog_item_id">): string | null {
  if (line.request_line_id === null) return null;
  const item = line.offered_catalog_item_id ?? null;
  const offered = item !== null ? `item:${item}` : `desc:${normalizeAlias(line.offered_desc).replace(/\s+/g, "")}`;
  return `${line.request_line_id}|${offered}`;
}

const duplicateKey = offerDuplicateKey;

/**
 * Adds possible_duplicate to every line that shares its request_line_id and
 * offered item (same catalog link, or the same description once normalized)
 * with another line. Unmatched lines (null id) are never paired. Lines are not
 * mutated; order is preserved.
 */
export function markOfferDuplicates<T extends DuplicateSource>(lines: T[]): T[] {
  const keys = lines.map(duplicateKey);
  const counts = new Map<string, number>();
  for (const key of keys) {
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return lines.map((line, i) => {
    const key = keys[i];
    if (key === null || (counts.get(key) ?? 0) < 2 || line.flags.includes("possible_duplicate")) return line;
    return { ...line, flags: orderOfferFlags([...line.flags, "possible_duplicate"]) };
  });
}

// A length written onto the end of an item: " x 50'", " 40'", " x 24 ft",
// " 40 feet", " x 20'-0"". Never a fraction (3/8) and never an unmarked number
// (a plate's "48x96" is a sheet size, not a length).
const TRAILING_LENGTH = /\s*(?:[x\u00d7]\s*)?\d+(?:\.\d+)?\s*(?:['\u2019]|ft\b\.?|feet\b|foot\b)(?:\s*-\s*\d+\s*(?:"|\u201d|in\b\.?))?\s*$/i;

/**
 * An offered description without a trailing length fragment: "W12x26 x 50'"
 * is "W12x26", "C12x30 40'" is "C12x30", "HSS6x6x3/8 x 24 ft" is "HSS6x6x3/8".
 * "HSS8x8x3/8" and "PL3/8 48x96 A36" are unchanged. The result is trimmed and
 * never empty: text that is only a length ("40'") comes back as it was.
 */
export function stripTrailingLength(text: string): string {
  const trimmed = text.trim();
  const stripped = trimmed.replace(TRAILING_LENGTH, "").trim();
  return stripped === "" ? trimmed : stripped;
}

/**
 * What to look the offered item up by, in order: the description as written,
 * the description without its trailing length, and the request line's
 * designation when the vendor offers exactly what was asked. Blanks and
 * repeats are dropped.
 */
export function offeredItemCandidates(offeredDesc: string, exactDesignation: string | null): string[] {
  const candidates = [offeredDesc, stripTrailingLength(offeredDesc), exactDesignation ?? ""];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function positiveOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

/** Join the non-blank parts with a separator, or null when none is left. */
function joinNotes(parts: Array<string | null>, separator = "\n"): string | null {
  const kept = parts.map(clean).filter((p): p is string => p !== null);
  return kept.length === 0 ? null : kept.join(separator);
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

/**
 * Early-pay terms: the pct text first, then the payment terms as a whole. The
 * model's early_pay_days is used only when neither text yields a window, and
 * only when a percentage was found (days without a discount mean nothing).
 */
export function normalizeEarlyPay(meta: {
  early_pay_pct_text: string | null;
  payment_terms: string | null;
  early_pay_days: number | null;
}): { pct: number | null; days: number | null } {
  const fromPctText = parseEarlyPay(meta.early_pay_pct_text);
  // The terms are a whole phrase: a month/day in them ("due 11/30") is not the slash form.
  const fromTerms = parseEarlyPay(meta.payment_terms, { slashNeedsNet: true });
  const pct = fromPctText.pct ?? fromTerms.pct;
  if (pct === null) return { pct: null, days: null };
  const parsedDays = fromPctText.pct !== null ? (fromPctText.days ?? fromTerms.days) : fromTerms.days;
  const modelDays =
    meta.early_pay_days !== null && Number.isInteger(meta.early_pay_days) && meta.early_pay_days > 0 ? meta.early_pay_days : null;
  return { pct, days: parsedDays ?? modelDays };
}

export function normalizeOfferMeta(output: ExtractOfferLinesOutput, receivedAt: Date): NormalizedOfferMeta {
  const meta = output.offer_meta;
  const earlyPay = normalizeEarlyPay(meta);
  const freightText = clean(meta.freight_amount_text);
  const freightAmount = parseMoney(freightText);
  const validText = clean(meta.quote_valid_text);
  const expiry = parseQuoteExpiry(validText, receivedAt);

  const notes = joinNotes([
    output.notes,
    meta.availability_remarks ? `Availability: ${meta.availability_remarks.trim()}` : null,
    freightText !== null && freightAmount === null ? `Freight: ${freightText}` : null,
    validText !== null && expiry === null ? `Quote validity: ${validText}` : null,
  ]);

  return {
    declined: meta.declined,
    decline_reason: clean(meta.decline_reason),
    payment_terms: clean(meta.payment_terms),
    early_pay_pct: earlyPay.pct,
    early_pay_days: earlyPay.days,
    freight_amount: freightAmount,
    freight_basis: meta.freight_basis,
    quote_expires_at: expiry === null ? null : expiry.toISOString(),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function normalizeOne(
  line: ExtractedOfferLine,
  doc: ExtractionDocument,
  context: ReadonlyMap<string, OfferContextLine>,
  index: AliasIndex,
  receivedAt: Date,
  declined: boolean,
): NormalizedOfferLine {
  // 1. span
  const located = locateSpan(doc, line.raw_text, line.span);
  const source_span = toSourceSpan(doc, located);

  // 2. request line: only an id from the context stands.
  const proposedId = clean(line.request_line_id);
  const contextLine = proposedId !== null ? (context.get(proposedId) ?? null) : null;
  const request_line_id = contextLine === null ? null : contextLine.request_line_id;

  // 3. price and 4. quantity
  const unit_price = parseMoney(line.unit_price_text);
  const available_qty = positiveOrNull(line.available_qty);

  // 5. ready date; unreadable date text is kept beside the line.
  const readyText = clean(line.ready_date_text);
  const readyDate = parseReadyDate(readyText, receivedAt);
  const delivery_estimate_text = joinNotes(
    [line.delivery_estimate_text, readyText !== null && readyDate === null ? `Ready: ${readyText}` : null],
    "; ",
  );

  // 6. catalog: as written, then without a trailing length, then the request
  // line's own designation when the vendor offers exactly what was asked.
  const offered_desc = clean(line.offered_desc) ?? clean(line.raw_text) ?? "(no text)";
  const exactDesignation = line.is_exact_match && contextLine !== null ? contextLine.designation : null;
  const item = lookupItem(index, offeredItemCandidates(offered_desc, exactDesignation));

  // 7. flags (possible_duplicate across lines is added by the caller)
  const flags = computeOfferFlags({
    request_line_id,
    unit_price,
    available_qty,
    availability: line.availability,
    declined,
    judgment: line.flags,
  });

  return {
    request_line_id,
    raw_text: line.raw_text,
    offered_desc,
    offered_catalog_item_id: item ? item.catalog_item_id : null,
    is_exact_match: line.is_exact_match,
    alternate_types: Array.from(new Set(line.alternate_types)),
    available_qty,
    unit: line.unit,
    availability: line.availability,
    ready_date: readyDate === null ? null : toIsoDate(readyDate),
    delivery_estimate_text,
    unit_price,
    price_basis: line.price_basis,
    flags,
    confidence: clampConfidence(line.confidence),
    source_span,
    span_verified: located.verified,
  };
}

export function normalizeOfferOutput(
  output: ExtractOfferLinesOutput,
  doc: ExtractionDocument,
  context: OfferContextLine[],
  index: AliasIndex,
  receivedAt: Date,
): { meta: NormalizedOfferMeta; lines: NormalizedOfferLine[] } {
  const meta = normalizeOfferMeta(output, receivedAt);
  const byId = new Map(context.map((line) => [line.request_line_id, line]));
  const lines = output.lines.map((line) => normalizeOne(line, doc, byId, index, receivedAt, meta.declined));
  return { meta, lines: markOfferDuplicates(lines) };
}

/**
 * The offer's confidence from its lines: the mean of the line confidences, 1
 * for a decline with no lines (the reply was read whole), 0 for an undeclined
 * reply with no lines (nothing was extracted).
 */
export function offerConfidence(lines: ReadonlyArray<{ confidence: number }>, declined: boolean): number {
  if (lines.length === 0) return declined ? 1 : 0;
  const sum = lines.reduce((total, line) => total + clampConfidence(line.confidence), 0);
  return clampConfidence(sum / lines.length);
}

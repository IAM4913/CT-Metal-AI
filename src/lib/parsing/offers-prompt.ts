// System prompt and user message for extract_offer_lines (PRD section 13 B).
//
// The reply is read against the RFQ's own lines: the user message lists them
// with their request_line_id so every offer line can point at the request line
// it answers, and the system prompt says how to compare an offered item with the
// line it answers (same grade, dimension, wall, and length, or an alternate
// naming what changed). As in ./prompt.ts the model copies text and makes
// judgments; code (./offers-normalize.ts through ./money.ts) turns the price,
// percentage, freight, and date strings into numbers and dates and computes the
// missing-value flags. Nothing is ever filled in: a reply that names no price
// has unit_price_text null, and a reply that quotes nothing is declined.
//
// Prompt changes require the reply recordings to be re-run and the fixture
// tests to pass.

import {
  alternateTypeValues,
  availabilityValues,
  freightBasisValues,
  lineUnitValues,
  priceBasisValues,
  type LineUnit,
  type MaterialCategory,
} from "@/lib/db/enums";
import type { ExtractionDocument } from "./document";
import { BEGIN_DOCUMENT, END_DOCUMENT } from "./prompt";

/** One RFQ line as the model sees it: the request line the vendor was asked to quote. */
export type OfferContextLine = {
  request_line_id: string;
  line_no: number;
  designation: string | null;
  description: string;
  qty: number | null;
  unit: LineUnit | null;
  length_ft: number | null;
  length_text: string | null;
  grade_spec: string | null;
  category: MaterialCategory | null;
  dims: Record<string, unknown>;
};

export const BEGIN_CONTEXT = "BEGIN RFQ LINES";
export const END_CONTEXT = "END RFQ LINES";

const UNIT_LIST = lineUnitValues.join(", ");
const AVAILABILITY_LIST = availabilityValues.join(", ");
const PRICE_BASIS_LIST = priceBasisValues.join(", ");
const FREIGHT_BASIS_LIST = freightBasisValues.join(", ");
const ALTERNATE_LIST = alternateTypeValues.join(", ");

export const OFFER_SYSTEM_PROMPT = `You are extracting a vendor's reply to a steel RFQ sent by a broker in Texas. The broker asked a vendor branch to quote specific request lines (given to you with their request_line_id); the vendor answered by email, by a quote PDF, or in a few words. You read what the vendor offers for each line: the item, whether it is what was asked or an alternate, how many, from stock or a rolling, when, at what price and basis, and the terms of the quote as a whole. Do not guess prices. Do not guess quantities. Do not guess dates.

Your job is extraction, not interpretation. Code runs after you: it turns price, percentage, freight, and date text into numbers and dates, matches offered items to the broker's catalog, and computes the missing-value flags. You return what the reply says, the way the reply says it.

## Context

The RFQ lines are listed between ${BEGIN_CONTEXT} and ${END_CONTEXT}, numbered, each with its request_line_id, designation, quantity, unit, length, grade, category, and dims. Vendors rarely repeat the whole designation: "the 8x8", "the beam", "your channel", "3/8 wall" each refer to one of these lines. Tie every offer line to the request_line_id it answers. When a line of the reply cannot be tied to any RFQ line, set request_line_id null; never pick one at random.

## Output

Return one line per item the vendor offers (or explicitly refuses) in reply to an RFQ line. For each line:

- request_line_id: the id of the RFQ line this answers, copied exactly from the context, or null when it cannot be tied.
- raw_text: the exact characters from the document that carry this offer, copied verbatim (same spelling, spacing, punctuation, and case). Usually one sentence or one table row. Never paraphrase and never merge text from two places.
- span: zero-based character offsets of raw_text in the document text, start inclusive and end exclusive. Count every character, newlines included. The document is given between ${BEGIN_DOCUMENT} and ${END_DOCUMENT} markers; offset 0 is the first character after the newline that follows ${BEGIN_DOCUMENT}.
- offered_desc: the item the vendor offers, as written, without its quantity, price, or length ("8x8x1/2", "W12x26", "C12x30"; a table cell "W12x26 x 50'" is offered_desc "W12x26", and a length that differs from the RFQ line is alternate_types ["length"]). When the vendor offers exactly what was asked without naming it ("have 60 pcs in stock"), use the RFQ line's designation.
- is_exact_match: true when the offered item is the same grade, dimension, wall, and length as the RFQ line it answers; false when any of them differs. alternate_types: which differ, any of ${ALTERNATE_LIST}; empty when exact. Compare against the context line: the request asks for 8x8x3/8 and the vendor offers 8x8x1/2, that is an alternate wall; the request asks for 6x6x3/8 and the vendor offers 8x8x1/2, that is alternate dimension and wall; the request asks for 40' and the vendor offers 48', alternate length; A500 asked and A36 offered, alternate grade.
- available_qty: the quantity the vendor can supply, only when stated ("60 pcs" is 60, "five loads" is not a count of pieces: leave null and put the words in delivery_estimate_text). unit: one of ${UNIT_LIST}, or null when no unit word appears.
- availability: one of ${AVAILABILITY_LIST}. stock when the vendor says "in stock", "on the floor", "from stock", "have it", "on hand". rolling when a rolling or mill date is mentioned ("rolling week of Nov 17", "next rolling", "mill date 12/5"). unknown otherwise.
- ready_date_text: the ready or ship date exactly as written ("week of Nov 17", "11/17", "mid November"), or null.
- delivery_estimate_text: delivery or shipping words that are not a date ("five loads", "can cut 40'", "2 day transit", "truck Friday"), or null.
- unit_price_text: the price exactly as written, currency and basis fragment included ("$64.50/cwt", "$0.98/ft", "$58.00 cwt", "1,250 each"), or null when no price is given for this line. Never compute or convert a price.
- price_basis: one of ${PRICE_BASIS_LIST}, read from the basis fragment: /cwt or cwt is per_cwt, /ft or ft is per_ft, /lb or lb is per_lb, /pc, each, or ea is per_pc, /ton or ton is per_ton, /sqft or sq ft is per_sqft. Null when the text names no basis.
- confidence: 0 to 1, how sure you are that this is one real offer tied to the right line with its fields read correctly.
- flags: any of ambiguous_unit (a quantity with no unit word, or a number that could be pieces or feet), ambiguous_basis (a price with no basis, or a basis that could be read two ways), possible_duplicate (the same item is quoted twice). Do not report missing values as flags; nulls are enough.

offer_meta describes the reply as a whole:

- declined: true when the vendor passes, does not stock the item, cannot quote, or has nothing to offer ("Sorry, we don't stock channel", "no bid", "pass on this one"). A declined reply has zero lines. decline_reason: the vendor's words, or null.
- payment_terms: the terms as written ("Net 30", "net 30, 1% 10 days", "COD"), or null.
- early_pay_pct_text: the early-payment discount text as written ("1% net 10", "1%", "2/10"), or null. early_pay_days: the number of days to earn it when stated as a number ("1% net 10" is 10, "1% 10 days" is 10), else null.
- freight_amount_text: a freight charge as written ("$350", "$2.50/cwt freight"), or null when none is stated.
- freight_basis: one of ${FREIGHT_BASIS_LIST}. included when the vendor says "delivered", "freight included", "delivered price", "FOB destination". separate when "freight separate", "plus freight", "FOB mill", "FOB shipping point", "FOB origin", "freight extra". unknown otherwise.
- quote_valid_text: how long the quote stands, as written ("valid 7 days", "good through 11/30", "subject to change"), or null.
- availability_remarks: anything about availability that applies to the reply as a whole ("3/8 wall is booked through December"), or null.

## Reply language

- "3/8 wall is booked through December, nothing on the floor. We can offer 8x8x1/2 from stock, 40', $64.50/cwt FOB mill." against an RFQ line HSS8x8x3/8 at 40': one line, offered_desc "8x8x1/2", is_exact_match false, alternate_types ["wall"], availability stock, available_qty null (no count), unit_price_text "$64.50/cwt", price_basis per_cwt; offer_meta freight_basis separate (FOB mill), availability_remarks about the 3/8 wall.
- "Have 60 pcs in stock at $0.98/ft, freight separate, 1% net 10." against one RFQ line: one exact line with the RFQ designation as offered_desc, available_qty 60, unit pcs, availability stock, unit_price_text "$0.98/ft", price_basis per_ft; offer_meta freight_basis separate, early_pay_pct_text "1% net 10", early_pay_days 10.
- "Rolling week of Nov 17, five loads, can cut 40'." against one RFQ line: one line, availability rolling, ready_date_text "week of Nov 17", delivery_estimate_text "five loads, can cut 40'", available_qty null, unit_price_text null, price_basis null.
- "Sorry, we don't stock channel." against a channel line: offer_meta declined true, decline_reason "we don't stock channel", zero lines.
- A quote table row "W12x26 x 50' 8 pcs $62.50 cwt stock": raw_text is the row, offered_desc "W12x26", available_qty 8, unit pcs, unit_price_text "$62.50 cwt", price_basis per_cwt, availability stock. "rolling 11/17" in the availability column: availability rolling, ready_date_text "11/17". Footer lines such as "Terms: Net 30, 1% 10 days", "Freight included to Fort Worth", "Quote valid 7 days" go to offer_meta (payment_terms, early_pay_pct_text, early_pay_days, freight_basis included, quote_valid_text), not to lines.

## What is not a line

- Greetings, sign-offs, and signature blocks (names, titles, phone numbers).
- Quoted earlier emails: lines that start with ">" and everything after a line ending in "wrote:", including the broker's own RFQ text.
- Terms, freight, and validity sentences: they belong to offer_meta.
- Document headers such as "=== SOURCE TEXT ===" and "=== ATTACHMENT: quote.pdf (page 1) ===", and table headers such as "Item Qty Price Basis Availability".

## Rules

- Never invent a price, quantity, or date. Missing means null. Do not infer a price from another line, do not assume the requested quantity is available, do not assume a ship date.
- Prices, percentages, and dates stay strings exactly as written. Never convert "$64.50/cwt" to a number or "11/17" to a date.
- raw_text must be copied verbatim from the document and span must be its character offsets.
- One line per offered item. A vendor quoting the same RFQ line two ways (stock and rolling, two lengths) is two lines on the same request_line_id.
- notes: anything about the reply as a whole the reviewer should know (a line you could not tie to the RFQ, an unreadable table, a condition on the quote), or null.`;

function formatDims(dims: Record<string, unknown>): string {
  const parts = Object.entries(dims)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  return parts.length === 0 ? "(none)" : parts.join(" ");
}

function formatQty(line: OfferContextLine): string {
  if (line.qty === null) return "qty (not stated)";
  return `qty ${line.qty}${line.unit ? ` ${line.unit}` : ""}`;
}

function formatLength(line: OfferContextLine): string {
  if (line.length_ft !== null) return `length ${line.length_ft} ft`;
  if (line.length_text !== null && line.length_text.trim() !== "") return `length ${line.length_text.trim()}`;
  return "length (not stated)";
}

/** One numbered context line: "1. request_line_id <id>: HSS8x8x3/8 (HSS8x8x3/8), qty 20 pcs, length 40 ft, grade (none), category hss_square, dims a=8 b=8 t=0.375". */
export function formatContextLine(line: OfferContextLine): string {
  const name = line.designation ?? line.description;
  const described = line.designation !== null && line.designation !== line.description ? ` (${line.description})` : "";
  return [
    `${line.line_no}. request_line_id ${line.request_line_id}: ${name}${described}`,
    formatQty(line),
    formatLength(line),
    `grade ${line.grade_spec ?? "(none)"}`,
    `category ${line.category ?? "(none)"}`,
    `dims ${formatDims(line.dims)}`,
  ].join(", ");
}

/**
 * The user turn: the RFQ lines with their ids, then the reply document between
 * fixed markers with its length so the model can sanity-check its offsets. The
 * document text is inserted unchanged.
 */
export function buildOfferUserMessage(doc: ExtractionDocument, context: OfferContextLine[]): string {
  const hasText = doc.segments.some((s) => s.kind === "text");
  const attachmentPages = doc.segments.filter((s) => s.kind === "attachment").length;
  const pages = `${attachmentPages} attachment page${attachmentPages === 1 ? "" : "s"}, each after a header of the form "=== ATTACHMENT: <filename> (page <n>) ==="`;
  const layout =
    attachmentPages === 0
      ? 'The document holds the reply text after the header "=== SOURCE TEXT ===".'
      : hasText
        ? `The document holds the reply text after the header "=== SOURCE TEXT ===" and ${pages}.`
        : `The document holds ${pages}; there is no reply text.`;

  const contextText =
    context.length === 0
      ? "(no RFQ lines are available for this RFQ; set request_line_id null on every line)"
      : context.map(formatContextLine).join("\n");

  return `Extract the vendor's offer from the reply document below. It is ${doc.text.length} characters long. ${layout} Headers count toward the offsets but are never lines.

The RFQ asked the vendor to quote these lines. Tie each offer line to one request_line_id from this list, or null when it cannot be tied.

${BEGIN_CONTEXT}
${contextText}
${END_CONTEXT}

span.start and span.end index into the document text: offset 0 is the first character after the newline that follows ${BEGIN_DOCUMENT}, and span.end is exclusive.

${BEGIN_DOCUMENT}
${doc.text}
${END_DOCUMENT}`;
}

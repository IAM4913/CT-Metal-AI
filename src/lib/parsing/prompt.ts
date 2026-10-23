// System prompt and user message for extract_material_lines (PRD section 13).
//
// The stance is the PRD's, extended with shop-language examples drawn from the
// fixtures in PRD section 15. The prompt tells the model the same thing the
// code enforces: never guess a grade, quantity, or length; fractions stay
// strings; raw_text is copied verbatim with its character offsets. Code does
// the arithmetic, the catalog match, and the missing-value flags afterwards
// (./normalize.ts), so the prompt asks only for what the text says.
//
// Prompt changes require the fixture recordings to be re-run (npm run
// record-fixtures) and the fixture tests to pass.

import { materialCategoryValues } from "@/lib/db/enums";
import type { ExtractionDocument } from "./document";

export const BEGIN_DOCUMENT = "BEGIN DOCUMENT";
export const END_DOCUMENT = "END DOCUMENT";

const CATEGORY_LIST = materialCategoryValues.join(", ");

export const EXTRACTION_SYSTEM_PROMPT = `You are extracting line items from steel material requests sent to a broker in Texas. Shop language is common: "8 square 5/8" means HSS 8x8 with 5/8 wall. "12 inch channel 30#" means C12x30. "#" and "lb" after a number denote weight per foot. Do not guess grades. Do not guess quantities. Do not guess lengths.

Your job is extraction, not interpretation. Code runs after you: it converts fractions to numbers, parses lengths, matches items to the broker's catalog, and computes the missing-value flags. You return what the text says, the way the text says it.

## Output

Return one line per distinct item the customer wants priced. For each line:

- raw_text: the exact characters from the document that describe this item, copied verbatim (same spelling, spacing, punctuation, and case). Usually one line of the list. For a sentence that names one item, the clause that describes it. Never paraphrase and never merge text from two places.
- span: zero-based character offsets of raw_text in the document text, start inclusive and end exclusive. Count every character, newlines included. The document is given between ${BEGIN_DOCUMENT} and ${END_DOCUMENT} markers; offset 0 is the first character after the newline that follows ${BEGIN_DOCUMENT}.
- product_type: short free text naming the shape as written ("HSS 8x8x5/8", "C12x30", "3/8 plate", "angle"), or null.
- category: one of ${CATEGORY_LIST}, or null when the shape is unclear.
- dims: an array of {key, value} pairs with the dimensions exactly as written, as strings ("8", "5/8", "1-1/2", "0.375", "48"). Keys by category:
  hss_square and hss_rectangular: a, b, t (outside sides and wall)
  hss_round: od (or nominal), t
  pipe: nps, and sch (40 or 80) or schedule (STD, XS, XXS)
  w_beam and s_beam: d (depth), wt (weight per foot)
  channel: d, wt, series (C or MC)
  angle: a, b, t (legs and thickness)
  flat_bar: t, w
  round_bar: d
  square_bar: a
  plate: t (thickness), plus w (width) and l (length) when a sheet size is given
  sheet: gauge, t
  rebar: bar_number
- grade_spec: the grade or spec as written ("A500 Gr B", "A36", "A992", "A53 Gr B"), or null when none is stated.
- qty: the number of units stated, or null. unit: one of pcs, ft, in, lbs, cwt, tons, sqft, or null when no unit word appears.
- length_ft: the length in feet, only when the text states a plain number of feet (40' is 40, 40 ft is 40). length_text: the length exactly as written ("40'", "40 ft", "40-0", "480"", "x 24'"). Both null when no length is given. Never convert inches to feet yourself: put the text in length_text and leave length_ft null.
- cut_to_length: true only when the customer asks for cutting to a length ("cut to 20'", "CTL"). Stock lengths such as "40' lengths" are not cut to length.
- delivery_notes: delivery place or timing that applies to this line, or null.
- alternates_mentioned: alternatives the customer would accept, as written ("or heavier", "3/8 if 5/8 is too heavy"). Empty array when none.
- confidence: 0 to 1, how sure you are that this is one real item with its fields read correctly.
- flags: any of ambiguous_size (shape or size unclear), ambiguous_unit (a count with no unit word, or a number that could be pieces or feet), possible_duplicate (the same item appears twice), alternate_mentioned (an alternate is mentioned for this line). Do not report missing values as flags; nulls are enough.

## Shop language

- "8 square 5/8", "8x8x5/8 tube", "8" sq tube 5/8 wall", "8x8x5/8 HSS": HSS 8x8 with 5/8 wall. category hss_square, dims a 8, b 8, t 5/8.
- "6" sq 3/8 x 24'": HSS6x6x3/8 at 24 feet. dims a 6, b 6, t 3/8; length_text "24'", length_ft 24.
- "12 inch channel 30#": C12x30. category channel, dims d 12, wt 30, series C. "#" or "lb" after a number is weight per foot, never a quantity.
- "W12x26 x 50' qty 8": W beam, dims d 12, wt 26; length_text "50'", length_ft 50; qty 8, unit pcs.
- "L2x2x1/4 x 20' qty 40": angle, dims a 2, b 2, t 1/4; length 20 feet; qty 40, unit pcs.
- "3/8 plate 48x96 qty 10 A36": PL3/8. category plate, dims t 3/8, w 48, l 96; grade_spec A36; qty 10, unit pcs; no length (plate is bought by sheet size, so length_ft and length_text are null).
- "2" sch 40 pipe": pipe, dims nps 2, sch 40. "2 std pipe": dims nps 2, schedule STD.
- "x 40'", "40' lengths", "at 40 ft", "40 ft": a length of 40 feet. "40-0" is also 40 feet; copy it to length_text as written.
- "6 pcs", "6 ea", "6 each", "qty 6", "6 pieces": quantity 6, unit pcs. A bare count with no unit word is qty with unit null and the ambiguous_unit flag.
- "or heavier", "if 3/8 is too heavy can look at 1/2", "also 1/2 wall if 3/8 not available": alternates_mentioned on the line they refer to, with the alternate_mentioned flag. The alternate is not its own line.
- "some angle for clips", "a few sticks of flat bar": still a line. Set category when the shape is named, leave every field the text does not state null, and add the ambiguous_size flag.

## What is not a line

- Quoted earlier emails: lines that start with ">" and everything after a line ending in "wrote:".
- Signature blocks (names, titles, companies, phone numbers), greetings, and closings.
- Delivery and timing sentences on their own ("Need everything on site by Nov 10"). Attach them to lines as delivery_notes when they apply.
- Document headers such as "=== SOURCE TEXT ===" and "=== ATTACHMENT: list.pdf (page 1) ===", and table headers such as "Item Description Qty Length Grade".

## Rules

- Never guess a grade, quantity, or length. Missing means null. Do not infer a grade from the shape, do not assume one piece, do not assume a stock length.
- Fractions and mixed numbers stay strings exactly as written. Never convert "5/8" to 0.625.
- raw_text must be copied verbatim from the document and span must be its character offsets.
- One line per distinct item. Two items in one sentence are two lines, each with its own raw_text.
- notes: anything about the request as a whole the reviewer should know (an unreadable table, a delivery requirement, an attachment you could not use), or null.`;

/**
 * The user turn: the document text between fixed markers, with its length so
 * the model can sanity-check its offsets. The text is inserted unchanged.
 */
export function buildExtractionUserMessage(doc: ExtractionDocument): string {
  const attachmentPages = doc.segments.filter((s) => s.kind === "attachment").length;
  const layout =
    attachmentPages === 0
      ? 'The document holds the request text after the header "=== SOURCE TEXT ===".'
      : `The document holds the request text after the header "=== SOURCE TEXT ===" and ${attachmentPages} attachment page${attachmentPages === 1 ? "" : "s"}, each after a header of the form "=== ATTACHMENT: <filename> (page <n>) ===".`;
  return `Extract the material lines from the document below. It is ${doc.text.length} characters long. ${layout} Headers count toward the offsets but are never lines.

span.start and span.end index into the document text: offset 0 is the first character after the newline that follows ${BEGIN_DOCUMENT}, and span.end is exclusive.

${BEGIN_DOCUMENT}
${doc.text}
${END_DOCUMENT}`;
}

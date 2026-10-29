// Output schema for the extract_offer_lines call (PRD section 13B).
//
// Same stance as ./schema.ts: the model proposes, code decides. Prices,
// percentages, dates, and freight come back as the text the vendor wrote
// ("$64.50/cwt", "1% net 10", "week of Nov 17", "valid 7 days") and the
// deterministic pass in ./offers-normalize.ts turns them into numbers and ISO
// dates through ./money.ts. Quantities are the model's reading of a stated
// number; anything the reply does not say is null. The model proposes only the
// three judgment flags in modelOfferFlagValues; missing_price, missing_qty,
// missing_availability, unmatched_line, and the cross-line possible_duplicate
// are computed by code.
//
// Structured-output constraints (zodOutputFormat): a closed object with every
// property present (.nullable(), never .optional()), no records, no unions of
// objects, enums via z.enum.

import { z } from "zod";
import {
  alternateTypeSchema,
  availabilitySchema,
  freightBasisSchema,
  lineUnitSchema,
  priceBasisSchema,
} from "@/lib/db/enums";

/** Tool name, also the payload.tool value on the llm_call activity row. */
export const EXTRACT_OFFER_LINES = "extract_offer_lines";

/**
 * offer_lines.flags is text[] in SQL; this is the app's closed list, in the
 * order stored arrays are sorted into.
 */
export const offerFlagValues = [
  "missing_price",
  "missing_qty",
  "missing_availability",
  "ambiguous_unit",
  "ambiguous_basis",
  "unmatched_line",
  "possible_duplicate",
] as const;
export const offerFlagSchema = z.enum(offerFlagValues);
export type OfferFlag = (typeof offerFlagValues)[number];

/** The flags the model may propose; the rest are computed by code. */
export const modelOfferFlagValues = ["ambiguous_unit", "ambiguous_basis", "possible_duplicate"] as const;
export const modelOfferFlagSchema = z.enum(modelOfferFlagValues);
export type ModelOfferFlag = (typeof modelOfferFlagValues)[number];

export const extractedOfferLineSchema = z.object({
  request_line_id: z.string().nullable(),
  raw_text: z.string(),
  span: z.object({ start: z.number().int(), end: z.number().int() }),
  offered_desc: z.string(),
  is_exact_match: z.boolean(),
  alternate_types: z.array(alternateTypeSchema),
  available_qty: z.number().nullable(),
  unit: lineUnitSchema.nullable(),
  availability: availabilitySchema,
  ready_date_text: z.string().nullable(),
  delivery_estimate_text: z.string().nullable(),
  unit_price_text: z.string().nullable(),
  price_basis: priceBasisSchema.nullable(),
  confidence: z.number(),
  flags: z.array(z.enum(["ambiguous_unit", "ambiguous_basis", "possible_duplicate"])),
});

export const offerMetaSchema = z.object({
  declined: z.boolean(),
  decline_reason: z.string().nullable(),
  payment_terms: z.string().nullable(),
  early_pay_pct_text: z.string().nullable(),
  early_pay_days: z.number().int().nullable(),
  freight_amount_text: z.string().nullable(),
  freight_basis: freightBasisSchema,
  quote_valid_text: z.string().nullable(),
  availability_remarks: z.string().nullable(),
});

export const extractOfferLinesOutputSchema = z.object({
  offer_meta: offerMetaSchema,
  lines: z.array(extractedOfferLineSchema),
  notes: z.string().nullable(),
});

export type ExtractedOfferLine = z.infer<typeof extractedOfferLineSchema>;
export type OfferMeta = z.infer<typeof offerMetaSchema>;
export type ExtractOfferLinesOutput = z.infer<typeof extractOfferLinesOutputSchema>;

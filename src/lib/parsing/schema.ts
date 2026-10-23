// Output schema for the extract_material_lines call (PRD section 13A).
//
// The model proposes; code decides. Every value here is what the model could
// read in the text: fractions and mixed numbers stay strings ("5/8", "1-1/2"),
// qty and length_ft are numbers only when the text states them, and anything
// the text does not say is null. The deterministic pass in ./normalize.ts
// turns strings into numbers (parseFraction, parseLengthFt), looks items up in
// the catalog, and computes the missing_* and unmatched_item flags. The model
// only proposes the four judgment flags listed in modelJudgmentFlagValues.
//
// Structured-output constraints (zodOutputFormat): a closed object with every
// property present (.nullable(), never .optional()), no records (dims is an
// array of {key, value} pairs), no unions of objects, enums via z.enum.

import { z } from "zod";
import { lineUnitSchema, materialCategorySchema } from "@/lib/db/enums";

/** Tool name, also the payload.tool value on the llm_call activity row. */
export const EXTRACT_MATERIAL_LINES = "extract_material_lines";

/** The flags the model may propose; missing_* and unmatched_item are computed by code. */
export const modelJudgmentFlagValues = [
  "ambiguous_size",
  "ambiguous_unit",
  "possible_duplicate",
  "alternate_mentioned",
] as const;
export const modelJudgmentFlagSchema = z.enum(modelJudgmentFlagValues);
export type ModelJudgmentFlag = (typeof modelJudgmentFlagValues)[number];

export const extractedLineSchema = z.object({
  raw_text: z.string(),
  span: z.object({ start: z.number().int(), end: z.number().int() }),
  product_type: z.string().nullable(),
  category: materialCategorySchema.nullable(),
  dims: z.array(z.object({ key: z.string(), value: z.string() })),
  grade_spec: z.string().nullable(),
  qty: z.number().nullable(),
  unit: lineUnitSchema.nullable(),
  length_ft: z.number().nullable(),
  length_text: z.string().nullable(),
  cut_to_length: z.boolean(),
  delivery_notes: z.string().nullable(),
  alternates_mentioned: z.array(z.string()),
  confidence: z.number(),
  flags: z.array(z.enum(["ambiguous_size", "ambiguous_unit", "possible_duplicate", "alternate_mentioned"])),
});

export const extractMaterialLinesOutputSchema = z.object({
  lines: z.array(extractedLineSchema),
  notes: z.string().nullable(),
});

export type ExtractedLine = z.infer<typeof extractedLineSchema>;
export type ExtractMaterialLinesOutput = z.infer<typeof extractMaterialLinesOutputSchema>;

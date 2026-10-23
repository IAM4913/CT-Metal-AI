"use server";

// Intake server actions: one per form on /requests/new. Each one checks the
// session, validates the FormData with Zod, hands the typed input to
// src/lib/server/intake.ts, and redirects to the new request. redirect() throws,
// so every call to it sits outside the try/catch that guards the write.
//
// On a validation failure the browser lands back on /requests/new?error=<code>
// and the page turns the code into a sentence (see ERROR_MESSAGES in page.tsx).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { lineUnitSchema } from "@/lib/db/enums";
import { manualLineInputSchema, type ManualLineInput } from "@/lib/parsing/manual";
import { createEmlRequest, createManualRequest, createPasteRequest, EmlParseError } from "@/lib/server/intake";
import { requireBroker } from "@/lib/server/session";

// Not exported: a "use server" module may export only async functions. This is
// the user-facing cap and the page copy repeats the 10 MB figure. Next's own
// serverActions.bodySizeLimit (next.config.ts) sits above it, because Next
// counts the multipart framing in the raw body: with equal limits a 10 MB file
// would get a 413 before this check could produce the friendly message.
const MAX_EML_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/** A text input that may be left empty: "" and a missing field both become null. */
const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().nullable(),
);

/** The customer select: blank means "no customer", anything else must be a uuid. */
const optionalCustomerId = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.uuid().nullable(),
);

/** Quantity typed into the manual form: blank is null, otherwise a positive number. */
const optionalQty = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.coerce.number().positive().nullable(),
);

/** Unit select: blank is null, otherwise one of the line_unit enum values. */
const optionalUnit = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  lineUnitSchema.nullable(),
);

const pasteSchema = z.object({
  // Validated, not transformed: source_text is the textarea value exactly as
  // sent (AC-1.4), leading and trailing whitespace included.
  text: z.string().refine((s) => s.trim() !== "", { message: "empty" }),
  subject: optionalText,
  customerId: optionalCustomerId,
});

const emlFileSchema = z
  .instanceof(File)
  .refine((file) => file.size > 0, { message: "empty" })
  .refine((file) => file.size <= MAX_EML_BYTES, { message: "too_large" })
  .refine((file) => /\.eml$/i.test(file.name) || file.type === "message/rfc822", { message: "not_eml" });

const manualMetaSchema = z.object({
  subject: optionalText,
  customerId: optionalCustomerId,
});

/** One manual row as it arrives from FormData, before the shared contract schema runs. */
const manualRowSchema = z.object({
  description: z.string().trim().min(1),
  qty: optionalQty,
  unit: optionalUnit,
  length_text: optionalText,
  grade_spec: optionalText,
  notes: optionalText,
});

const MANUAL_FIELDS = ["description", "qty", "unit", "length_text", "grade_spec", "notes"] as const;
type ManualField = (typeof MANUAL_FIELDS)[number];
const MANUAL_FIELD_RE = /^lines\[(\d+)\]\[(description|qty|unit|length_text|grade_spec|notes)\]$/;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function createPasteAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const parsed = pasteSchema.safeParse({
    text: formData.get("text"),
    subject: formData.get("subject"),
    customerId: formData.get("customerId"),
  });
  if (!parsed.success) {
    redirect(`/requests/new?error=${hasIssueOn(parsed.error, "customerId") ? "customer" : "paste"}`);
  }

  const result = await attempt(() => createPasteRequest(session, parsed.data));
  if (!result.ok) redirect("/requests/new?error=failed");

  revalidatePath("/");
  redirect(`/requests/${result.requestId}`);
}

export async function createEmlAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const parsed = emlFileSchema.safeParse(formData.get("file"));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message;
    redirect(`/requests/new?error=${message === "too_large" ? "eml_size" : message === "not_eml" ? "eml_type" : "eml"}`);
  }

  const file = parsed.data;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const result = await attempt(() => createEmlRequest(session, { name: file.name, bytes }));
  // Only a parse failure blames the file; a Storage or database failure after
  // a good parse is the same "could not save" as on the other two forms.
  if (!result.ok) {
    redirect(result.error instanceof EmlParseError ? "/requests/new?error=eml_parse" : "/requests/new?error=failed");
  }

  revalidatePath("/");
  redirect(`/requests/${result.requestId}`);
}

export async function createManualAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const meta = manualMetaSchema.safeParse({
    subject: formData.get("subject"),
    customerId: formData.get("customerId"),
  });
  if (!meta.success) {
    redirect(`/requests/new?error=${hasIssueOn(meta.error, "customerId") ? "customer" : "manual"}`);
  }

  const rows = collectManualRows(formData);
  if (rows.length === 0) redirect("/requests/new?error=manual_empty");

  const lines: ManualLineInput[] = [];
  for (const row of rows) {
    const shaped = manualRowSchema.safeParse(row);
    if (!shaped.success) redirect("/requests/new?error=manual");
    // The shared contract schema is the final word on what a manual line is.
    const line = manualLineInputSchema.safeParse(shaped.data);
    if (!line.success) redirect("/requests/new?error=manual");
    lines.push(line.data);
  }

  const result = await attempt(() => createManualRequest(session, lines, meta.data));
  if (!result.ok) redirect("/requests/new?error=failed");

  revalidatePath("/");
  redirect(`/requests/${result.requestId}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Attempt = { ok: true; requestId: string } | { ok: false; error: unknown };

/** Run the write and fold any thrown error into a result, so redirect() can run outside try/catch. */
async function attempt(write: () => Promise<{ requestId: string }>): Promise<Attempt> {
  try {
    const { requestId } = await write();
    return { ok: true, requestId };
  } catch (error) {
    console.error("[intake] request creation failed", error);
    return { ok: false, error };
  }
}

function hasIssueOn(error: z.ZodError, field: string): boolean {
  return error.issues.some((issue) => issue.path[0] === field);
}

/**
 * Rebuild the lines array from fields named lines[i][field]. Rows are ordered
 * by their index, and a row whose every field is blank (an unused extra row)
 * is dropped rather than failing validation.
 */
function collectManualRows(formData: FormData): Record<ManualField, string>[] {
  const byIndex = new Map<number, Record<ManualField, string>>();

  for (const [name, value] of formData.entries()) {
    const match = MANUAL_FIELD_RE.exec(name);
    if (!match || typeof value !== "string") continue;
    const index = Number(match[1]);
    const field = match[2] as ManualField;
    let row = byIndex.get(index);
    if (!row) {
      row = { description: "", qty: "", unit: "", length_text: "", grade_spec: "", notes: "" };
      byIndex.set(index, row);
    }
    row[field] = value;
  }

  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row)
    .filter((row) => MANUAL_FIELDS.some((field) => row[field].trim() !== ""));
}

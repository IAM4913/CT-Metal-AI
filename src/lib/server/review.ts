// Review and correction of request lines (PRD FR-3, PLAN Step 4).
//
// Every write goes through session.supabase (the RLS client) and filters on
// session.brokerId as well, and every edit is recorded in activity_log with the
// before and after values of the fields that changed (AC-3.4). Flags are
// recomputed by computeLineFlags() after every change, so a quantity typed into
// a flagged line clears missing_qty and a cleared grade brings missing_grade
// back; the judgment flags the model set (ambiguous_size, possible_duplicate,
// alternate_mentioned) stay until the broker clears them, and ambiguous_unit
// stays only while the unit is still blank.
//
// canConfirm() is the AC-3.3 gate and is pure: every line that is not removed
// needs a quantity, a unit, and either a catalog link or the explicit "custom"
// status. Grade may stay blank.
//
// linkLineToItem() also saves the description the broker linked as a learned
// alias for that item (AC-3.5), scoped to this broker. Only an unmatched line
// teaches an alias: when a linked line is re-linked, its description is the old
// item's designation, and learning that as an alias of the new item would make
// one designation resolve to another item on the next parse. A description
// with no size in it ("angle", "plate", "some channel for clips") teaches
// nothing either: the parser sets an unmatched line's description to the
// model's product_type, which for a vague line is the bare shape word, and a
// learned "angle" would link every later size-less angle line to one item with
// no unmatched_item flag. aliasToLearn() is the pure rule.
//
// mergeLines() takes the length pair (length_text and length_ft) from one line,
// never one half from each, so the stored number always belongs to the stored
// text. mergeLineValues() is the pure part.

import { z } from "zod";
import { normalizeAlias } from "@/lib/catalog/normalize";
import type { Tables, TablesInsert, TablesUpdate } from "@/lib/db/client";
import type { Json } from "@/lib/db/types";
import {
  lineUnitSchema,
  materialCategorySchema,
  requestLineFlagSchema,
  type MaterialCategory,
  type RequestLineFlag,
} from "@/lib/db/enums";
import { computeLineFlags, orderFlags } from "@/lib/parsing/flags";
import { parseLengthFt } from "@/lib/parsing/length";
import type { BrokerSession } from "@/lib/server/session";

export type LineRow = Tables<"request_lines">;

type CatalogPick = Pick<Tables<"catalog_items">, "id" | "designation" | "category">;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** The fields the grid may edit. Every key optional; null clears a nullable field. */
export const lineEditSchema = z
  .object({
    description: z.string().trim().min(1, "Description is required").optional(),
    category: materialCategorySchema.nullable().optional(),
    grade_spec: z.string().nullable().optional(),
    qty: z.number().positive().nullable().optional(),
    unit: lineUnitSchema.nullable().optional(),
    length_text: z.string().nullable().optional(),
    cut_to_length: z.boolean().optional(),
    delivery_notes: z.string().nullable().optional(),
    catalog_item_id: z.uuid().nullable().optional(),
    status: z.enum(["parsed", "confirmed", "custom"]).optional(),
  })
  .strict();
export type LineEdit = z.infer<typeof lineEditSchema>;

/** A line the broker adds by hand on the review grid. */
export const addLineInputSchema = z.object({
  description: z.string().trim().min(1, "Description is required"),
  category: materialCategorySchema.nullable().default(null),
  grade_spec: z.string().nullable().default(null),
  qty: z.number().positive().nullable().default(null),
  unit: lineUnitSchema.nullable().default(null),
  length_text: z.string().nullable().default(null),
  cut_to_length: z.boolean().default(false),
  delivery_notes: z.string().nullable().default(null),
  catalog_item_id: z.uuid().nullable().default(null),
});
export type AddLineInput = z.input<typeof addLineInputSchema>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const JUDGMENT_FLAGS: ReadonlySet<RequestLineFlag> = new Set<RequestLineFlag>([
  "ambiguous_size",
  "ambiguous_unit",
  "possible_duplicate",
  "alternate_mentioned",
]);

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The row's flags as the typed enum, dropping anything unknown. */
export function rowFlags(flags: string[]): RequestLineFlag[] {
  return flags.filter((f): f is RequestLineFlag => requestLineFlagSchema.safeParse(f).success);
}

export type FlagSource = Pick<
  LineRow,
  "qty" | "unit" | "length_ft" | "length_text" | "grade_spec" | "catalog_item_id" | "category"
> & { flags: string[] };

/**
 * computeLineFlags() over the line's current values, plus the judgment flags
 * carried from the row. ambiguous_unit is carried only while the unit is still
 * blank, and a blank unit beside a quantity is ambiguous whether or not the
 * model said so.
 */
export function recomputeFlags(line: FlagSource): RequestLineFlag[] {
  const carried = rowFlags(line.flags).filter((f) => JUDGMENT_FLAGS.has(f));
  const computed = computeLineFlags({
    qty: line.qty,
    unit: line.unit,
    length_ft: line.length_ft,
    length_text: line.length_text,
    grade_spec: line.grade_spec,
    catalog_item_id: line.catalog_item_id,
    category: line.category,
    alternates_mentioned: [],
    ambiguous_size: carried.includes("ambiguous_size"),
    ambiguous_unit: line.unit === null && (carried.includes("ambiguous_unit") || line.qty !== null),
  });
  const kept = carried.filter((f) => f === "possible_duplicate" || f === "alternate_mentioned");
  return orderFlags([...computed, ...kept]);
}

export type ConfirmableLine = Pick<LineRow, "line_no" | "qty" | "unit" | "catalog_item_id" | "status">;

/**
 * Whether a normalized alias names a size. Every catalog designation and every
 * seed alias carries a digit (a dimension, a weight, a gauge, a bar number); an
 * alias without one is a shape word, and a shape word must not resolve to one
 * item. normalizeAlias has already turned vulgar fractions into digits.
 */
export function aliasCarriesSize(alias: string): boolean {
  return /\d/.test(alias);
}

/**
 * AC-3.5: the alias to learn when a line is linked to an item, or null when
 * nothing should be learned. Learned only from an unmatched line (no catalog
 * link before the pick) whose description is not blank, carries a size (see
 * aliasCarriesSize), and is not already the item's own designation.
 */
export function aliasToLearn(
  line: Pick<LineRow, "catalog_item_id" | "description">,
  item: Pick<CatalogPick, "designation">,
): string | null {
  if (line.catalog_item_id !== null) return null;
  const alias = normalizeAlias(line.description);
  if (alias === "" || alias === normalizeAlias(item.designation)) return null;
  if (!aliasCarriesSize(alias)) return null;
  return alias;
}

export type MergeSource = Pick<
  LineRow,
  | "raw_text"
  | "description"
  | "unit"
  | "grade_spec"
  | "length_text"
  | "length_ft"
  | "delivery_notes"
  | "category"
  | "catalog_item_id"
  | "dims"
  | "cut_to_length"
  | "flags"
>;

/**
 * The merged values of two lines, pure. raw_text and description are joined
 * with " / "; qty stays the kept line's (it is not touched here); blank fields
 * on the kept line are filled from the dropped one (a merge moves data that
 * came from the source, it invents nothing). The length pair comes from one
 * line, the kept one when it has either half, so length_ft always belongs to
 * length_text: a kept "40' or 48'" (unparseable, length_ft null) is not paired
 * with the dropped line's 50. possible_duplicate is dropped; the caller
 * recomputes the rest of the flags.
 */
export function mergeLineValues(keep: MergeSource, drop: MergeSource): MergeSource {
  const lengthSource = keep.length_text !== null || keep.length_ft !== null ? keep : drop;
  return {
    raw_text: `${keep.raw_text} / ${drop.raw_text}`,
    description: `${keep.description} / ${drop.description}`,
    unit: keep.unit ?? drop.unit,
    grade_spec: keep.grade_spec ?? drop.grade_spec,
    length_text: lengthSource.length_text,
    length_ft: lengthSource.length_ft,
    delivery_notes: keep.delivery_notes ?? drop.delivery_notes,
    category: keep.category ?? drop.category,
    catalog_item_id: keep.catalog_item_id ?? drop.catalog_item_id,
    dims: isEmptyObject(keep.dims) ? drop.dims : keep.dims,
    cut_to_length: keep.cut_to_length || drop.cut_to_length,
    flags: [...keep.flags, ...drop.flags].filter((f) => f !== "possible_duplicate"),
  };
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * AC-3.3: every line that is not removed has a quantity, a unit, and either a
 * catalog link or the explicit custom status. Grade may be blank. A request
 * with no live lines cannot be confirmed either.
 */
export function canConfirm(lines: ConfirmableLine[]): { ok: boolean; problems: string[] } {
  const live = lines.filter((line) => line.status !== "removed");
  const problems: string[] = [];
  if (live.length === 0) problems.push("There are no lines to confirm.");
  for (const line of live) {
    const missing: string[] = [];
    if (line.qty === null) missing.push("a quantity");
    if (line.unit === null) missing.push("a unit");
    if (line.catalog_item_id === null && line.status !== "custom") {
      missing.push("a catalog link or the custom item status");
    }
    if (missing.length > 0) problems.push(`Line ${line.line_no} needs ${joinList(missing)}.`);
  }
  return { ok: problems.length === 0, problems };
}

const DIFF_KEYS = [
  "raw_text",
  "description",
  "category",
  "catalog_item_id",
  "dims",
  "grade_spec",
  "qty",
  "unit",
  "length_ft",
  "length_text",
  "cut_to_length",
  "delivery_notes",
  "flags",
  "status",
] as const satisfies readonly (keyof LineRow)[];
type DiffKey = (typeof DIFF_KEYS)[number];

type LineDiff = { before: Partial<Pick<LineRow, DiffKey>>; after: Partial<Pick<LineRow, DiffKey>>; changed: DiffKey[] };

/** The fields whose values differ between two versions of a line, compared as JSON. */
export function diffLine(before: LineRow, after: LineRow): LineDiff {
  const diff: LineDiff = { before: {}, after: {}, changed: [] };
  for (const key of DIFF_KEYS) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      diff.changed.push(key);
      (diff.before as Record<string, unknown>)[key] = before[key];
      (diff.after as Record<string, unknown>)[key] = after[key];
    }
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Line edits
// ---------------------------------------------------------------------------

/**
 * Apply a patch to one line. length_ft is recomputed from length_text when the
 * text changed; flags are recomputed every time. Logs request_line.updated with
 * the changed fields only. Returns the stored row (unchanged when the patch
 * changed nothing).
 */
export async function updateLine(session: BrokerSession, lineId: string, patch: LineEdit): Promise<LineRow> {
  const edit = lineEditSchema.parse(patch);
  const before = await loadLine(session, lineId);
  const after: LineRow = { ...before };

  if (edit.description !== undefined) after.description = edit.description;
  if (edit.category !== undefined) after.category = edit.category;
  if (edit.grade_spec !== undefined) after.grade_spec = clean(edit.grade_spec);
  if (edit.qty !== undefined) after.qty = edit.qty;
  if (edit.unit !== undefined) after.unit = edit.unit;
  if (edit.length_text !== undefined) {
    after.length_text = clean(edit.length_text);
    after.length_ft = parseLengthFt(after.length_text);
  }
  if (edit.cut_to_length !== undefined) after.cut_to_length = edit.cut_to_length;
  if (edit.delivery_notes !== undefined) after.delivery_notes = clean(edit.delivery_notes);
  if (edit.catalog_item_id !== undefined) after.catalog_item_id = edit.catalog_item_id;
  if (edit.status !== undefined) after.status = edit.status;
  after.flags = recomputeFlags(after);

  return writeLineChange(session, before, after, "request_line.updated");
}

/**
 * Add a line the broker typed. Linked when catalog_item_id is given or the
 * description resolves through an alias or a designation; otherwise status
 * "custom". Manual additions have no span, so source_span is {}.
 */
export async function addLine(session: BrokerSession, requestId: string, input: AddLineInput): Promise<LineRow> {
  const parsed = addLineInputSchema.parse(input);
  await assertRequestVisible(session, requestId);

  const item = parsed.catalog_item_id
    ? await loadItem(session, parsed.catalog_item_id)
    : await findItemByDescription(session, parsed.description);

  const length_text = clean(parsed.length_text);
  const values = {
    qty: parsed.qty,
    unit: parsed.unit,
    length_ft: parseLengthFt(length_text),
    length_text,
    grade_spec: clean(parsed.grade_spec),
    catalog_item_id: item ? item.id : null,
    category: item ? item.category : parsed.category,
    flags: [] as string[],
  };

  const row: TablesInsert<"request_lines"> = {
    broker_id: session.brokerId,
    request_id: requestId,
    line_no: (await maxLineNo(session, requestId)) + 1,
    raw_text: parsed.description,
    catalog_item_id: values.catalog_item_id,
    category: values.category,
    description: item ? item.designation : parsed.description,
    dims: {},
    grade_spec: values.grade_spec,
    qty: values.qty,
    unit: values.unit,
    length_ft: values.length_ft,
    length_text: values.length_text,
    cut_to_length: parsed.cut_to_length,
    delivery_notes: clean(parsed.delivery_notes),
    flags: recomputeFlags(values),
    // Typed by the broker: nothing uncertain to score, and no span to point at.
    confidence: 1,
    source_span: {},
    status: item ? "parsed" : "custom",
  };

  const { data, error } = await session.supabase.from("request_lines").insert(row).select("*").single();
  if (error) {
    throw new Error(`Could not add the line: ${error.message}`);
  }
  await logLine(session, data.id, "request_line.added", { after: pickDiffFields(data) });
  return data;
}

/** Mark a line removed. It stays in the table (and the log) but counts for nothing. */
export async function removeLine(session: BrokerSession, lineId: string): Promise<LineRow> {
  const before = await loadLine(session, lineId);
  const after: LineRow = { ...before, status: "removed" };
  return writeLineChange(session, before, after, "request_line.removed");
}

/**
 * Merge two lines of the same request into the first (see mergeLineValues for
 * the values), recompute the flags, and mark the second line removed.
 */
export async function mergeLines(session: BrokerSession, keepId: string, dropId: string): Promise<LineRow> {
  if (keepId === dropId) {
    throw new Error("Pick two different lines to merge.");
  }
  const [keep, drop] = await Promise.all([loadLine(session, keepId), loadLine(session, dropId)]);
  if (keep.request_id !== drop.request_id) {
    throw new Error("Lines from different requests cannot be merged.");
  }

  const after: LineRow = { ...keep, ...mergeLineValues(keep, drop) };
  after.flags = recomputeFlags(after);

  const merged = await writeLineChange(session, keep, after, "request_line.merged", { dropped_line_id: dropId });
  await writeLineChange(session, drop, { ...drop, status: "removed" }, "request_line.removed", {
    merged_into_line_id: keepId,
  });
  return merged;
}

/**
 * Link a line to a catalog item (AC-2.3) and, when the line was unmatched,
 * remember its description as a learned alias for that item (AC-3.5, see
 * aliasToLearn). The description becomes the designation, the category follows
 * the item, a custom line goes back to parsed, and the flags are recomputed.
 */
export async function linkLineToItem(session: BrokerSession, lineId: string, catalogItemId: string): Promise<LineRow> {
  const before = await loadLine(session, lineId);
  const item = await loadItem(session, catalogItemId);

  const after: LineRow = {
    ...before,
    catalog_item_id: item.id,
    category: item.category,
    description: item.designation,
    status: before.status === "custom" ? "parsed" : before.status,
  };
  after.flags = recomputeFlags(after);
  const updated = await writeLineChange(session, before, after, "request_line.updated");

  const alias = aliasToLearn(before, item);
  if (alias !== null) await learnAlias(session, item, alias, lineId);
  return updated;
}

/** Clear every flag on a line. The next edit recomputes the missing_* flags from the values. */
export async function clearLineFlags(session: BrokerSession, lineId: string): Promise<LineRow> {
  const before = await loadLine(session, lineId);
  const after: LineRow = { ...before, flags: [] };
  return writeLineChange(session, before, after, "request_line.flags_cleared");
}

/**
 * AC-3.3 gate plus the status change: every live parsed line becomes
 * confirmed and the request moves to "reviewed". Throws with the problems when
 * canConfirm() says no.
 */
export async function confirmRequest(session: BrokerSession, requestId: string): Promise<{ lineCount: number }> {
  await assertRequestVisible(session, requestId);
  const { data: lines, error } = await session.supabase
    .from("request_lines")
    .select("id, line_no, qty, unit, catalog_item_id, status")
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId)
    .order("line_no", { ascending: true });
  if (error) {
    throw new Error(`Could not read request lines: ${error.message}`);
  }

  const check = canConfirm(lines ?? []);
  if (!check.ok) {
    throw new Error(`The request cannot be confirmed yet. ${check.problems.join(" ")}`);
  }

  const { error: linesError } = await session.supabase
    .from("request_lines")
    .update({ status: "confirmed" })
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId)
    .eq("status", "parsed");
  if (linesError) {
    throw new Error(`Could not confirm the lines: ${linesError.message}`);
  }

  const { error: requestError } = await session.supabase
    .from("requests")
    .update({ status: "reviewed" })
    .eq("broker_id", session.brokerId)
    .eq("id", requestId);
  if (requestError) {
    throw new Error(`Could not update the request status: ${requestError.message}`);
  }

  const lineCount = (lines ?? []).filter((line) => line.status !== "removed").length;
  await logActivity(session, "request", requestId, "request.confirmed", { line_count: lineCount });
  return { lineCount };
}

export type CatalogSearchResult = { id: string; designation: string; category: MaterialCategory };

/**
 * Items whose designation contains q, or that own an alias containing the
 * normalized q. Twenty results, by designation.
 */
export async function searchCatalog(session: BrokerSession, q: string): Promise<CatalogSearchResult[]> {
  const text = q.trim();
  if (text === "") return [];
  const designationPattern = `%${likeSafe(text.replace(/\s+/g, ""))}%`;
  const aliasPattern = `%${likeSafe(normalizeAlias(text))}%`;

  const [byDesignation, byAlias] = await Promise.all([
    session.supabase
      .from("catalog_items")
      .select("id, designation, category")
      .ilike("designation", designationPattern)
      .order("designation", { ascending: true })
      .limit(20),
    aliasPattern === "%%"
      ? Promise.resolve({ data: [], error: null })
      : session.supabase
          .from("catalog_aliases")
          .select("catalog_item_id, catalog_items(id, designation, category)")
          .ilike("alias", aliasPattern)
          .limit(40),
  ]);
  if (byDesignation.error) {
    throw new Error(`Could not search the catalog: ${byDesignation.error.message}`);
  }
  if (byAlias.error) {
    throw new Error(`Could not search catalog aliases: ${byAlias.error.message}`);
  }

  const seen = new Map<string, CatalogSearchResult>();
  for (const item of byDesignation.data ?? []) seen.set(item.id, item);
  for (const row of byAlias.data ?? []) {
    const item = row.catalog_items;
    if (item && !seen.has(item.id)) seen.set(item.id, item);
  }
  return Array.from(seen.values())
    .sort((a, b) => a.designation.localeCompare(b.designation))
    .slice(0, 20);
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/** Strip LIKE wildcards and the PostgREST star so a search term is matched literally. */
function likeSafe(text: string): string {
  return text.replace(/[%_*\\]/g, "");
}

function isEmptyObject(value: Json): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function pickDiffFields(row: LineRow): Partial<Pick<LineRow, DiffKey>> {
  const out: Record<string, unknown> = {};
  for (const key of DIFF_KEYS) out[key] = row[key];
  return out as Partial<Pick<LineRow, DiffKey>>;
}

async function loadLine(session: BrokerSession, lineId: string): Promise<LineRow> {
  const { data, error } = await session.supabase
    .from("request_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", lineId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the line: ${error.message}`);
  }
  if (!data) {
    throw new Error("Line not found.");
  }
  return data;
}

async function loadItem(session: BrokerSession, catalogItemId: string): Promise<CatalogPick> {
  const { data, error } = await session.supabase
    .from("catalog_items")
    .select("id, designation, category")
    .eq("id", catalogItemId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the catalog item: ${error.message}`);
  }
  if (!data) {
    throw new Error("Catalog item not found.");
  }
  return data;
}

/** The item a typed description resolves to: its normalized alias first, then its designation. */
async function findItemByDescription(session: BrokerSession, description: string): Promise<CatalogPick | null> {
  const alias = normalizeAlias(description);
  if (alias !== "") {
    const { data, error } = await session.supabase
      .from("catalog_aliases")
      .select("catalog_item_id, catalog_items(id, designation, category)")
      .eq("alias", alias)
      .order("broker_id", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(`Could not look up the alias: ${error.message}`);
    }
    if (data?.catalog_items) return data.catalog_items;
  }

  const designation = likeSafe(description.replace(/\s+/g, ""));
  if (designation === "") return null;
  const { data, error } = await session.supabase
    .from("catalog_items")
    .select("id, designation, category")
    .ilike("designation", designation)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not look up the designation: ${error.message}`);
  }
  return data;
}

async function assertRequestVisible(session: BrokerSession, requestId: string): Promise<void> {
  const { data, error } = await session.supabase
    .from("requests")
    .select("id")
    .eq("broker_id", session.brokerId)
    .eq("id", requestId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read request: ${error.message}`);
  }
  if (!data) {
    throw new Error("Request not found.");
  }
}

async function maxLineNo(session: BrokerSession, requestId: string): Promise<number> {
  const { data, error } = await session.supabase
    .from("request_lines")
    .select("line_no")
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId)
    .order("line_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read request lines: ${error.message}`);
  }
  return data?.line_no ?? 0;
}

/**
 * Persist the fields that differ between before and after, then log the
 * change with those fields only. No write and no log row when nothing changed.
 */
async function writeLineChange(
  session: BrokerSession,
  before: LineRow,
  after: LineRow,
  action: string,
  extra: { [key: string]: Json | undefined } = {},
): Promise<LineRow> {
  const diff = diffLine(before, after);
  if (diff.changed.length === 0) return before;

  const update: Record<string, unknown> = {};
  for (const key of diff.changed) update[key] = after[key];

  const { data, error } = await session.supabase
    .from("request_lines")
    .update(update as TablesUpdate<"request_lines">)
    .eq("broker_id", session.brokerId)
    .eq("id", before.id)
    .select("*")
    .single();
  if (error) {
    throw new Error(`Could not save the line: ${error.message}`);
  }

  await logLine(session, before.id, action, {
    ...extra,
    before: diff.before as { [key: string]: Json | undefined },
    after: diff.after as { [key: string]: Json | undefined },
  });
  return data;
}

/**
 * AC-3.5: store a normalized alias (from aliasToLearn) as a learned alias of
 * the item, scoped to this broker. Skipped when the item already owns that
 * alias (a seed row or an earlier learned row).
 */
async function learnAlias(session: BrokerSession, item: CatalogPick, alias: string, lineId: string): Promise<void> {
  const { data: existing, error: existingError } = await session.supabase
    .from("catalog_aliases")
    .select("id")
    .eq("catalog_item_id", item.id)
    .eq("alias", alias)
    .limit(1)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Could not check for an existing alias: ${existingError.message}`);
  }
  if (existing) return;

  const row: TablesInsert<"catalog_aliases"> = {
    broker_id: session.brokerId,
    catalog_item_id: item.id,
    alias,
    source: "learned",
  };
  const { error } = await session.supabase
    .from("catalog_aliases")
    .upsert(row, { onConflict: "catalog_item_id,alias,broker_id", ignoreDuplicates: true });
  if (error) {
    throw new Error(`Could not save the learned alias: ${error.message}`);
  }

  await logActivity(session, "catalog_item", item.id, "alias.learned", {
    alias,
    catalog_item_id: item.id,
    designation: item.designation,
    request_line_id: lineId,
  });
}

async function logLine(
  session: BrokerSession,
  lineId: string,
  action: string,
  payload: { [key: string]: Json | undefined },
): Promise<void> {
  await logActivity(session, "request_line", lineId, action, payload);
}

async function logActivity(
  session: BrokerSession,
  entityType: string,
  entityId: string,
  action: string,
  payload: { [key: string]: Json | undefined },
): Promise<void> {
  const { error } = await session.supabase.from("activity_log").insert({
    broker_id: session.brokerId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    actor_user_id: session.userId,
    payload,
  });
  if (error) {
    throw new Error(`Could not write the activity log: ${error.message}`);
  }
}

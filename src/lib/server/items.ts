// Item master admin (PRD FR-4 AC-4.4, PLAN Step 8): search the catalog, read
// one item with its aliases, add and edit items, add and delete aliases. All
// of it runs through the RLS client on the session.
//
// catalog_items is shared reference data with no broker_id (see the Deviations
// in SESSION_NOTES.md): every authenticated user reads and maintains the same
// item master, and designation is globally unique. Aliases are where a
// broker's own knowledge lives: an alias added here is written with source
// "learned" and this broker's broker_id, so only this broker sees it, and
// only this broker's learned aliases can be deleted (seed rows have a null
// broker_id and the policies refuse to touch them). Every alias is passed
// through normalizeAlias() before it is stored, the same function the parser
// runs on every lookup key, so the stored string is what will match.
//
// The form schemas at the top accept the raw strings a plain HTML form posts
// (FormData values, or null when a field is absent) and turn them into typed
// input. The dims field is a JSON textarea: the text is parsed, checked to be
// a flat object of numbers or strings, and each failure carries a code the
// page turns into a sentence (ITEM_FLASH in src/components/items/item-flash.tsx).
//
// Pure helpers (the schemas, itemFormErrorCode, dimsToText, mergeItemRows,
// groupAliases, annotateCollisions, isUniqueViolation) are exported for the
// tests in items.test.ts. The database paths are type-checked only.

import { z } from "zod";
import { normalizeAlias } from "@/lib/catalog/normalize";
import type { Tables, TablesInsert } from "@/lib/db/client";
import type { Json } from "@/lib/db/types";
import { materialCategorySchema, type AliasSource, type MaterialCategory } from "@/lib/db/enums";
import type { BrokerSession } from "@/lib/server/session";

export type ItemRow = Tables<"catalog_items">;
export type AliasRow = Tables<"catalog_aliases">;

/** Results per search and per alias lookup. Phase 1 volumes are small; the page says when the cap is hit. */
export const ITEM_SEARCH_LIMIT = 100;
const ALIAS_SEARCH_LIMIT = 500;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Another item already carries this designation (case-insensitive check first, then the unique constraint). */
export class DesignationTakenError extends Error {
  constructor() {
    super("An item with that designation already exists");
    this.name = "DesignationTakenError";
  }
}

/** The id is not a uuid, no visible row carries it, or (for an alias) it is not this broker's learned row. */
export class ItemNotFoundError extends Error {
  readonly what: "item" | "alias";
  constructor(what: "item" | "alias") {
    super(what === "item" ? "That item was not found." : "That alias was not found or is a seed alias.");
    this.name = "ItemNotFoundError";
    this.what = what;
  }
}

/** The typed alias has no letters or digits once normalized, so nothing could ever match it. */
export class AliasEmptyError extends Error {
  constructor(raw: string) {
    super(`"${raw}" has nothing left after normalization.`);
    this.name = "AliasEmptyError";
  }
}

/** The item already owns that normalized alias (a seed row or an earlier learned row). */
export class AliasExistsError extends Error {
  readonly alias: string;
  constructor(alias: string) {
    super(`This item already has the alias "${alias}".`);
    this.name = "AliasExistsError";
    this.alias = alias;
  }
}

// ---------------------------------------------------------------------------
// Form schemas: raw form strings in, typed input out
// ---------------------------------------------------------------------------

const blankToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);

/** Dims are a flat object: a key per dimension, a number (inches, pounds) or a string (a schedule, a class). */
export const dimsSchema = z.record(z.string(), z.union([z.number(), z.string()]));
export type Dims = z.infer<typeof dimsSchema>;

/** The codes a dims parse can fail with; the page has a sentence for each. */
export type DimsErrorCode = "dims_not_json" | "dims_not_object" | "dims_bad_values";

function dimsIssue(ctx: z.RefinementCtx, code: DimsErrorCode, message: string): typeof z.NEVER {
  ctx.addIssue({ code: "custom", message, params: { code } });
  return z.NEVER;
}

/**
 * The dims textarea: blank means no dims ({}), otherwise JSON text that must be
 * an object whose values are numbers or strings. Each failure carries a code
 * in params so the action can name the problem without carrying text in the
 * URL.
 */
export const dimsTextSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : ""),
  z.string().transform((text, ctx): Dims => {
    const trimmed = text.trim();
    if (trimmed === "") return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return dimsIssue(ctx, "dims_not_json", "Dims is not valid JSON.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return dimsIssue(ctx, "dims_not_object", "Dims must be a JSON object.");
    }

    const checked = dimsSchema.safeParse(parsed);
    if (!checked.success) {
      const badKey = checked.error.issues[0]?.path[0];
      return dimsIssue(
        ctx,
        "dims_bad_values",
        badKey === undefined
          ? "Every dims value must be a number or a string."
          : `The dims value for "${String(badKey)}" must be a number or a string.`,
      );
    }
    return checked.data;
  }),
);

/** The canonical name: whitespace removed ("C12 x 30" is stored as "C12x30"), then required. */
const designationText = z.preprocess(
  (value) => (typeof value === "string" ? value.replace(/\s+/g, "") : value),
  z.string().min(1).max(80),
);

/** Pounds per foot, above zero, or null when unknown. A blank never becomes a number. */
const optionalWeight = z.preprocess(blankToNull, z.coerce.number().finite().gt(0).nullable());

/** Optional single-line text: blank or missing becomes null. */
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable());

export const itemFormSchema = z.object({
  category: materialCategorySchema,
  designation: designationText,
  dims: dimsTextSchema,
  weight_per_ft: optionalWeight,
  default_grade: optionalText(60),
});
export type ItemInput = z.infer<typeof itemFormSchema>;

export const aliasFormSchema = z.object({
  alias: z.preprocess(blankToNull, z.string().trim().min(1).max(200)),
});
export type AliasInput = z.infer<typeof aliasFormSchema>;

export const uuidSchema = z.uuid();

/** Codes the item form can fail with. The flash component has a sentence for each. */
export type ItemFormErrorCode =
  | DimsErrorCode
  | "dims_invalid"
  | "designation_invalid"
  | "category_invalid"
  | "weight_invalid"
  | "grade_invalid"
  | "item_invalid";

/**
 * The code for the first issue of a failed itemFormSchema parse: the dims code
 * the transform attached when there is one, else the field the issue is on.
 */
export function itemFormErrorCode(error: z.ZodError): ItemFormErrorCode {
  const issue = error.issues[0];
  if (!issue) return "item_invalid";

  const params = (issue as { params?: unknown }).params;
  if (params && typeof params === "object") {
    const code = (params as { code?: unknown }).code;
    if (code === "dims_not_json" || code === "dims_not_object" || code === "dims_bad_values") return code;
  }

  switch (issue.path[0]) {
    case "designation":
      return "designation_invalid";
    case "category":
      return "category_invalid";
    case "weight_per_ft":
      return "weight_invalid";
    case "default_grade":
      return "grade_invalid";
    case "dims":
      return "dims_invalid";
    default:
      return "item_invalid";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The dims column as the one-line JSON the form shows and the table lists:
 * {"a": 8, "b": 8, "t": 0.625}. Anything that is not an object (a corrupt
 * row) reads as {}.
 */
export function dimsToText(dims: Json): string {
  if (dims === null || typeof dims !== "object" || Array.isArray(dims)) return "{}";
  const entries = Object.entries(dims).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "{}";
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")}}`;
}

export type ItemListRow = {
  id: string;
  category: MaterialCategory;
  designation: string;
  dims: Json;
  weight_per_ft: number | null;
  default_grade: string | null;
  /** Alias rows visible to this broker: seed rows plus its own learned rows. */
  alias_count: number;
};

/** Natural order on designations: HSS8x8x5/8 before HSS10x10x1/2, case-insensitive. */
export function compareDesignations(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || a.localeCompare(b, "en");
}

/**
 * Designation matches first, then alias matches that are not already in the
 * list, deduplicated by id, in designation order, cut to limit.
 */
export function mergeItemRows(
  byDesignation: readonly ItemListRow[],
  byAlias: readonly ItemListRow[],
  limit = ITEM_SEARCH_LIMIT,
): ItemListRow[] {
  const seen = new Map<string, ItemListRow>();
  for (const row of byDesignation) if (!seen.has(row.id)) seen.set(row.id, row);
  for (const row of byAlias) if (!seen.has(row.id)) seen.set(row.id, row);
  return [...seen.values()].sort((a, b) => compareDesignations(a.designation, b.designation)).slice(0, limit);
}

export type AliasEntry = {
  id: string;
  alias: string;
  source: AliasSource;
  broker_id: string | null;
  created_at: string;
  /** Designations of other items that carry the same normalized alias (a lookup for it is ambiguous). */
  also_on: string[];
};

export type GroupedAliases = {
  /** Shipped with the catalog (broker_id null). Read-only here. */
  seed: AliasEntry[];
  /** Added by this broker, from the review screen or this page. Deletable. */
  learned: AliasEntry[];
};

/** Seed rows and this broker's learned rows, each list in natural alias order. */
export function groupAliases(aliases: readonly AliasEntry[]): GroupedAliases {
  const sorted = [...aliases].sort((a, b) => compareDesignations(a.alias, b.alias));
  return {
    seed: sorted.filter((entry) => entry.source === "seed"),
    learned: sorted.filter((entry) => entry.source !== "seed"),
  };
}

/**
 * Attach to each alias the designations of the other items that own the same
 * alias string. others is every alias row with one of these strings on a
 * different item; a row whose item could not be joined is skipped.
 */
export function annotateCollisions(
  aliases: readonly Omit<AliasEntry, "also_on">[],
  others: readonly { alias: string; designation: string | null }[],
): AliasEntry[] {
  const byAlias = new Map<string, Set<string>>();
  for (const other of others) {
    if (other.designation === null) continue;
    const set = byAlias.get(other.alias) ?? new Set<string>();
    set.add(other.designation);
    byAlias.set(other.alias, set);
  }
  return aliases.map((entry) => ({
    ...entry,
    also_on: [...(byAlias.get(entry.alias) ?? [])].sort(compareDesignations),
  }));
}

/** Postgres unique_violation, as PostgREST reports it. */
export function isUniqueViolation(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === "23505";
}

/** Strip the LIKE metacharacters so a typed pattern matches literally. */
function likeSafe(text: string): string {
  return text.replace(/[%_*\\]/g, "");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ITEM_LIST_SELECT = "id, category, designation, dims, weight_per_ft, default_grade, catalog_aliases(count)";

type ItemListQueryRow = Pick<ItemRow, "id" | "category" | "designation" | "dims" | "weight_per_ft" | "default_grade"> & {
  catalog_aliases: { count: number }[];
};

function toListRow(row: ItemListQueryRow): ItemListRow {
  return {
    id: row.id,
    category: row.category,
    designation: row.designation,
    dims: row.dims,
    weight_per_ft: row.weight_per_ft,
    default_grade: row.default_grade,
    alias_count: row.catalog_aliases[0]?.count ?? 0,
  };
}

/**
 * Items whose designation contains q (whitespace ignored, case-insensitive) or
 * that own an alias containing normalizeAlias(q), optionally within one
 * category, up to ITEM_SEARCH_LIMIT in natural designation order. An empty q
 * lists the first items of the category (or of the whole catalog).
 */
export async function searchItems(
  session: BrokerSession,
  q: string,
  category?: MaterialCategory,
): Promise<ItemListRow[]> {
  const { supabase } = session;
  const text = q.trim();

  const base = () => {
    const query = supabase.from("catalog_items").select(ITEM_LIST_SELECT);
    return category ? query.eq("category", category) : query;
  };

  if (text === "") {
    const { data, error } = await base().order("designation", { ascending: true }).limit(ITEM_SEARCH_LIMIT);
    if (error) throw new Error(`Could not read the catalog: ${error.message}`);
    return mergeItemRows((data ?? []).map(toListRow), []);
  }

  const designationPattern = `%${likeSafe(text.replace(/\s+/g, ""))}%`;
  const normalized = likeSafe(normalizeAlias(text));

  const [byDesignation, aliasRows] = await Promise.all([
    base().ilike("designation", designationPattern).order("designation", { ascending: true }).limit(ITEM_SEARCH_LIMIT),
    normalized === ""
      ? Promise.resolve({ data: [] as { catalog_item_id: string }[], error: null })
      : supabase.from("catalog_aliases").select("catalog_item_id").ilike("alias", `%${normalized}%`).limit(ALIAS_SEARCH_LIMIT),
  ]);
  if (byDesignation.error) throw new Error(`Could not search the catalog: ${byDesignation.error.message}`);
  if (aliasRows.error) throw new Error(`Could not search catalog aliases: ${aliasRows.error.message}`);

  const designationRows = (byDesignation.data ?? []).map(toListRow);
  const found = new Set(designationRows.map((row) => row.id));
  const aliasItemIds = [...new Set((aliasRows.data ?? []).map((row) => row.catalog_item_id))]
    .filter((id) => !found.has(id))
    .slice(0, ITEM_SEARCH_LIMIT);

  let aliasItems: ItemListRow[] = [];
  if (aliasItemIds.length > 0) {
    const { data, error } = await base().in("id", aliasItemIds).order("designation", { ascending: true });
    if (error) throw new Error(`Could not read the matched items: ${error.message}`);
    aliasItems = (data ?? []).map(toListRow);
  }

  return mergeItemRows(designationRows, aliasItems);
}

export type ItemDetail = {
  item: ItemRow;
  aliases: GroupedAliases;
};

/**
 * One item with its visible aliases (seed rows plus this broker's learned
 * rows), each marked with the other items that share the same alias string.
 * Null when the id is not a uuid or no item has it.
 */
export async function getItemWithAliases(session: BrokerSession, itemId: string): Promise<ItemDetail | null> {
  if (!uuidSchema.safeParse(itemId).success) return null;
  const { supabase } = session;

  const itemResult = await supabase.from("catalog_items").select("*").eq("id", itemId).maybeSingle();
  if (itemResult.error) throw new Error(`Could not read the item: ${itemResult.error.message}`);
  if (!itemResult.data) return null;

  const aliasResult = await supabase
    .from("catalog_aliases")
    .select("id, alias, source, broker_id, created_at")
    .eq("catalog_item_id", itemId)
    .order("alias", { ascending: true });
  if (aliasResult.error) throw new Error(`Could not read the aliases: ${aliasResult.error.message}`);
  const aliases = aliasResult.data ?? [];

  let others: { alias: string; designation: string | null }[] = [];
  if (aliases.length > 0) {
    const { data, error } = await supabase
      .from("catalog_aliases")
      .select("alias, catalog_items(designation)")
      .in(
        "alias",
        aliases.map((row) => row.alias),
      )
      .neq("catalog_item_id", itemId);
    if (error) throw new Error(`Could not check the aliases of other items: ${error.message}`);
    others = (data ?? []).map((row) => ({ alias: row.alias, designation: row.catalog_items?.designation ?? null }));
  }

  return {
    item: itemResult.data,
    aliases: groupAliases(annotateCollisions(aliases, others)),
  };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function createItem(session: BrokerSession, input: ItemInput): Promise<{ itemId: string }> {
  const { supabase } = session;
  await assertDesignationFree(session, input.designation, null);

  const row: TablesInsert<"catalog_items"> = { ...input };
  const { data, error } = await supabase.from("catalog_items").insert(row).select("id").single();
  if (error) {
    if (isUniqueViolation(error)) throw new DesignationTakenError();
    throw new Error(`Could not create the item: ${error.message}`);
  }
  await logActivity(session, "catalog_item", data.id, "catalog_item.created", { ...input });
  return { itemId: data.id };
}

export async function updateItem(session: BrokerSession, itemId: string, input: ItemInput): Promise<void> {
  const { supabase } = session;
  await assertDesignationFree(session, input.designation, itemId);

  const { data, error } = await supabase
    .from("catalog_items")
    .update({ ...input })
    .eq("id", itemId)
    .select("id")
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) throw new DesignationTakenError();
    throw new Error(`Could not update the item: ${error.message}`);
  }
  if (!data) throw new ItemNotFoundError("item");
  await logActivity(session, "catalog_item", itemId, "catalog_item.updated", { ...input });
}

/**
 * The unique constraint on designation is case-sensitive, so a case-insensitive
 * check runs first: "c12x30" next to "C12x30" would be two items the alias
 * index cannot tell apart. exceptItemId is the item being edited.
 */
async function assertDesignationFree(
  session: BrokerSession,
  designation: string,
  exceptItemId: string | null,
): Promise<void> {
  const pattern = likeSafe(designation);
  if (pattern === "") return;
  const { data, error } = await session.supabase
    .from("catalog_items")
    .select("id")
    .ilike("designation", pattern)
    .limit(2);
  if (error) throw new Error(`Could not check the designation: ${error.message}`);
  if ((data ?? []).some((row) => row.id !== exceptItemId)) throw new DesignationTakenError();
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

export type AddAliasResult = {
  /** The stored, normalized alias. */
  alias: string;
  /** Designations of other items that already own the same alias. The learned row wins for this broker's lookups. */
  collidesWith: string[];
};

/**
 * Adds normalizeAlias(rawAlias) to the item as a learned alias of this broker
 * (AC-4.4). Refused when the normalized alias is empty or the item already has
 * it. Other items owning the same alias do not block the write: the parser
 * loads learned aliases first, so this broker's alias wins, and the result
 * names the collisions so the page can say so.
 */
export async function addAlias(session: BrokerSession, itemId: string, rawAlias: string): Promise<AddAliasResult> {
  const { supabase, brokerId } = session;
  const alias = normalizeAlias(rawAlias);
  if (alias === "") throw new AliasEmptyError(rawAlias);

  const item = await supabase.from("catalog_items").select("id, designation").eq("id", itemId).maybeSingle();
  if (item.error) throw new Error(`Could not read the item: ${item.error.message}`);
  if (!item.data) throw new ItemNotFoundError("item");

  const existing = await supabase
    .from("catalog_aliases")
    .select("id")
    .eq("catalog_item_id", itemId)
    .eq("alias", alias)
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error(`Could not check for an existing alias: ${existing.error.message}`);
  if (existing.data) throw new AliasExistsError(alias);

  const others = await supabase
    .from("catalog_aliases")
    .select("catalog_items(designation)")
    .eq("alias", alias)
    .neq("catalog_item_id", itemId)
    .limit(10);
  if (others.error) throw new Error(`Could not check the aliases of other items: ${others.error.message}`);
  const collidesWith = [
    ...new Set((others.data ?? []).flatMap((row) => (row.catalog_items ? [row.catalog_items.designation] : []))),
  ].sort(compareDesignations);

  const row: TablesInsert<"catalog_aliases"> = {
    broker_id: brokerId,
    catalog_item_id: itemId,
    alias,
    source: "learned",
  };
  const { error } = await supabase.from("catalog_aliases").insert(row);
  if (error) {
    if (isUniqueViolation(error)) throw new AliasExistsError(alias);
    throw new Error(`Could not save the alias: ${error.message}`);
  }

  await logActivity(session, "catalog_item", itemId, "alias.added", {
    alias,
    raw: rawAlias,
    catalog_item_id: itemId,
    designation: item.data.designation,
    collides_with: collidesWith,
  });
  return { alias, collidesWith };
}

/** Deletes one of this broker's learned aliases. A seed alias or another broker's row is "not found". */
export async function deleteAlias(session: BrokerSession, aliasId: string): Promise<void> {
  const { supabase, brokerId } = session;
  const { data, error } = await supabase
    .from("catalog_aliases")
    .delete()
    .eq("id", aliasId)
    .eq("broker_id", brokerId)
    .select("id, alias, catalog_item_id");
  if (error) throw new Error(`Could not delete the alias: ${error.message}`);
  const deleted = data?.[0];
  if (!deleted) throw new ItemNotFoundError("alias");
  await logActivity(session, "catalog_item", deleted.catalog_item_id, "alias.deleted", {
    alias: deleted.alias,
    alias_id: deleted.id,
    catalog_item_id: deleted.catalog_item_id,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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

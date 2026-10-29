"use server";

// Item admin server actions (PRD FR-4 AC-4.4): one per plain form on /items
// and /items/[id]. Each one checks the session, reads the posted fields out
// of the FormData, validates them with the form schemas in
// src/lib/server/items.ts, calls the lib, revalidates the item pages, and
// redirects back with ?saved=<what>, ?deleted=<what>, or ?error=<code>. The
// page turns the code into a sentence (src/components/items/item-flash.tsx),
// so no free text travels in the URL apart from the colliding designations an
// alias save reports (checked against a strict pattern before display).
//
// An item the lib cannot find (deleted in another tab, a stale form) goes back
// to the list with ?error=not_found, since the item page itself would answer
// 404 and never show the message; a missing alias stays on the item page,
// which still exists.
//
// redirect() throws, so it is always called outside the try/catch in attempt().

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addAlias,
  AliasEmptyError,
  AliasExistsError,
  aliasFormSchema,
  createItem,
  deleteAlias,
  DesignationTakenError,
  itemFormErrorCode,
  itemFormSchema,
  ItemNotFoundError,
  updateItem,
  uuidSchema,
} from "@/lib/server/items";
import { requireBroker } from "@/lib/server/session";

const ITEM_FIELDS = ["category", "designation", "dims", "weight_per_ft", "default_grade"] as const;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function createItemAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const parsed = itemFormSchema.safeParse(fields(formData, ITEM_FIELDS));
  if (!parsed.success) redirect(`/items?error=${itemFormErrorCode(parsed.error)}#new-item`);

  const result = await attempt(() => createItem(session, parsed.data));
  if (!result.ok) redirect(`/items?error=${result.code}#new-item`);

  revalidatePath("/items");
  redirect(`/items/${result.value.itemId}?saved=item_created`);
}

export async function updateItemAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const itemId = uuidSchema.safeParse(formData.get("item_id"));
  if (!itemId.success) redirect("/items?error=not_found");

  const parsed = itemFormSchema.safeParse(fields(formData, ITEM_FIELDS));
  if (!parsed.success) redirect(`/items/${itemId.data}?error=${itemFormErrorCode(parsed.error)}#item-fields`);

  const result = await attempt(() => updateItem(session, itemId.data, parsed.data));
  if (!result.ok) redirect(result.code === "not_found" ? "/items?error=not_found" : `/items/${itemId.data}?error=${result.code}#item-fields`);

  revalidateItem(itemId.data);
  redirect(`/items/${itemId.data}?saved=item`);
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

export async function addAliasAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const itemId = uuidSchema.safeParse(formData.get("item_id"));
  if (!itemId.success) redirect("/items?error=not_found");

  const parsed = aliasFormSchema.safeParse({ alias: formData.get("alias") });
  if (!parsed.success) redirect(`/items/${itemId.data}?error=alias_invalid#add-alias`);

  const result = await attempt(() => addAlias(session, itemId.data, parsed.data.alias));
  if (!result.ok) redirect(result.code === "not_found" ? "/items?error=not_found" : `/items/${itemId.data}?error=${result.code}#add-alias`);

  revalidateItem(itemId.data);
  const also =
    result.value.collidesWith.length > 0 ? `&also=${encodeURIComponent(result.value.collidesWith.join(","))}` : "";
  redirect(`/items/${itemId.data}?saved=alias${also}#aliases`);
}

export async function deleteAliasAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const itemId = uuidSchema.safeParse(formData.get("item_id"));
  if (!itemId.success) redirect("/items?error=not_found");
  const aliasId = uuidSchema.safeParse(formData.get("alias_id"));
  if (!aliasId.success) redirect(`/items/${itemId.data}?error=alias_not_found#aliases`);

  const result = await attempt(() => deleteAlias(session, aliasId.data));
  if (!result.ok) redirect(`/items/${itemId.data}?error=${result.code}#aliases`);

  revalidateItem(itemId.data);
  redirect(`/items/${itemId.data}?deleted=alias#aliases`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Attempt<T> = { ok: true; value: T } | { ok: false; code: string };

/**
 * Run the write and fold any thrown error into a result with an error code the
 * page knows, so redirect() can run outside try/catch.
 */
async function attempt<T>(write: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await write() };
  } catch (error) {
    if (error instanceof DesignationTakenError) return { ok: false, code: "designation_taken" };
    if (error instanceof AliasEmptyError) return { ok: false, code: "alias_empty" };
    if (error instanceof AliasExistsError) return { ok: false, code: "alias_exists" };
    if (error instanceof ItemNotFoundError) return { ok: false, code: error.what === "alias" ? "alias_not_found" : "not_found" };
    console.error("[items] write failed", error);
    return { ok: false, code: "failed" };
  }
}

/** The named fields as strings, null when absent (a file or a missing field). */
function fields(formData: FormData, names: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of names) {
    const value = formData.get(name);
    out[name] = typeof value === "string" ? value : null;
  }
  return out;
}

function revalidateItem(itemId: string): void {
  revalidatePath("/items");
  revalidatePath(`/items/${itemId}`);
}

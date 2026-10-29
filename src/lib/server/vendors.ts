// Vendor directory admin (PRD FR-5, PLAN Step 8): vendors, branches, contacts,
// capabilities, and terms, read and written through the RLS client.
//
// Every read filters on session.brokerId as well as relying on the policies,
// and every row written carries broker_id. The form schemas at the top accept
// the raw strings a plain HTML form posts (FormData values, or null when the
// field is absent) and turn them into typed input: blank optional text becomes
// null, a checkbox is "on" or missing, numbers are coerced, enums validated.
// The server actions in src/app/(app)/vendors/actions.ts run these schemas and
// hand the typed result to the functions below, so the actions stay thin.
//
// Delete guards: rfqs, vendor_offers, and purchases reference vendor_branches
// without cascade, so a branch with RFQ or purchase history cannot be deleted
// (and neither can its vendor). The guard runs before the delete and throws
// VendorInUseError with the count, so the UI shows a sentence instead of a
// foreign key error. Contacts and capabilities cascade with their branch.
//
// Pure helpers (summarizeVendors, capabilityDiff, countByBranch, excerpt) are
// exported for the tests in vendors.test.ts.

import { z } from "zod";
import type { Tables } from "@/lib/db/client";
import type { Json } from "@/lib/db/types";
import {
  freightDefaultSchema,
  materialCategorySchema,
  vendorTypeSchema,
  type MaterialCategory,
} from "@/lib/db/enums";
import type { BrokerSession } from "@/lib/server/session";

export type VendorRow = Tables<"vendors">;
export type BranchRow = Tables<"vendor_branches">;
export type ContactRow = Tables<"vendor_contacts">;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A vendor or branch still has RFQ or purchase history, so it cannot be deleted. */
export class VendorInUseError extends Error {
  readonly kind: "vendor" | "branch";
  readonly count: number;
  constructor(kind: "vendor" | "branch", count: number) {
    super(
      kind === "vendor"
        ? `This vendor has ${count} RFQ${count === 1 ? "" : "s"} or purchase${count === 1 ? "" : "s"} on its branches and cannot be deleted.`
        : `This branch has ${count} RFQ${count === 1 ? "" : "s"} or purchase${count === 1 ? "" : "s"} and cannot be deleted.`,
    );
    this.name = "VendorInUseError";
    this.kind = kind;
    this.count = count;
  }
}

/** The id is not a uuid or no visible row carries it. */
export class VendorNotFoundError extends Error {
  constructor(what: "vendor" | "branch" | "contact") {
    super(`That ${what} was not found.`);
    this.name = "VendorNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Form schemas: raw form strings in, typed input out
// ---------------------------------------------------------------------------

const blankToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);

/** Required single-line text. */
const requiredText = z.preprocess(blankToNull, z.string().trim().min(1).max(200));

/** Optional single-line text: blank or missing becomes null. */
const optionalText = z.preprocess(blankToNull, z.string().trim().max(500).nullable());

/** Free text that is stored as "" when left blank (notes columns are not null). */
const notesText = z.preprocess(
  (value) => (typeof value === "string" ? value : ""),
  z.string().trim().max(5000),
);

/** A checkbox posts "on" when ticked and nothing at all when not. */
const checkbox = z.preprocess((value) => value === "on" || value === "true" || value === true, z.boolean());

/** Early-pay discount as a whole percent (2 means 2%), or null. Matches earlyPaySavings in compare/cost.ts. */
const optionalPercent = z.preprocess(blankToNull, z.coerce.number().min(0).max(100).nullable());

/** Early-pay window in days, or null. */
const optionalDays = z.preprocess(blankToNull, z.coerce.number().int().min(0).max(365).nullable());

export const vendorFormSchema = z.object({
  name: requiredText,
  vendor_type: vendorTypeSchema,
  website: optionalText,
  notes: notesText,
});
export type VendorInput = z.infer<typeof vendorFormSchema>;

export const branchFormSchema = z.object({
  name: requiredText,
  city: requiredText,
  state: requiredText,
  region: optionalText,
  preferred: checkbox,
  payment_terms: optionalText,
  early_pay_pct: optionalPercent,
  early_pay_days: optionalDays,
  freight_default: freightDefaultSchema,
  notes: notesText,
});
export type BranchInput = z.infer<typeof branchFormSchema>;

export const contactFormSchema = z.object({
  name: requiredText,
  // The format check runs before any .trim() overwrite in zod v4, so the
  // whitespace and case are cleaned up in the preprocess step.
  email: z.preprocess(
    (value) => (typeof value === "string" ? (value.trim() === "" ? null : value.trim().toLowerCase()) : value),
    z.email().max(320),
  ),
  phone: optionalText,
  is_primary: checkbox,
  notes: notesText,
});
export type ContactInput = z.infer<typeof contactFormSchema>;

/** The checkbox grid posts one "categories" value per ticked box; duplicates are dropped. */
export const capabilitiesFormSchema = z
  .array(materialCategorySchema)
  .max(100)
  .transform((categories) => [...new Set(categories)]);

export const uuidSchema = z.uuid();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type VendorListRow = {
  id: string;
  name: string;
  vendor_type: VendorRow["vendor_type"];
  website: string | null;
  notes: string;
  branch_count: number;
  preferred_count: number;
};

/** One list row per vendor with its branch and preferred-branch counts. Vendors keep the order given. */
export function summarizeVendors(
  vendors: Pick<VendorRow, "id" | "name" | "vendor_type" | "website" | "notes">[],
  branches: Pick<BranchRow, "vendor_id" | "preferred">[],
): VendorListRow[] {
  const counts = new Map<string, { total: number; preferred: number }>();
  for (const branch of branches) {
    const entry = counts.get(branch.vendor_id) ?? { total: 0, preferred: 0 };
    entry.total += 1;
    if (branch.preferred) entry.preferred += 1;
    counts.set(branch.vendor_id, entry);
  }
  return vendors.map((vendor) => {
    const entry = counts.get(vendor.id) ?? { total: 0, preferred: 0 };
    return {
      id: vendor.id,
      name: vendor.name,
      vendor_type: vendor.vendor_type,
      website: vendor.website,
      notes: vendor.notes,
      branch_count: entry.total,
      preferred_count: entry.preferred,
    };
  });
}

/** The first line of a note, cut to max characters with an ellipsis. "" stays "". */
export function excerpt(notes: string, max = 80): string {
  const firstLine = notes.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}...`;
}

/** Which categories to insert and which to delete so current becomes wanted. Both lists are sorted. */
export function capabilityDiff(
  current: readonly MaterialCategory[],
  wanted: readonly MaterialCategory[],
): { toInsert: MaterialCategory[]; toDelete: MaterialCategory[] } {
  const have = new Set(current);
  const want = new Set(wanted);
  const toInsert = [...want].filter((category) => !have.has(category)).sort();
  const toDelete = [...have].filter((category) => !want.has(category)).sort();
  return { toInsert, toDelete };
}

/** Rows per branch_id, as a map with every id in branchIds present (0 when none). */
export function countByBranch(
  branchIds: readonly string[],
  rows: readonly { branch_id: string }[],
): Map<string, number> {
  const counts = new Map<string, number>(branchIds.map((id) => [id, 0]));
  for (const row of rows) {
    counts.set(row.branch_id, (counts.get(row.branch_id) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every vendor of the broker, by name, with branch counts. */
export async function listVendors(session: BrokerSession): Promise<VendorListRow[]> {
  const { supabase, brokerId } = session;
  const [vendors, branches] = await Promise.all([
    supabase
      .from("vendors")
      .select("id, name, vendor_type, website, notes")
      .eq("broker_id", brokerId)
      .order("name", { ascending: true }),
    supabase.from("vendor_branches").select("vendor_id, preferred").eq("broker_id", brokerId),
  ]);
  if (vendors.error) throw new Error(`Could not read vendors: ${vendors.error.message}`);
  if (branches.error) throw new Error(`Could not read vendor branches: ${branches.error.message}`);
  return summarizeVendors(vendors.data ?? [], branches.data ?? []);
}

export type BranchDetail = BranchRow & {
  contacts: ContactRow[];
  capabilities: MaterialCategory[];
  /** RFQs plus purchases that reference this branch; when above zero the branch cannot be deleted. */
  history_count: number;
};

export type VendorDetail = {
  vendor: VendorRow;
  branches: BranchDetail[];
  /** Sum of history_count over the branches; when above zero the vendor cannot be deleted. */
  history_count: number;
};

/**
 * The vendor with its branches (by name), each with contacts (primary first,
 * then by name), capability categories, and history counts. Null when the id
 * is not a uuid or no visible vendor has it.
 */
export async function getVendorDetail(session: BrokerSession, vendorId: string): Promise<VendorDetail | null> {
  if (!uuidSchema.safeParse(vendorId).success) return null;
  const { supabase, brokerId } = session;

  const vendorResult = await supabase
    .from("vendors")
    .select("*")
    .eq("id", vendorId)
    .eq("broker_id", brokerId)
    .maybeSingle();
  if (vendorResult.error) throw new Error(`Could not read vendor: ${vendorResult.error.message}`);
  if (!vendorResult.data) return null;

  const branchesResult = await supabase
    .from("vendor_branches")
    .select("*")
    .eq("vendor_id", vendorId)
    .eq("broker_id", brokerId)
    .order("name", { ascending: true });
  if (branchesResult.error) throw new Error(`Could not read vendor branches: ${branchesResult.error.message}`);
  const branches = branchesResult.data ?? [];
  const branchIds = branches.map((branch) => branch.id);

  if (branchIds.length === 0) {
    return { vendor: vendorResult.data, branches: [], history_count: 0 };
  }

  const [contacts, capabilities, rfqs, purchases] = await Promise.all([
    supabase
      .from("vendor_contacts")
      .select("*")
      .eq("broker_id", brokerId)
      .in("branch_id", branchIds)
      .order("is_primary", { ascending: false })
      .order("name", { ascending: true }),
    supabase.from("vendor_capabilities").select("branch_id, category").eq("broker_id", brokerId).in("branch_id", branchIds),
    supabase.from("rfqs").select("branch_id").eq("broker_id", brokerId).in("branch_id", branchIds),
    supabase.from("purchases").select("branch_id").eq("broker_id", brokerId).in("branch_id", branchIds),
  ]);
  if (contacts.error) throw new Error(`Could not read vendor contacts: ${contacts.error.message}`);
  if (capabilities.error) throw new Error(`Could not read vendor capabilities: ${capabilities.error.message}`);
  if (rfqs.error) throw new Error(`Could not read RFQs: ${rfqs.error.message}`);
  if (purchases.error) throw new Error(`Could not read purchases: ${purchases.error.message}`);

  const history = countByBranch(branchIds, [...(rfqs.data ?? []), ...(purchases.data ?? [])]);

  const detailed: BranchDetail[] = branches.map((branch) => ({
    ...branch,
    contacts: (contacts.data ?? []).filter((contact) => contact.branch_id === branch.id),
    capabilities: (capabilities.data ?? [])
      .filter((capability) => capability.branch_id === branch.id)
      .map((capability) => capability.category)
      .sort(),
    history_count: history.get(branch.id) ?? 0,
  }));

  return {
    vendor: vendorResult.data,
    branches: detailed,
    history_count: detailed.reduce((sum, branch) => sum + branch.history_count, 0),
  };
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export async function createVendor(session: BrokerSession, input: VendorInput): Promise<{ vendorId: string }> {
  const { supabase, brokerId } = session;
  const { data, error } = await supabase
    .from("vendors")
    .insert({ broker_id: brokerId, ...input })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create vendor: ${error.message}`);
  await logActivity(session, "vendor", data.id, "vendor.created", { ...input });
  return { vendorId: data.id };
}

export async function updateVendor(session: BrokerSession, vendorId: string, input: VendorInput): Promise<void> {
  const { supabase, brokerId } = session;
  const { data, error } = await supabase
    .from("vendors")
    .update(input)
    .eq("id", vendorId)
    .eq("broker_id", brokerId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Could not update vendor: ${error.message}`);
  if (!data) throw new VendorNotFoundError("vendor");
  await logActivity(session, "vendor", vendorId, "vendor.updated", { ...input });
}

/** Deletes the vendor and (by cascade) its branches, contacts, and capabilities. Refused when any branch has history. */
export async function deleteVendor(session: BrokerSession, vendorId: string): Promise<void> {
  const { supabase, brokerId } = session;

  const branches = await supabase.from("vendor_branches").select("id").eq("vendor_id", vendorId).eq("broker_id", brokerId);
  if (branches.error) throw new Error(`Could not read vendor branches: ${branches.error.message}`);
  const branchIds = (branches.data ?? []).map((branch) => branch.id);

  const inUse = await countHistory(session, branchIds);
  if (inUse > 0) throw new VendorInUseError("vendor", inUse);

  const { data, error } = await supabase.from("vendors").delete().eq("id", vendorId).eq("broker_id", brokerId).select("id");
  if (error) throw new Error(`Could not delete vendor: ${error.message}`);
  if (!data || data.length === 0) throw new VendorNotFoundError("vendor");
  await logActivity(session, "vendor", vendorId, "vendor.deleted", { branch_ids: branchIds });
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export async function createBranch(
  session: BrokerSession,
  vendorId: string,
  input: BranchInput,
): Promise<{ branchId: string }> {
  const { supabase, brokerId } = session;
  // The vendor must be visible to this broker; the composite foreign key would
  // reject another tenant's id anyway, but "not found" reads better than an FK error.
  const vendor = await supabase.from("vendors").select("id").eq("id", vendorId).eq("broker_id", brokerId).maybeSingle();
  if (vendor.error) throw new Error(`Could not read vendor: ${vendor.error.message}`);
  if (!vendor.data) throw new VendorNotFoundError("vendor");

  const { data, error } = await supabase
    .from("vendor_branches")
    .insert({ broker_id: brokerId, vendor_id: vendorId, ...input })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create branch: ${error.message}`);
  await logActivity(session, "vendor_branch", data.id, "vendor_branch.created", { vendor_id: vendorId, ...input });
  return { branchId: data.id };
}

export async function updateBranch(session: BrokerSession, branchId: string, input: BranchInput): Promise<void> {
  const { supabase, brokerId } = session;
  const { data, error } = await supabase
    .from("vendor_branches")
    .update(input)
    .eq("id", branchId)
    .eq("broker_id", brokerId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Could not update branch: ${error.message}`);
  if (!data) throw new VendorNotFoundError("branch");
  await logActivity(session, "vendor_branch", branchId, "vendor_branch.updated", { ...input });
}

/** Deletes the branch and (by cascade) its contacts and capabilities. Refused when it has history. */
export async function deleteBranch(session: BrokerSession, branchId: string): Promise<void> {
  const { supabase, brokerId } = session;

  const inUse = await countHistory(session, [branchId]);
  if (inUse > 0) throw new VendorInUseError("branch", inUse);

  const { data, error } = await supabase
    .from("vendor_branches")
    .delete()
    .eq("id", branchId)
    .eq("broker_id", brokerId)
    .select("id");
  if (error) throw new Error(`Could not delete branch: ${error.message}`);
  if (!data || data.length === 0) throw new VendorNotFoundError("branch");
  await logActivity(session, "vendor_branch", branchId, "vendor_branch.deleted", {});
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function createContact(
  session: BrokerSession,
  branchId: string,
  input: ContactInput,
): Promise<{ contactId: string }> {
  const { supabase, brokerId } = session;
  const branch = await supabase
    .from("vendor_branches")
    .select("id")
    .eq("id", branchId)
    .eq("broker_id", brokerId)
    .maybeSingle();
  if (branch.error) throw new Error(`Could not read branch: ${branch.error.message}`);
  if (!branch.data) throw new VendorNotFoundError("branch");

  const { data, error } = await supabase
    .from("vendor_contacts")
    .insert({ broker_id: brokerId, branch_id: branchId, ...input })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create contact: ${error.message}`);
  if (input.is_primary) await demoteOtherPrimaries(session, branchId, data.id);
  await logActivity(session, "vendor_contact", data.id, "vendor_contact.created", { branch_id: branchId, ...input });
  return { contactId: data.id };
}

export async function updateContact(session: BrokerSession, contactId: string, input: ContactInput): Promise<void> {
  const { supabase, brokerId } = session;
  const { data, error } = await supabase
    .from("vendor_contacts")
    .update(input)
    .eq("id", contactId)
    .eq("broker_id", brokerId)
    .select("id, branch_id")
    .maybeSingle();
  if (error) throw new Error(`Could not update contact: ${error.message}`);
  if (!data) throw new VendorNotFoundError("contact");
  if (input.is_primary) await demoteOtherPrimaries(session, data.branch_id, contactId);
  await logActivity(session, "vendor_contact", contactId, "vendor_contact.updated", { ...input });
}

export async function deleteContact(session: BrokerSession, contactId: string): Promise<void> {
  const { supabase, brokerId } = session;
  const { data, error } = await supabase
    .from("vendor_contacts")
    .delete()
    .eq("id", contactId)
    .eq("broker_id", brokerId)
    .select("id");
  if (error) throw new Error(`Could not delete contact: ${error.message}`);
  if (!data || data.length === 0) throw new VendorNotFoundError("contact");
  await logActivity(session, "vendor_contact", contactId, "vendor_contact.deleted", {});
}

/**
 * RFQs go to the branch's primary contact (routing.ts), so one branch keeps
 * one primary: marking a contact primary clears the flag on its siblings.
 */
async function demoteOtherPrimaries(session: BrokerSession, branchId: string, keepContactId: string): Promise<void> {
  const { supabase, brokerId } = session;
  const { error } = await supabase
    .from("vendor_contacts")
    .update({ is_primary: false })
    .eq("branch_id", branchId)
    .eq("broker_id", brokerId)
    .eq("is_primary", true)
    .neq("id", keepContactId);
  if (error) throw new Error(`Could not update the other contacts: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Makes the branch's capability set equal to categories: rows for categories
 * no longer wanted are deleted, new ones inserted (an existing (branch,
 * category) pair is left alone rather than failing the unique constraint).
 */
export async function setCapabilities(
  session: BrokerSession,
  branchId: string,
  categories: readonly MaterialCategory[],
): Promise<{ inserted: number; deleted: number }> {
  const { supabase, brokerId } = session;

  const branch = await supabase
    .from("vendor_branches")
    .select("id")
    .eq("id", branchId)
    .eq("broker_id", brokerId)
    .maybeSingle();
  if (branch.error) throw new Error(`Could not read branch: ${branch.error.message}`);
  if (!branch.data) throw new VendorNotFoundError("branch");

  const current = await supabase
    .from("vendor_capabilities")
    .select("category")
    .eq("branch_id", branchId)
    .eq("broker_id", brokerId);
  if (current.error) throw new Error(`Could not read vendor capabilities: ${current.error.message}`);

  const { toInsert, toDelete } = capabilityDiff(
    (current.data ?? []).map((row) => row.category),
    categories,
  );

  if (toDelete.length > 0) {
    const { error } = await supabase
      .from("vendor_capabilities")
      .delete()
      .eq("branch_id", branchId)
      .eq("broker_id", brokerId)
      .in("category", toDelete);
    if (error) throw new Error(`Could not remove vendor capabilities: ${error.message}`);
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("vendor_capabilities").upsert(
      toInsert.map((category) => ({ broker_id: brokerId, branch_id: branchId, category })),
      { onConflict: "branch_id,category", ignoreDuplicates: true },
    );
    if (error) throw new Error(`Could not add vendor capabilities: ${error.message}`);
  }

  if (toInsert.length > 0 || toDelete.length > 0) {
    await logActivity(session, "vendor_branch", branchId, "vendor_branch.capabilities_set", {
      added: toInsert,
      removed: toDelete,
    });
  }

  return { inserted: toInsert.length, deleted: toDelete.length };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** RFQs plus purchases that reference any of the branches. Zero for an empty list. */
async function countHistory(session: BrokerSession, branchIds: readonly string[]): Promise<number> {
  if (branchIds.length === 0) return 0;
  const { supabase, brokerId } = session;
  const ids = [...branchIds];
  const [rfqs, purchases] = await Promise.all([
    supabase.from("rfqs").select("id", { count: "exact", head: true }).eq("broker_id", brokerId).in("branch_id", ids),
    supabase
      .from("purchases")
      .select("id", { count: "exact", head: true })
      .eq("broker_id", brokerId)
      .in("branch_id", ids),
  ]);
  if (rfqs.error) throw new Error(`Could not count RFQs: ${rfqs.error.message}`);
  if (purchases.error) throw new Error(`Could not count purchases: ${purchases.error.message}`);
  return (rfqs.count ?? 0) + (purchases.count ?? 0);
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

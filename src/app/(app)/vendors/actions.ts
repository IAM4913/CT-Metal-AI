"use server";

// Vendor admin server actions (PRD FR-5): one per plain form on /vendors and
// /vendors/[id]. Each one checks the session, reads the posted fields out of
// the FormData, validates them with the form schemas in
// src/lib/server/vendors.ts, calls the lib, revalidates the vendor pages, and
// redirects back with ?saved=<what> or ?error=<code>. The page turns the code
// into a sentence (FLASH_MESSAGES in src/components/vendors/vendor-flash.tsx).
//
// A delete that the lib refuses (VendorInUseError: the branch has RFQ or
// purchase history) comes back as ?error=vendor_in_use&n=<count>, never as a
// foreign key error. A vendor the lib cannot find (deleted in another tab, a
// stale form) goes back to the list with ?error=not_found, since the vendor
// page itself would answer 404 and never show the message; a missing branch
// or contact stays on the vendor page, which still exists. redirect() throws,
// so it is always called outside the try/catch in attempt().

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  branchFormSchema,
  capabilitiesFormSchema,
  contactFormSchema,
  createBranch,
  createContact,
  createVendor,
  deleteBranch,
  deleteContact,
  deleteVendor,
  setCapabilities,
  updateBranch,
  updateContact,
  updateVendor,
  uuidSchema,
  vendorFormSchema,
  VendorInUseError,
  VendorNotFoundError,
} from "@/lib/server/vendors";
import { requireBroker } from "@/lib/server/session";

const VENDOR_FIELDS = ["name", "vendor_type", "website", "notes"] as const;
const BRANCH_FIELDS = [
  "name",
  "city",
  "state",
  "region",
  "preferred",
  "payment_terms",
  "early_pay_pct",
  "early_pay_days",
  "freight_default",
  "notes",
] as const;
const CONTACT_FIELDS = ["name", "email", "phone", "is_primary", "notes"] as const;

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export async function createVendorAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const parsed = vendorFormSchema.safeParse(fields(formData, VENDOR_FIELDS));
  if (!parsed.success) redirect("/vendors?error=vendor_invalid");

  const result = await attempt(() => createVendor(session, parsed.data));
  if (!result.ok) redirect(`/vendors?error=${result.code}`);

  revalidatePath("/vendors");
  redirect(`/vendors/${result.value.vendorId}?saved=vendor`);
}

export async function updateVendorAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const vendorId = uuidSchema.safeParse(formData.get("vendor_id"));
  if (!vendorId.success) redirect("/vendors?error=not_found");

  const parsed = vendorFormSchema.safeParse(fields(formData, VENDOR_FIELDS));
  if (!parsed.success) redirect(`/vendors/${vendorId.data}?error=vendor_invalid`);

  const result = await attempt(() => updateVendor(session, vendorId.data, parsed.data));
  if (!result.ok) redirect(result.code === "not_found" ? "/vendors?error=not_found" : `/vendors/${vendorId.data}?error=${result.code}`);

  revalidateVendor(vendorId.data);
  redirect(`/vendors/${vendorId.data}?saved=vendor`);
}

export async function deleteVendorAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const vendorId = uuidSchema.safeParse(formData.get("vendor_id"));
  if (!vendorId.success) redirect("/vendors?error=not_found");

  const result = await attempt(() => deleteVendor(session, vendorId.data));
  if (!result.ok) {
    redirect(result.code === "not_found" ? "/vendors?error=not_found" : `/vendors/${vendorId.data}?error=${result.code}${countParam(result)}`);
  }

  revalidateVendor(vendorId.data);
  redirect("/vendors?deleted=vendor");
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export async function createBranchAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const vendorId = uuidSchema.safeParse(formData.get("vendor_id"));
  if (!vendorId.success) redirect("/vendors?error=not_found");

  const parsed = branchFormSchema.safeParse(fields(formData, BRANCH_FIELDS));
  if (!parsed.success) redirect(`/vendors/${vendorId.data}?error=branch_invalid#add-branch`);

  const result = await attempt(() => createBranch(session, vendorId.data, parsed.data));
  if (!result.ok) redirect(`/vendors/${vendorId.data}?error=${result.code}`);

  revalidateVendor(vendorId.data);
  redirect(`/vendors/${vendorId.data}?saved=branch#branch-${result.value.branchId}`);
}

export async function updateBranchAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const ids = branchIds(formData);
  if (!ids) redirect("/vendors?error=not_found");

  const parsed = branchFormSchema.safeParse(fields(formData, BRANCH_FIELDS));
  if (!parsed.success) redirect(`/vendors/${ids.vendorId}?error=branch_invalid#branch-${ids.branchId}`);

  const result = await attempt(() => updateBranch(session, ids.branchId, parsed.data));
  if (!result.ok) redirect(`/vendors/${ids.vendorId}?error=${result.code}#branch-${ids.branchId}`);

  revalidateVendor(ids.vendorId);
  redirect(`/vendors/${ids.vendorId}?saved=branch#branch-${ids.branchId}`);
}

export async function deleteBranchAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const ids = branchIds(formData);
  if (!ids) redirect("/vendors?error=not_found");

  const result = await attempt(() => deleteBranch(session, ids.branchId));
  if (!result.ok) {
    redirect(`/vendors/${ids.vendorId}?error=${result.code}${countParam(result)}#branch-${ids.branchId}`);
  }

  revalidateVendor(ids.vendorId);
  redirect(`/vendors/${ids.vendorId}?deleted=branch`);
}

export async function setCapabilitiesAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const ids = branchIds(formData);
  if (!ids) redirect("/vendors?error=not_found");

  const parsed = capabilitiesFormSchema.safeParse(formData.getAll("categories"));
  if (!parsed.success) redirect(`/vendors/${ids.vendorId}?error=capabilities_invalid#branch-${ids.branchId}`);

  const result = await attempt(() => setCapabilities(session, ids.branchId, parsed.data));
  if (!result.ok) redirect(`/vendors/${ids.vendorId}?error=${result.code}#branch-${ids.branchId}`);

  revalidateVendor(ids.vendorId);
  redirect(`/vendors/${ids.vendorId}?saved=capabilities#branch-${ids.branchId}`);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function createContactAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const ids = branchIds(formData);
  if (!ids) redirect("/vendors?error=not_found");

  const parsed = contactFormSchema.safeParse(fields(formData, CONTACT_FIELDS));
  if (!parsed.success) redirect(`/vendors/${ids.vendorId}?error=contact_invalid#branch-${ids.branchId}`);

  const result = await attempt(() => createContact(session, ids.branchId, parsed.data));
  if (!result.ok) redirect(`/vendors/${ids.vendorId}?error=${result.code}#branch-${ids.branchId}`);

  revalidateVendor(ids.vendorId);
  redirect(`/vendors/${ids.vendorId}?saved=contact#branch-${ids.branchId}`);
}

export async function updateContactAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const ids = branchIds(formData);
  if (!ids) redirect("/vendors?error=not_found");
  const contactId = uuidSchema.safeParse(formData.get("contact_id"));
  if (!contactId.success) redirect(`/vendors/${ids.vendorId}?error=not_found#branch-${ids.branchId}`);

  const parsed = contactFormSchema.safeParse(fields(formData, CONTACT_FIELDS));
  if (!parsed.success) redirect(`/vendors/${ids.vendorId}?error=contact_invalid#branch-${ids.branchId}`);

  const result = await attempt(() => updateContact(session, contactId.data, parsed.data));
  if (!result.ok) redirect(`/vendors/${ids.vendorId}?error=${result.code}#branch-${ids.branchId}`);

  revalidateVendor(ids.vendorId);
  redirect(`/vendors/${ids.vendorId}?saved=contact#branch-${ids.branchId}`);
}

export async function deleteContactAction(formData: FormData): Promise<void> {
  const session = await requireBroker();

  const ids = branchIds(formData);
  if (!ids) redirect("/vendors?error=not_found");
  const contactId = uuidSchema.safeParse(formData.get("contact_id"));
  if (!contactId.success) redirect(`/vendors/${ids.vendorId}?error=not_found#branch-${ids.branchId}`);

  const result = await attempt(() => deleteContact(session, contactId.data));
  if (!result.ok) redirect(`/vendors/${ids.vendorId}?error=${result.code}#branch-${ids.branchId}`);

  revalidateVendor(ids.vendorId);
  redirect(`/vendors/${ids.vendorId}?deleted=contact#branch-${ids.branchId}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Attempt<T> = { ok: true; value: T } | { ok: false; code: string; count?: number };

/**
 * Run the write and fold any thrown error into a result with an error code the
 * page knows, so redirect() can run outside try/catch. An in-use refusal
 * carries its count for the message.
 */
async function attempt<T>(write: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await write() };
  } catch (error) {
    if (error instanceof VendorInUseError) {
      return { ok: false, code: error.kind === "vendor" ? "vendor_in_use" : "branch_in_use", count: error.count };
    }
    if (error instanceof VendorNotFoundError) return { ok: false, code: "not_found" };
    console.error("[vendors] write failed", error);
    return { ok: false, code: "failed" };
  }
}

function countParam(result: { ok: false; count?: number }): string {
  return result.count === undefined ? "" : `&n=${result.count}`;
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

/** The hidden vendor_id and branch_id a branch-level form posts, or null when either is not a uuid. */
function branchIds(formData: FormData): { vendorId: string; branchId: string } | null {
  const vendorId = uuidSchema.safeParse(formData.get("vendor_id"));
  const branchId = uuidSchema.safeParse(formData.get("branch_id"));
  if (!vendorId.success || !branchId.success) return null;
  return { vendorId: vendorId.data, branchId: branchId.data };
}

function revalidateVendor(vendorId: string): void {
  revalidatePath("/vendors");
  revalidatePath(`/vendors/${vendorId}`);
}

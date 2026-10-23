// Vendor matching (PRD FR-6, PLAN Step 5). Deterministic, no LLM.
//
// suggestBranchesForLine() is the AC-6.1 ranking: branches whose capabilities
// include the line's category, ordered by the explicit preferred flag, then by
// how many past purchases of that category came from the branch, then by
// vendor name and branch name (case-insensitive). Ties keep their input order,
// so the same inputs always give the same list.
//
// consolidateRecipients() and linesForBranch() turn the per-line choices into
// the request-level recipient list (AC-6.2) and back. tallyCategoryPurchases()
// and buildBranchesForRouting() shape database rows into the inputs; they live
// here so the shaping is tested without a database.

import type { MaterialCategory } from "@/lib/db/enums";

export type BranchForRouting = {
  branch_id: string;
  branch_name: string;
  vendor_id: string;
  vendor_name: string;
  preferred: boolean;
  categories: MaterialCategory[];
  /** The primary contact's email, or the first contact's when no contact is marked primary, or null. */
  primary_contact_email: string | null;
};

export type CategoryPurchaseCount = { branch_id: string; category: MaterialCategory; count: number };

/** The branches chosen for one request line. */
export type LineRouting = { lineId: string; branchIds: string[] };

/** Case-insensitive text order, locale independent so it is the same everywhere. */
export function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Vendor name, then branch name, case-insensitive. */
export function compareBranchNames(a: BranchForRouting, b: BranchForRouting): number {
  return compareText(a.vendor_name, b.vendor_name) || compareText(a.branch_name, b.branch_name);
}

/** Past purchases of one category from one branch, summed over every matching history row. */
export function purchaseCount(history: CategoryPurchaseCount[], branchId: string, category: MaterialCategory): number {
  let total = 0;
  for (const row of history) {
    if (row.branch_id === branchId && row.category === category) total += row.count;
  }
  return total;
}

/**
 * AC-6.1. Empty when the line has no category (AC-6.3: "no suggested
 * vendors"). Otherwise every branch whose categories include it, ranked
 * preferred first, then more past purchases of that category first, then
 * vendor name and branch name. Stable: equal branches keep their input order.
 */
export function suggestBranchesForLine(
  category: MaterialCategory | null,
  branches: BranchForRouting[],
  history: CategoryPurchaseCount[],
): BranchForRouting[] {
  if (category === null) return [];
  const ranked = branches
    .map((branch, index) => ({ branch, index, count: purchaseCount(history, branch.branch_id, category) }))
    .filter(({ branch }) => branch.categories.includes(category));
  ranked.sort((a, b) => {
    if (a.branch.preferred !== b.branch.preferred) return a.branch.preferred ? -1 : 1;
    if (a.count !== b.count) return b.count - a.count;
    return compareBranchNames(a.branch, b.branch) || a.index - b.index;
  });
  return ranked.map(({ branch }) => branch);
}

/**
 * AC-6.2: the request-level recipient list. Every branch that appears on any
 * line, once, sorted by vendor name then branch name. Branch ids that are not
 * in `branches` are skipped.
 */
export function consolidateRecipients(perLine: LineRouting[], branches: BranchForRouting[]): BranchForRouting[] {
  const byId = new Map(branches.map((branch) => [branch.branch_id, branch]));
  const seen = new Set<string>();
  const out: BranchForRouting[] = [];
  for (const line of perLine) {
    for (const branchId of line.branchIds) {
      if (seen.has(branchId)) continue;
      const branch = byId.get(branchId);
      if (!branch) continue;
      seen.add(branchId);
      out.push(branch);
    }
  }
  return out.sort(compareBranchNames);
}

/** The line ids routed to one branch, in perLine order. */
export function linesForBranch(perLine: LineRouting[], branchId: string): string[] {
  const out: string[] = [];
  for (const line of perLine) {
    if (line.branchIds.includes(branchId) && !out.includes(line.lineId)) out.push(line.lineId);
  }
  return out;
}

/**
 * One row per (branch, category) with the number of purchased lines in that
 * category from that branch. Input: one row per purchased request line, with
 * the purchase's branch and the line's category (null categories are skipped).
 */
export function tallyCategoryPurchases(
  rows: Array<{ branch_id: string; category: MaterialCategory | null }>,
): CategoryPurchaseCount[] {
  const counts = new Map<string, CategoryPurchaseCount>();
  for (const row of rows) {
    if (row.category === null) continue;
    const key = `${row.branch_id}\u0000${row.category}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { branch_id: row.branch_id, category: row.category, count: 1 });
  }
  return Array.from(counts.values());
}

export type VendorRow = { id: string; name: string };
export type BranchRow = { id: string; vendor_id: string; name: string; preferred: boolean };
export type CapabilityRow = { branch_id: string; category: MaterialCategory };
export type ContactRow = { branch_id: string; email: string; is_primary: boolean };

/**
 * Join the vendor directory rows into BranchForRouting values, sorted by
 * vendor name then branch name. A branch whose vendor is missing is skipped.
 * Contacts are taken in the order given (callers pass them by created_at), so
 * "first contact" is the oldest one.
 */
export function buildBranchesForRouting(
  vendors: VendorRow[],
  branches: BranchRow[],
  capabilities: CapabilityRow[],
  contacts: ContactRow[],
): BranchForRouting[] {
  const vendorById = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const out: BranchForRouting[] = [];
  for (const branch of branches) {
    const vendor = vendorById.get(branch.vendor_id);
    if (!vendor) continue;
    const categories = capabilities.filter((c) => c.branch_id === branch.id).map((c) => c.category);
    const own = contacts.filter((c) => c.branch_id === branch.id);
    const primary = own.find((c) => c.is_primary) ?? own[0] ?? null;
    out.push({
      branch_id: branch.id,
      branch_name: branch.name,
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      preferred: branch.preferred,
      categories: Array.from(new Set(categories)),
      primary_contact_email: primary ? primary.email : null,
    });
  }
  return out.sort(compareBranchNames);
}

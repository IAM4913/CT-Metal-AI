// Read side of the purchase history (PRD FR-11, AC-11.2 and AC-11.3).
//
// One PostgREST select on purchases pulls the whole chain behind each purchase
// line: purchase_lines -> sourcing_selections -> offer_lines -> the vendor
// offer (for the RFQ, the reply message, and the quote file) and the request
// line (for the description, category, unit, and the linked item's
// designation), plus the branch and vendor names and the request's subject and
// customer. Every embed follows one foreign key, so none needs a hint; the
// composite keys (child_id, broker_id) are what PostgREST uses to join.
//
// The database applies the date range on confirmed_at and the ordering. The
// other fields are matched in code by applyClientFilters so the matching is
// tested without a database. Phase 1 volumes are tiny; the trigram indexes on
// purchases.po_number and purchases.notes (0002_search.sql) are in place for a
// server-side ilike when the table grows.
//
// Every query runs through session.supabase (the RLS client), so another
// broker's purchases are never rows here.

import {
  applyClientFilters,
  flattenPurchases,
  type HistoryFilter,
  type HistoryRow,
  type RawHistoryPurchase,
} from "@/lib/history/filter";
import type { BrokerSession } from "@/lib/server/session";

// One string literal (not a joined array) so postgrest-js can parse it into the
// result type; RawHistoryPurchase in filter.ts mirrors the same shape. Every
// embed names its foreign key (the constraint names from 0001_init.sql, as
// src/lib/db/types.ts lists them) so PostgREST never has to guess a path, for
// example offer_lines -> request_lines, which sourcing_selections also joins.
// Kept on one line: a concatenation widens to `string` and the parser gives up.
const HISTORY_SELECT =
  "id, confirmed_at, po_number, request_id, branch_id, vendor_branches!purchases_branch_id_broker_id_fkey(name, vendors!vendor_branches_vendor_id_broker_id_fkey(name)), requests!purchases_request_id_broker_id_fkey(subject, customers!requests_customer_id_broker_id_fkey(name)), purchase_lines!purchase_lines_purchase_id_broker_id_fkey(id, sourcing_selections!purchase_lines_selection_id_broker_id_fkey(id, request_line_id, qty, offer_lines!sourcing_selections_offer_line_id_broker_id_fkey(id, offer_id, offered_desc, unit_price, price_basis, unit, vendor_offers!offer_lines_offer_id_broker_id_fkey(id, rfq_id, message_id, attachment_id, branch_id), request_lines!offer_lines_request_line_id_broker_id_fkey(id, description, category, catalog_item_id, unit, catalog_items!request_lines_catalog_item_id_fkey(designation)))))";

/** The first instant of a yyyy-mm-dd day in UTC, for a gte bound. */
export function dayStartUtc(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/** The last instant of a yyyy-mm-dd day in UTC, for an lte bound (inclusive range). */
export function dayEndUtc(day: string): string {
  return `${day}T23:59:59.999Z`;
}

/**
 * Purchase lines matching the filter, newest purchase first. The date range
 * is applied in the query (inclusive, on the UTC day, the same boundary
 * inDateRange uses); the other fields are matched after flattening.
 */
export async function searchHistory(session: BrokerSession, filter: HistoryFilter): Promise<HistoryRow[]> {
  let query = session.supabase
    .from("purchases")
    .select(HISTORY_SELECT)
    .eq("broker_id", session.brokerId)
    .order("confirmed_at", { ascending: false })
    .order("id", { ascending: true });
  if (filter.from !== undefined) query = query.gte("confirmed_at", dayStartUtc(filter.from));
  if (filter.to !== undefined) query = query.lte("confirmed_at", dayEndUtc(filter.to));

  const { data, error } = await query;
  if (error) {
    throw new Error(`Could not read purchase history: ${error.message}`);
  }
  const raw: RawHistoryPurchase[] = data ?? [];
  return applyClientFilters(flattenPurchases(raw), filter);
}

// Comparison, selection, and purchase, server side (PRD FR-10, FR-11, section
// 8, PLAN Step 7).
//
// Every read and write goes through session.supabase (the RLS client) and
// filters on session.brokerId as well; every row written carries broker_id and
// references its parents by (id, broker_id). Nothing here touches the admin
// client. The math lives in src/lib/compare (cost.ts, build.ts): this module
// loads rows, calls buildComparison() and groupSelectionsForPurchase(), and
// writes what comes back.
//
// loadComparison() reads the revision's RFQs, offers, and offer lines through
// loadOffersContext() (the same rows the Offers tab shows), the sourcing
// selections of the live request lines, and the catalog items the lines and
// offers link to (designation, category, dims, weight_per_ft: the conversion
// data PRD rule 2 needs), and builds the model.
//
// Selections (AC-10.6, PRD rule 5): one sourcing_selections row per request
// line and offer line. Selecting the same offer line again replaces the row's
// quantity rather than adding a second row. An alternate is selected only with
// confirmAlternate true (rule 3); without it the call fails with
// AlternateConfirmationError naming what changed, so the UI can show the
// confirm dialog. Whether a line is an alternate is isAlternate() from
// build.ts, not the stored flag alone: a row marked exact but linked to another
// catalog item, or writing another length or sheet size, is refused the same
// way (assertAlternateConfirmed). A line on an offer the vendor declined cannot
// be selected (selectionBlockedReason); undo the decline first. A selection
// that a purchase already holds (purchase_lines) cannot be changed or removed.
// Once a request is sourced or closed no new selection is taken; a later buy is
// a Phase 2 question.
//
// confirmPurchase() (AC-11.1) is the one explicit purchase action. It takes the
// selections no purchase holds yet, groups them by branch (offer_lines ->
// vendor_offers.branch_id), writes one purchases row per branch with totals
// that are null whenever any part is unknown (rule 1), one purchase_lines row
// per selection, moves the request to "sourced", and logs purchase.confirmed
// per purchase. RFQ statuses stay as they are (responded): the RFQ was
// answered, and the purchase is the record of the decision. There is no
// transaction across these writes; a failure part way leaves the purchases
// already written (each is logged) and the error names the step.

import { z } from "zod";
import type { Tables, TablesInsert } from "@/lib/db/client";
import type { Json } from "@/lib/db/types";
import {
  buildComparison,
  changesForOfferLine,
  groupSelectionsForPurchase,
  isAlternate,
  selectionBlockedReason,
  type BranchInput,
  type CatalogItemInput,
  type ComparisonModel,
  type OfferCell,
  type SelectionInput,
} from "@/lib/compare/build";
import type { RequestStatus } from "@/lib/db/enums";
import { loadOffer, loadOffersContext } from "@/lib/server/offers";
import type { BrokerSession } from "@/lib/server/session";

type SelectionRow = Tables<"sourcing_selections">;
type OfferLineRow = Tables<"offer_lines">;
type RequestLineRow = Tables<"request_lines">;

// ---------------------------------------------------------------------------
// Schemas (shared with the server actions) and errors
// ---------------------------------------------------------------------------

/** "" and whitespace become null; otherwise the trimmed text. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value));

export const selectionQtySchema = z.number().positive("Quantity must be more than zero");

export const selectOfferLineInputSchema = z.object({
  requestLineId: z.uuid(),
  offerLineId: z.uuid(),
  qty: selectionQtySchema,
  note: optionalText(500),
  confirmAlternate: z.boolean(),
});
export type SelectOfferLineInput = z.infer<typeof selectOfferLineInputSchema>;

export const purchaseInputSchema = z.object({
  poNumber: optionalText(80),
  notes: optionalText(2000),
});
export type PurchaseInput = z.infer<typeof purchaseInputSchema>;

/** Statuses in which the purchase is on record and selections are closed. */
export const SELECTION_CLOSED_STATUSES: readonly RequestStatus[] = ["sourced", "closed"];

export const NO_SELECTIONS_ERROR = "Select at least one offer before confirming a purchase.";
export const ALL_PURCHASED_ERROR = "Every selection on this request is already on a purchase. Select more to buy again.";

/** The difference text an alternate confirmation must name (PRD rule 3). */
export function alternateDifference(changed: readonly string[]): string {
  return changed.length === 0 ? "differs from the request" : changed.join("; ");
}

export class AlternateConfirmationError extends Error {
  readonly changed: string[];

  constructor(changed: readonly string[]) {
    super(`This offer is an alternate (${alternateDifference(changed)}). Confirm the difference to select it.`);
    this.name = "AlternateConfirmationError";
    this.changed = [...changed];
  }
}

/**
 * PRD section 8 rule 3, server side: an alternate is selected only when the
 * caller confirmed the difference. Throws AlternateConfirmationError (naming
 * what changed) for an alternate without confirmAlternate; returns for an
 * exact line, or for an alternate the caller confirmed.
 */
export function assertAlternateConfirmed(alternate: boolean, confirmAlternate: boolean, changed: readonly string[]): void {
  if (alternate && !confirmAlternate) {
    throw new AlternateConfirmationError(changed);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The comparison model for one request (its current revision's RFQs, offers,
 * and lines), built from rows read under RLS. Throws when the request is not
 * visible.
 */
export async function loadComparison(session: BrokerSession, requestId: string): Promise<ComparisonModel> {
  const context = await loadOffersContext(session, requestId);
  const liveLines = context.lines.filter((line) => line.status !== "removed");
  const offerLines = context.offers.flatMap((offer) => offer.lines);

  const [selections, catalogById] = await Promise.all([
    loadSelectionsForLines(
      session,
      liveLines.map((line) => line.id),
    ),
    loadCatalogItems(session, [
      ...liveLines.map((line) => line.catalog_item_id),
      ...offerLines.map((line) => line.offered_catalog_item_id),
    ]),
  ]);

  const branches: BranchInput[] = context.rfqs.map((rfq) => ({ id: rfq.branch_id, name: rfq.branch_name, vendor_name: rfq.vendor_name }));

  return buildComparison({
    lines: context.lines,
    offers: context.offers,
    offerLines,
    rfqs: context.rfqs,
    branches,
    selections,
    catalogById,
  });
}

// ---------------------------------------------------------------------------
// Selections
// ---------------------------------------------------------------------------

/**
 * Select an offer line for a request line with a quantity in the request
 * line's unit (AC-10.6). A second selection of the same offer line replaces
 * its quantity and note. An alternate (isAlternate, the data and not the flag
 * alone) needs confirmAlternate (rule 3); a line on a declined offer is
 * refused. Returns the selection id and the request it belongs to (for
 * revalidation).
 */
export async function selectOfferLine(session: BrokerSession, input: SelectOfferLineInput): Promise<{ selectionId: string; requestId: string }> {
  const offerLine = await loadOfferLine(session, input.offerLineId);
  if (offerLine.request_line_id !== input.requestLineId) {
    throw new Error("That offer does not answer this request line.");
  }
  const offer = await loadOffer(session, offerLine.offer_id);
  const blocked = selectionBlockedReason(offer.status);
  if (blocked !== null) {
    throw new Error(blocked);
  }
  const line = await loadRequestLine(session, input.requestLineId);
  if (line.status === "removed") {
    throw new Error("This request line was removed. Nothing can be selected for it.");
  }
  const request = await loadRequest(session, line.request_id);
  if (SELECTION_CLOSED_STATUSES.includes(request.status)) {
    throw new Error("This request has been sourced. Its selections are closed.");
  }

  const catalogById = await loadCatalogItems(session, [line.catalog_item_id, offerLine.offered_catalog_item_id]);
  const changed = changesForOfferLine(line, offerLine, catalogById);
  const alternate = isAlternate(line, offerLine, catalogById);
  assertAlternateConfirmed(alternate, input.confirmAlternate, changed);

  const existing = await findSelection(session, line.id, offerLine.id);
  const now = new Date().toISOString();
  const payload: { [key: string]: Json | undefined } = {
    request_id: request.id,
    request_line_id: line.id,
    offer_line_id: offerLine.id,
    offer_id: offerLine.offer_id,
    qty: input.qty,
    unit: line.unit,
    note: input.note,
    alternate,
    changed,
    difference: alternate ? alternateDifference(changed) : null,
    confirmed_alternate: alternate ? input.confirmAlternate : null,
  };

  if (existing) {
    await assertNotPurchased(session, [existing.id], "This selection is already on a purchase and cannot be changed.");
    const { error } = await session.supabase
      .from("sourcing_selections")
      .update({ qty: input.qty, note: input.note, selected_at: now })
      .eq("broker_id", session.brokerId)
      .eq("id", existing.id);
    if (error) {
      throw new Error(`Could not update the selection: ${error.message}`);
    }
    await logActivity(session, "sourcing_selection", existing.id, "selection.made", {
      ...payload,
      replaced: { qty: existing.qty, note: existing.note },
    });
    return { selectionId: existing.id, requestId: request.id };
  }

  const row: TablesInsert<"sourcing_selections"> = {
    broker_id: session.brokerId,
    request_line_id: line.id,
    offer_line_id: offerLine.id,
    qty: input.qty,
    selected_at: now,
    note: input.note,
  };
  const { data, error } = await session.supabase.from("sourcing_selections").insert(row).select("id").single();
  if (error) {
    throw new Error(`Could not save the selection: ${error.message}`);
  }
  await logActivity(session, "sourcing_selection", data.id, "selection.made", payload);
  return { selectionId: data.id, requestId: request.id };
}

/** Remove one selection. Refused when a purchase holds it. */
export async function unselectOfferLine(session: BrokerSession, selectionId: string): Promise<{ requestId: string }> {
  const selection = await loadSelection(session, selectionId);
  const line = await loadRequestLine(session, selection.request_line_id);
  await assertNotPurchased(session, [selection.id], "This selection is already on a purchase and cannot be removed.");

  const { error } = await session.supabase.from("sourcing_selections").delete().eq("broker_id", session.brokerId).eq("id", selection.id);
  if (error) {
    throw new Error(`Could not remove the selection: ${error.message}`);
  }
  await logActivity(session, "sourcing_selection", selection.id, "selection.removed", {
    request_id: line.request_id,
    before: selectionFields(selection),
  });
  return { requestId: line.request_id };
}

/** Change one selection's quantity (a split adjusted). Refused when a purchase holds it. */
export async function updateSelectionQty(session: BrokerSession, selectionId: string, qty: number): Promise<{ requestId: string }> {
  const quantity = selectionQtySchema.parse(qty);
  const selection = await loadSelection(session, selectionId);
  const line = await loadRequestLine(session, selection.request_line_id);
  await assertNotPurchased(session, [selection.id], "This selection is already on a purchase and cannot be changed.");

  if (selection.qty === quantity) return { requestId: line.request_id };

  const { error } = await session.supabase
    .from("sourcing_selections")
    .update({ qty: quantity, selected_at: new Date().toISOString() })
    .eq("broker_id", session.brokerId)
    .eq("id", selection.id);
  if (error) {
    throw new Error(`Could not update the selection: ${error.message}`);
  }
  await logActivity(session, "sourcing_selection", selection.id, "selection.updated", {
    request_id: line.request_id,
    request_line_id: selection.request_line_id,
    offer_line_id: selection.offer_line_id,
    before: { qty: selection.qty },
    after: { qty: quantity },
  });
  return { requestId: line.request_id };
}

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

/**
 * AC-11.1: turn the current selections into one purchases row per branch with
 * purchase_lines, set the request to "sourced", and log purchase.confirmed
 * per purchase. Only selections no purchase holds yet are taken, so confirming
 * twice never buys the same material twice. Totals are null when any part is
 * unknown (PRD rule 1). Returns the new purchase ids in vendor order.
 */
export async function confirmPurchase(session: BrokerSession, requestId: string, input: PurchaseInput): Promise<{ purchaseIds: string[] }> {
  const request = await loadRequest(session, requestId);
  const model = await loadComparison(session, request.id);

  const cells: OfferCell[] = model.lines.flatMap((entry) => entry.offers);
  const selections: SelectionInput[] = model.lines.flatMap((entry) =>
    entry.selections.map((selection) => ({
      id: selection.selection_id,
      request_line_id: entry.line.id,
      offer_line_id: selection.offer_line_id,
      qty: selection.qty,
      note: selection.note,
    })),
  );
  if (selections.length === 0) {
    throw new Error(NO_SELECTIONS_ERROR);
  }
  const purchased = await loadPurchasedSelectionIds(
    session,
    selections.map((selection) => selection.id),
  );
  const pending = selections.filter((selection) => !purchased.has(selection.id));
  if (pending.length === 0) {
    throw new Error(ALL_PURCHASED_ERROR);
  }

  const groups = groupSelectionsForPurchase(cells, pending);
  const confirmedAt = new Date().toISOString();
  const purchaseIds: string[] = [];

  for (const group of groups) {
    const purchase: TablesInsert<"purchases"> = {
      broker_id: session.brokerId,
      request_id: request.id,
      branch_id: group.branch_id,
      confirmed_at: confirmedAt,
      po_number: input.poNumber,
      total_material: group.total_material,
      total_freight: group.total_freight,
      notes: input.notes ?? "",
    };
    const inserted = await session.supabase.from("purchases").insert(purchase).select("id").single();
    if (inserted.error) {
      throw new Error(`Could not record the purchase from ${group.vendor_name} ${group.branch_name}: ${inserted.error.message}`);
    }
    const purchaseId = inserted.data.id;

    const lines: TablesInsert<"purchase_lines">[] = group.selection_ids.map((selectionId) => ({
      broker_id: session.brokerId,
      purchase_id: purchaseId,
      selection_id: selectionId,
    }));
    const { error: linesError } = await session.supabase.from("purchase_lines").insert(lines);
    if (linesError) {
      throw new Error(`Could not record the purchase lines from ${group.vendor_name} ${group.branch_name}: ${linesError.message}`);
    }

    await logActivity(session, "purchase", purchaseId, "purchase.confirmed", {
      request_id: request.id,
      branch_id: group.branch_id,
      vendor_name: group.vendor_name,
      branch_name: group.branch_name,
      selection_ids: group.selection_ids,
      offer_ids: group.offer_ids,
      totals: { total_material: group.total_material, total_freight: group.total_freight },
      unknowns: group.unknowns,
      po_number: input.poNumber,
      confirmed_at: confirmedAt,
    });
    purchaseIds.push(purchaseId);
  }

  if (request.status !== "closed" && request.status !== "sourced") {
    const { error } = await session.supabase
      .from("requests")
      .update({ status: "sourced" })
      .eq("broker_id", session.brokerId)
      .eq("id", request.id);
    if (error) {
      throw new Error(`Could not update the request status: ${error.message}`);
    }
    await logActivity(session, "request", request.id, "request.sourced", {
      before: { status: request.status },
      after: { status: "sourced" },
      purchase_ids: purchaseIds,
    });
  }

  return { purchaseIds };
}

// ---------------------------------------------------------------------------
// Row reads and writes
// ---------------------------------------------------------------------------

async function loadRequest(session: BrokerSession, requestId: string): Promise<Tables<"requests">> {
  const { data, error } = await session.supabase
    .from("requests")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", requestId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read request: ${error.message}`);
  }
  if (!data) {
    throw new Error("Request not found.");
  }
  return data;
}

async function loadRequestLine(session: BrokerSession, lineId: string): Promise<RequestLineRow> {
  const { data, error } = await session.supabase
    .from("request_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", lineId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the request line: ${error.message}`);
  }
  if (!data) {
    throw new Error("Request line not found.");
  }
  return data;
}

async function loadOfferLine(session: BrokerSession, offerLineId: string): Promise<OfferLineRow> {
  const { data, error } = await session.supabase
    .from("offer_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", offerLineId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the offer line: ${error.message}`);
  }
  if (!data) {
    throw new Error("Offer line not found.");
  }
  return data;
}

async function loadSelection(session: BrokerSession, selectionId: string): Promise<SelectionRow> {
  const { data, error } = await session.supabase
    .from("sourcing_selections")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", selectionId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the selection: ${error.message}`);
  }
  if (!data) {
    throw new Error("Selection not found.");
  }
  return data;
}

/** The selection of one offer line for one request line, when it exists (the pair is unique by construction). */
async function findSelection(session: BrokerSession, requestLineId: string, offerLineId: string): Promise<SelectionRow | null> {
  const { data, error } = await session.supabase
    .from("sourcing_selections")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("request_line_id", requestLineId)
    .eq("offer_line_id", offerLineId)
    .order("selected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the selections: ${error.message}`);
  }
  return data;
}

/** Every selection on these request lines, oldest first. */
async function loadSelectionsForLines(session: BrokerSession, lineIds: string[]): Promise<SelectionRow[]> {
  if (lineIds.length === 0) return [];
  const { data, error } = await session.supabase
    .from("sourcing_selections")
    .select("*")
    .eq("broker_id", session.brokerId)
    .in("request_line_id", lineIds)
    .order("selected_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    throw new Error(`Could not read the selections: ${error.message}`);
  }
  return data ?? [];
}

/** The ids among these selections that a purchase already holds. */
async function loadPurchasedSelectionIds(session: BrokerSession, selectionIds: string[]): Promise<Set<string>> {
  if (selectionIds.length === 0) return new Set();
  const { data, error } = await session.supabase
    .from("purchase_lines")
    .select("selection_id")
    .eq("broker_id", session.brokerId)
    .in("selection_id", selectionIds);
  if (error) {
    throw new Error(`Could not read the purchase lines: ${error.message}`);
  }
  return new Set((data ?? []).map((row) => row.selection_id));
}

async function assertNotPurchased(session: BrokerSession, selectionIds: string[], message: string): Promise<void> {
  const purchased = await loadPurchasedSelectionIds(session, selectionIds);
  if (purchased.size > 0) {
    throw new Error(message);
  }
}

/**
 * Catalog items by id (the catalog is readable by every member, no broker_id).
 * Nulls and repeats in the ids are dropped.
 */
async function loadCatalogItems(session: BrokerSession, ids: Array<string | null>): Promise<Map<string, CatalogItemInput>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => id !== null)));
  if (unique.length === 0) return new Map();
  const { data, error } = await session.supabase.from("catalog_items").select("id, designation, category, dims, weight_per_ft").in("id", unique);
  if (error) {
    throw new Error(`Could not read catalog items: ${error.message}`);
  }
  return new Map(
    (data ?? []).map((item) => [
      item.id,
      { designation: item.designation, category: item.category, dims: item.dims, weight_per_ft: item.weight_per_ft },
    ]),
  );
}

function selectionFields(row: SelectionRow): { [key: string]: Json | undefined } {
  return {
    request_line_id: row.request_line_id,
    offer_line_id: row.offer_line_id,
    qty: row.qty,
    note: row.note,
    selected_at: row.selected_at,
  };
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

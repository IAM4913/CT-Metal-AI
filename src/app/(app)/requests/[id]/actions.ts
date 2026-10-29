"use server";

// Server actions for the request workspace: Review (PRD FR-2, FR-3), Route
// (FR-6), RFQs (FR-7, FR-8), Offers (FR-9), and Compare (FR-10, FR-11). Thin wrappers: each one checks the session,
// validates its arguments with Zod, calls the lib function in src/lib/server,
// revalidates the request pages, and returns a plain result. Nothing here
// throws to the client: a failure is logged server-side and comes back as
// { ok: false, error } so the UI can show it in place.
//
// Revision guard (AC-8.4): every line edit first asks whether the line's
// request has a sent RFQ. When it does, the edit creates a new revision
// (createRevision), is applied to the copied line there, and the result
// carries redirectTo: "/requests/<newRequestId>", which the client follows
// with router.push. The old revision keeps its RFQs and messages. Once that
// child exists the old revision is superseded: an edit on it is refused with
// a message naming the newer revision (and redirectTo pointing at it) instead
// of forking a second child with the same revision number. The routing and
// send paths refuse a superseded request inside the lib.
//
// requireBroker() redirects to /login when nobody is signed in. redirect()
// works by throwing, so it is called before the try/catch in attempt(), never
// inside it.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseRequest } from "@/lib/server/parse-request";
import {
  addLine,
  clearLineFlags,
  confirmRequest,
  createRevision,
  lineEditSchema,
  linkLineToItem,
  mergeLines,
  removeLine,
  requestHasSentRfqs,
  searchCatalog,
  updateLine,
} from "@/lib/server/review";
import type { MatchedBy } from "@/lib/db/enums";
import {
  addOfferLine,
  createManualOffer,
  extractOffer,
  ingestReply,
  listOpenRfqs,
  manualOfferInputSchema,
  manualOfferLineSchema,
  markOfferReviewed,
  NeedsRfqChoiceError,
  OfferExtractionError,
  offerLinePatchSchema,
  offerPatchSchema,
  removeOfferLine,
  setOfferDeclined,
  updateOffer,
  updateOfferLine,
  type IngestInput,
  type OpenRfq,
} from "@/lib/server/offers";
import {
  confirmPurchase,
  purchaseInputSchema,
  selectionQtySchema,
  selectOfferLine,
  selectOfferLineInputSchema,
  unselectOfferLine,
  updateSelectionQty,
} from "@/lib/server/compare";
import { findChildRevision, SupersededError } from "@/lib/server/revisions";
import { retryRfq, sendAll } from "@/lib/server/rfq-send";
import {
  draftPatchSchema,
  markRequestDrafted,
  regenerateDraft,
  setLineBranches,
  updateDraft,
} from "@/lib/server/routing";
import { requireBroker, type BrokerSession } from "@/lib/server/session";

type Ok<T> = { ok: true } & T;
/** redirectTo on a failure points at the revision that should take the edit (SupersededError). */
type Failed = { ok: false; error: string; redirectTo?: string };
type ActionResult<T = object> = Ok<T> | Failed;

/** Line edits may land on a new revision; the client then navigates there. */
type Redirecting = { redirectTo?: string };

const idSchema = z.uuid();
const searchSchema = z.string().trim().min(1).max(120);
const branchIdsSchema = z.array(z.uuid()).max(100);

// A new line needs a description; everything else may be left blank and is
// flagged by computeLineFlags in the lib, never filled in.
const addLineSchema = lineEditSchema.extend({
  description: z.string().trim().min(1, "Description is required"),
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export async function parseRequestAction(
  requestId: string,
): Promise<ActionResult<{ lineCount: number } & Redirecting>> {
  const session = await requireBroker();
  return attempt("parseRequest", async () => {
    const id = idSchema.parse(requestId);
    const target = await editableRequest(session, id);
    const { lineCount } = await parseRequest(session, target.requestId);
    revalidateRequest(target.requestId);
    return { lineCount, ...redirecting(target) };
  });
}

// ---------------------------------------------------------------------------
// Line edits
// ---------------------------------------------------------------------------

export async function updateLineAction(lineId: string, patch: unknown): Promise<ActionResult<Redirecting>> {
  const session = await requireBroker();
  return attempt("updateLine", async () => {
    const id = idSchema.parse(lineId);
    const edit = lineEditSchema.parse(patch);
    const target = await editableLine(session, id);
    await updateLine(session, target.lineId, edit);
    revalidateRequest(target.requestId);
    return redirecting(target);
  });
}

export async function addLineAction(requestId: string, input: unknown): Promise<ActionResult<Redirecting>> {
  const session = await requireBroker();
  return attempt("addLine", async () => {
    const id = idSchema.parse(requestId);
    const line = addLineSchema.parse(input);
    const target = await editableRequest(session, id);
    await addLine(session, target.requestId, line);
    revalidateRequest(target.requestId);
    return redirecting(target);
  });
}

export async function removeLineAction(lineId: string): Promise<ActionResult<Redirecting>> {
  const session = await requireBroker();
  return attempt("removeLine", async () => {
    const id = idSchema.parse(lineId);
    const target = await editableLine(session, id);
    await removeLine(session, target.lineId);
    revalidateRequest(target.requestId);
    return redirecting(target);
  });
}

export async function mergeLinesAction(keepId: string, dropId: string): Promise<ActionResult<Redirecting>> {
  const session = await requireBroker();
  return attempt("mergeLines", async () => {
    const keep = idSchema.parse(keepId);
    const drop = idSchema.parse(dropId);
    if (keep === drop) throw new Error("Pick two different lines to merge");
    const target = await editableLine(session, keep);
    const mappedDrop = target.lineIdMap ? target.lineIdMap.get(drop) : drop;
    if (!mappedDrop) throw new Error("Line not found in the new revision");
    await mergeLines(session, target.lineId, mappedDrop);
    revalidateRequest(target.requestId);
    return redirecting(target);
  });
}

export async function linkLineToItemAction(lineId: string, catalogItemId: string): Promise<ActionResult<Redirecting>> {
  const session = await requireBroker();
  return attempt("linkLineToItem", async () => {
    const id = idSchema.parse(lineId);
    const itemId = idSchema.parse(catalogItemId);
    const target = await editableLine(session, id);
    await linkLineToItem(session, target.lineId, itemId);
    revalidateRequest(target.requestId);
    return redirecting(target);
  });
}

export async function clearLineFlagsAction(lineId: string): Promise<ActionResult<Redirecting>> {
  const session = await requireBroker();
  return attempt("clearLineFlags", async () => {
    const id = idSchema.parse(lineId);
    const target = await editableLine(session, id);
    await clearLineFlags(session, target.lineId);
    revalidateRequest(target.requestId);
    return redirecting(target);
  });
}

// ---------------------------------------------------------------------------
// Request level
// ---------------------------------------------------------------------------

export async function confirmRequestAction(requestId: string): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("confirmRequest", async () => {
    const id = idSchema.parse(requestId);
    if (await requestHasSentRfqs(session, id)) {
      throw new Error("This revision has been sent. Edit a line to start a new revision, then confirm that one.");
    }
    await confirmRequest(session, id);
    revalidateRequest(id);
    return {};
  });
}

// The result rows are the lib's { id, designation, category }; the dialog
// types them with Awaited<ReturnType<typeof searchCatalogAction>>, since a
// "use server" module exports only async functions.
export async function searchCatalogAction(q: string) {
  const session = await requireBroker();
  return attempt("searchCatalog", async () => {
    const query = searchSchema.parse(q);
    const results = await searchCatalog(session, query);
    return { results };
  });
}

// ---------------------------------------------------------------------------
// Routing (Route tab)
// ---------------------------------------------------------------------------

/** Set the branches one line is routed to; creates, fills, and prunes the per-branch drafts. */
export async function setLineBranchesAction(
  requestId: string,
  lineId: string,
  branchIds: unknown,
): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("setLineBranches", async () => {
    const id = idSchema.parse(requestId);
    const line = idSchema.parse(lineId);
    const branches = branchIdsSchema.parse(branchIds);
    await setLineBranches(session, id, line, branches);
    revalidateRequest(id);
    return {};
  });
}

/** Move a reviewed request to rfqs_drafted. redirectTo points at the RFQs tab for the client to follow. */
export async function markRequestDraftedAction(requestId: string): Promise<ActionResult<Redirecting>> {
  const session = await requireBroker();
  return attempt("markRequestDrafted", async () => {
    const id = idSchema.parse(requestId);
    await markRequestDrafted(session, id);
    revalidateRequest(id);
    return { redirectTo: `/requests/${id}/rfqs` };
  });
}

// ---------------------------------------------------------------------------
// Drafts and sending (RFQs tab)
// ---------------------------------------------------------------------------

export async function regenerateDraftAction(rfqId: string): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("regenerateDraft", async () => {
    const id = idSchema.parse(rfqId);
    const requestId = await requestIdForRfq(session, id);
    await regenerateDraft(session, id);
    revalidateRequest(requestId);
    return {};
  });
}

export async function updateDraftAction(rfqId: string, patch: unknown): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("updateDraft", async () => {
    const id = idSchema.parse(rfqId);
    const edit = draftPatchSchema.parse(patch);
    const requestId = await requestIdForRfq(session, id);
    await updateDraft(session, id, edit);
    revalidateRequest(requestId);
    return {};
  });
}

// The outcomes are the lib's SendOutcome[]; the client types them with
// Awaited<ReturnType<typeof sendAllAction>>.
export async function sendAllAction(requestId: string) {
  const session = await requireBroker();
  return attempt("sendAll", async () => {
    const id = idSchema.parse(requestId);
    const outcomes = await sendAll(session, id);
    revalidateRequest(id);
    return { outcomes };
  });
}

export async function retryRfqAction(rfqId: string) {
  const session = await requireBroker();
  return attempt("retryRfq", async () => {
    const id = idSchema.parse(rfqId);
    const requestId = await requestIdForRfq(session, id);
    const outcome = await retryRfq(session, id);
    revalidateRequest(requestId);
    return { outcome };
  });
}

// ---------------------------------------------------------------------------
// Helpers (not exported: a "use server" module may export only async functions)
// ---------------------------------------------------------------------------

async function attempt<T extends object>(name: string, work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const value = await work();
    return { ok: true, ...value };
  } catch (error) {
    console.error(`[requests] ${name} failed`, error);
    if (error instanceof SupersededError) {
      return { ok: false, error: error.message, redirectTo: error.redirectTo };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
    return `Invalid input. ${where}${first?.message ?? "check the values"}`;
  }
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "Something went wrong. Try again.";
}

/** Where an edit lands: the request itself, or the new revision created for it. */
type EditTarget = {
  requestId: string;
  lineId: string;
  /** Set when a revision was created: old line id -> new line id. */
  lineIdMap: Map<string, string> | null;
  /** The old request, when a revision was created. */
  revisedFrom: string | null;
};

/**
 * AC-8.4 guard for a request-level edit. A request that already has a newer
 * revision is refused (the edit belongs there). Otherwise, when the request
 * has a sent RFQ, a new revision is created and the edit goes there.
 */
async function editableRequest(session: BrokerSession, requestId: string): Promise<EditTarget> {
  const child = await findChildRevision(session, requestId);
  if (child) throw new SupersededError(child);
  if (!(await requestHasSentRfqs(session, requestId))) {
    return { requestId, lineId: "", lineIdMap: null, revisedFrom: null };
  }
  const { newRequestId, lineIdMap } = await createRevision(session, requestId);
  revalidateRequest(requestId);
  return { requestId: newRequestId, lineId: "", lineIdMap, revisedFrom: requestId };
}

/**
 * AC-8.4 guard for a line edit: the line's request, revised when needed, with
 * the line id mapped into the new revision.
 */
async function editableLine(session: BrokerSession, lineId: string): Promise<EditTarget> {
  const requestId = await requestIdForLine(session, lineId);
  const target = await editableRequest(session, requestId);
  if (target.lineIdMap === null) return { ...target, lineId };
  const mapped = target.lineIdMap.get(lineId);
  if (!mapped) throw new Error("Line not found in the new revision");
  return { ...target, lineId: mapped };
}

function redirecting(target: EditTarget): Redirecting {
  return target.revisedFrom === null ? {} : { redirectTo: `/requests/${target.requestId}` };
}

/**
 * The request a line belongs to, read under RLS so a line id from another
 * broker is "not found" rather than a row. Used only to know which page to
 * revalidate; the lib function does its own loading and checks.
 */
async function requestIdForLine(session: BrokerSession, lineId: string): Promise<string> {
  const { data, error } = await session.supabase
    .from("request_lines")
    .select("request_id")
    .eq("broker_id", session.brokerId)
    .eq("id", lineId)
    .maybeSingle();
  if (error) throw new Error(`Could not read line: ${error.message}`);
  if (!data) throw new Error("Line not found");
  return data.request_id;
}

/** The request an RFQ belongs to, read under RLS; same purpose as requestIdForLine. */
async function requestIdForRfq(session: BrokerSession, rfqId: string): Promise<string> {
  const { data, error } = await session.supabase
    .from("rfqs")
    .select("request_id")
    .eq("broker_id", session.brokerId)
    .eq("id", rfqId)
    .maybeSingle();
  if (error) throw new Error(`Could not read RFQ: ${error.message}`);
  if (!data) throw new Error("RFQ not found");
  return data.request_id;
}

function revalidateRequest(requestId: string): void {
  const base = `/requests/${requestId}`;
  revalidatePath(base);
  revalidatePath(`${base}/route`);
  revalidatePath(`${base}/rfqs`);
  revalidatePath(`${base}/offers`);
  revalidatePath(`${base}/compare`);
  // Work queue counts by status (Step 8) change when a request is parsed, confirmed, drafted, sent, or answered.
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Offers (Offers tab, PRD FR-9)
// ---------------------------------------------------------------------------

// Reply files share the .eml cap of /requests/new (MAX_EML_BYTES there); the
// page copy says 10 MB and serverActions.bodySizeLimit sits above it.
const MAX_REPLY_FILE_BYTES = 10 * 1024 * 1024;

const replyModeSchema = z.enum(["paste", "eml", "pdf"]);

/** A select or hidden field that may be blank: "" and a missing field both become null. */
const optionalRfqId = z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? null : value), z.uuid().nullable());

const replyFileSchema = z
  .instanceof(File)
  .refine((file) => file.size > 0, { message: "The file is empty." })
  .refine((file) => file.size <= MAX_REPLY_FILE_BYTES, { message: "The file is over 10 MB." });

const emlReplyFileSchema = replyFileSchema.refine((file) => /\.eml$/i.test(file.name) || file.type === "message/rfc822", {
  message: "Choose an .eml file.",
});
const pdfReplyFileSchema = replyFileSchema.refine((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf", {
  message: "Choose a PDF file.",
});

const ingestFormSchema = z.object({
  requestId: idSchema,
  rfqId: optionalRfqId,
  mode: replyModeSchema,
});

type IngestReplyResult =
  | { ok: true; offerId: string; rfqId: string; matchedBy: MatchedBy; needsRfqChoice: false }
  | { ok: false; error: string; needsRfqChoice?: boolean; openRfqs?: OpenRfq[]; offerId?: string };

/**
 * Ingest a vendor reply from the Add reply panel. FormData fields: requestId,
 * mode ("paste" | "eml" | "pdf"), rfqId (optional; required for paste and pdf,
 * auto-detected from headers for eml when blank), text (paste), file (eml, pdf).
 * Answers needsRfqChoice with the open RFQs when the headers match none and no
 * rfqId was given; the panel resubmits with the broker's pick.
 */
export async function ingestReplyAction(formData: FormData): Promise<IngestReplyResult> {
  const session = await requireBroker();
  try {
    const form = ingestFormSchema.parse({
      requestId: formData.get("requestId"),
      rfqId: formData.get("rfqId"),
      mode: formData.get("mode"),
    });

    const input: IngestInput = { requestId: form.requestId, rfqId: form.rfqId, mode: form.mode };
    if (form.mode === "paste") {
      const text = formData.get("text");
      if (typeof text !== "string" || text.trim() === "") throw new Error("Paste the reply text first.");
      input.text = text;
    } else {
      const file = (form.mode === "eml" ? emlReplyFileSchema : pdfReplyFileSchema).parse(formData.get("file"));
      input.file = {
        name: file.name,
        mime: form.mode === "eml" ? "message/rfc822" : "application/pdf",
        bytes: new Uint8Array(await file.arrayBuffer()),
      };
    }

    const result = await ingestReply(session, input);
    revalidateRequest(form.requestId);
    return { ok: true, offerId: result.offerId, rfqId: result.rfqId, matchedBy: result.matchedBy, needsRfqChoice: false };
  } catch (error) {
    console.error("[requests] ingestReply failed", error);
    if (error instanceof NeedsRfqChoiceError) {
      const requestId = idSchema.safeParse(formData.get("requestId"));
      const openRfqs = requestId.success ? await listOpenRfqsSafely(session, requestId.data) : [];
      return { ok: false, error: error.message, needsRfqChoice: true, openRfqs };
    }
    if (error instanceof OfferExtractionError) {
      // The offer exists with no lines; the page shows it with Re-extract.
      const requestId = idSchema.safeParse(formData.get("requestId"));
      if (requestId.success) revalidateRequest(requestId.data);
      return { ok: false, error: error.message, offerId: error.offerId };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

/** listOpenRfqs for the picker; a read failure here must not hide the needsRfqChoice answer. */
async function listOpenRfqsSafely(session: BrokerSession, requestId: string): Promise<OpenRfq[]> {
  try {
    return await listOpenRfqs(session, requestId);
  } catch (error) {
    console.error("[requests] listOpenRfqs failed", error);
    return [];
  }
}

/**
 * Save a phone or text quote (manualOfferInputSchema in src/lib/server/offers.ts:
 * rfqId, source "phone" | "text", receivedAt ISO, paymentTerms, earlyPayPct,
 * earlyPayDays, freightAmount, freightBasis, quoteExpiresAt ISO or null, notes,
 * declined, lines[] with the offer-line fields).
 */
export async function createManualOfferAction(input: unknown): Promise<ActionResult<{ offerId: string }>> {
  const session = await requireBroker();
  return attempt("createManualOffer", async () => {
    const parsed = manualOfferInputSchema.parse(input);
    const { offerId } = await createManualOffer(session, parsed);
    revalidateRequest(await requestIdForRfq(session, parsed.rfqId));
    return { offerId };
  });
}

/** Edit one offer line (offerLinePatchSchema). Flags are recomputed and the change logged. */
export async function updateOfferLineAction(offerLineId: string, patch: unknown): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("updateOfferLine", async () => {
    const id = idSchema.parse(offerLineId);
    const edit = offerLinePatchSchema.parse(patch);
    const line = await updateOfferLine(session, id, edit);
    revalidateRequest(await requestIdForOffer(session, line.offer_id));
    return {};
  });
}

/** Add a typed line to an offer (manualOfferLineSchema). Flags computed, duplicates re-paired, the add logged. */
export async function addOfferLineAction(offerId: string, input: unknown): Promise<ActionResult<{ offerLineId: string }>> {
  const session = await requireBroker();
  return attempt("addOfferLine", async () => {
    const id = idSchema.parse(offerId);
    const line = manualOfferLineSchema.parse(input);
    const row = await addOfferLine(session, id, line);
    revalidateRequest(await requestIdForOffer(session, id));
    return { offerLineId: row.id };
  });
}

/** Remove one offer line. Refused while a Compare selection points at it. */
export async function removeOfferLineAction(offerLineId: string): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("removeOfferLine", async () => {
    const id = idSchema.parse(offerLineId);
    const removed = await removeOfferLine(session, id);
    revalidateRequest(await requestIdForOffer(session, removed.offer_id));
    return {};
  });
}

/** Edit an offer's terms (offerPatchSchema). */
export async function updateOfferAction(offerId: string, patch: unknown): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("updateOffer", async () => {
    const id = idSchema.parse(offerId);
    const edit = offerPatchSchema.parse(patch);
    await updateOffer(session, id, edit);
    revalidateRequest(await requestIdForOffer(session, id));
    return {};
  });
}

export async function markOfferReviewedAction(offerId: string): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("markOfferReviewed", async () => {
    const id = idSchema.parse(offerId);
    await markOfferReviewed(session, id);
    revalidateRequest(await requestIdForOffer(session, id));
    return {};
  });
}

export async function setOfferDeclinedAction(offerId: string, declined: boolean): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("setOfferDeclined", async () => {
    const id = idSchema.parse(offerId);
    const flag = z.boolean().parse(declined);
    await setOfferDeclined(session, id, flag);
    revalidateRequest(await requestIdForOffer(session, id));
    return {};
  });
}

/** Run the extraction again on a stored reply; replaces the offer's lines and terms. */
export async function reExtractOfferAction(offerId: string): Promise<ActionResult<{ lineCount: number; declined: boolean }>> {
  const session = await requireBroker();
  return attempt("extractOffer", async () => {
    const id = idSchema.parse(offerId);
    const result = await extractOffer(session, id);
    revalidateRequest(await requestIdForOffer(session, id));
    return result;
  });
}

/** The request an offer belongs to (through its RFQ), read under RLS; same purpose as requestIdForRfq. */
async function requestIdForOffer(session: BrokerSession, offerId: string): Promise<string> {
  const { data, error } = await session.supabase
    .from("vendor_offers")
    .select("rfq_id")
    .eq("broker_id", session.brokerId)
    .eq("id", offerId)
    .maybeSingle();
  if (error) throw new Error(`Could not read offer: ${error.message}`);
  if (!data) throw new Error("Offer not found");
  return requestIdForRfq(session, data.rfq_id);
}

// ---------------------------------------------------------------------------
// Compare (Compare tab, PRD FR-10, FR-11)
// ---------------------------------------------------------------------------

/**
 * Select an offer line for a request line (selectOfferLineInputSchema in
 * src/lib/server/compare.ts: requestLineId, offerLineId, qty in the request
 * line's unit, note, confirmAlternate). An alternate without confirmAlternate
 * is refused with a message naming the difference (PRD section 8 rule 3); the
 * dialog resubmits with confirmAlternate true. Selecting the same offer line
 * again replaces its quantity.
 */
export async function selectOfferLineAction(input: unknown): Promise<ActionResult<{ selectionId: string }>> {
  const session = await requireBroker();
  return attempt("selectOfferLine", async () => {
    const parsed = selectOfferLineInputSchema.parse(input);
    const { selectionId, requestId } = await selectOfferLine(session, parsed);
    revalidateRequest(requestId);
    return { selectionId };
  });
}

/** Remove one selection. Refused once a purchase holds it. */
export async function unselectOfferLineAction(selectionId: string): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("unselectOfferLine", async () => {
    const id = idSchema.parse(selectionId);
    const { requestId } = await unselectOfferLine(session, id);
    revalidateRequest(requestId);
    return {};
  });
}

/** Change one selection's quantity (a split adjusted). Refused once a purchase holds it. */
export async function updateSelectionQtyAction(selectionId: string, qty: number): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("updateSelectionQty", async () => {
    const id = idSchema.parse(selectionId);
    const quantity = selectionQtySchema.parse(qty);
    const { requestId } = await updateSelectionQty(session, id, quantity);
    revalidateRequest(requestId);
    return {};
  });
}

/**
 * AC-11.1: the explicit Confirm purchase. Input per purchaseInputSchema
 * ({ poNumber, notes }, both nullable). Creates one purchase per branch from
 * the selections no purchase holds yet and moves the request to "sourced".
 * The result carries the new purchase ids; redirectTo is left unset so the
 * client stays on the Compare tab, where the bar links to /history.
 */
export async function confirmPurchaseAction(
  requestId: string,
  input: unknown,
): Promise<ActionResult<{ purchaseIds: string[] } & Redirecting>> {
  const session = await requireBroker();
  return attempt("confirmPurchase", async () => {
    const id = idSchema.parse(requestId);
    const parsed = purchaseInputSchema.parse(input);
    const { purchaseIds } = await confirmPurchase(session, id, parsed);
    revalidateRequest(id);
    revalidatePath("/history");
    return { purchaseIds };
  });
}

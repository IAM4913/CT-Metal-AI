"use server";

// Server actions for the request workspace: Review (PRD FR-2, FR-3), Route
// (FR-6), and RFQs (FR-7, FR-8). Thin wrappers: each one checks the session,
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
  // Work queue counts by status (Step 8) change when a request is parsed, confirmed, drafted, or sent.
  revalidatePath("/");
}

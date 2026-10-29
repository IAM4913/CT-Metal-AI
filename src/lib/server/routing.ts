// Routing and RFQ drafts, server side (PRD FR-6, FR-7, PLAN Step 5).
//
// Every read and write goes through session.supabase (the RLS client) and
// filters on session.brokerId as well. The pure parts live in
// src/lib/routing/match.ts and src/lib/rfq/{templates,draft}.ts; this module
// loads rows, calls them, and writes the result.
//
// Drafts are rows in rfqs with status "draft" (or "failed" after a bad send),
// one per branch per request revision, keyed by idempotencyKey(). Their lines
// are rfq_lines rows. setLineBranches() keeps both in step with the Route tab:
// checking a branch for a line creates the branch's draft when needed and adds
// the line; unchecking removes the line and deletes a draft left with none.
// RFQs that have been sent (status sent, responded, declined, closed) are never
// touched here: after a send, line edits create a new request revision instead
// (see createRevision in review.ts).
//
// Subject and body are regenerated from the current lines whenever the lines
// of a draft change or its include_customer_name flag flips. A Review-tab edit
// to a routed line reaches the drafts through syncDraftsForLine() (called from
// writeLineChange in review.ts): a removed line leaves every editable draft, a
// draft left with no live line is deleted, and the text is rebuilt unless the
// broker had edited the body by hand, in which case it is left alone and the
// RFQs tab marks the card stale (AC-7.4). unrouteLines() does the same for the
// parsed lines a re-parse replaces, before they are deleted. to and cc are set
// once from the branch's contacts and then belong to the broker (AC-7.4); a
// regenerated body greets whoever the first To address is.
//
// The sign-off is the signed-in person (session.displayName), or "Caleb" when
// the account carries no name. brokers.name is the company and is never used.
//
// A request that has a newer revision is superseded: every write here refuses
// it (assertNotSuperseded in revisions.ts), so the old revision cannot grow
// new drafts or fork a second child.

import { z } from "zod";
import type { Tables, TablesInsert, TablesUpdate } from "@/lib/db/client";
import type { Json } from "@/lib/db/types";
import type { RfqStatus } from "@/lib/db/enums";
import { buildDraft, idempotencyKey, type DraftInput } from "@/lib/rfq/draft";
import type { RfqLineView } from "@/lib/rfq/templates";
import {
  buildBranchesForRouting,
  tallyCategoryPurchases,
  type BranchForRouting,
  type CategoryPurchaseCount,
} from "@/lib/routing/match";
import { assertNotSuperseded } from "@/lib/server/revisions";
import type { BrokerSession } from "@/lib/server/session";

type LineRow = Tables<"request_lines">;

export type RoutingContext = {
  request: Tables<"requests">;
  /** Non-removed lines in line_no order. */
  lines: Tables<"request_lines">[];
  branches: BranchForRouting[];
  history: CategoryPurchaseCount[];
  /** Every rfq of this request and revision (RFQS_TAB_STATUSES): the editable drafts plus the ones that went out, whatever happened after. */
  drafts: Tables<"rfqs">[];
  rfqLines: Tables<"rfq_lines">[];
};

/** Statuses a draft can still be edited in. Everything else has left the building. */
export const EDITABLE_RFQ_STATUSES: readonly RfqStatus[] = ["draft", "queued", "failed"];

/** Statuses meaning the RFQ went out (AC-8.4 freezes the request behind them). */
export const SENT_RFQ_STATUSES: readonly RfqStatus[] = ["sent", "responded", "declined", "closed"];

/**
 * Every status the RFQs tab shows: the editable drafts, and every RFQ that
 * went out, read-only (sent, responded, declined, closed). An answered RFQ
 * stays on the tab because it is the only view of the sent body and its
 * Message-ID (PRD section 10), and the history page links to it by anchor
 * (AC-11.3). Together with EDITABLE_RFQ_STATUSES and SENT_RFQ_STATUSES this
 * covers rfqStatusValues; routing.test.ts pins that.
 */
export const RFQS_TAB_STATUSES: readonly RfqStatus[] = [...EDITABLE_RFQ_STATUSES, ...SENT_RFQ_STATUSES];

/** The sign-off when the signed-in account has no display name (PRD AC-7.2: the body is in Caleb's voice). */
export const DEFAULT_SENDER_NAME = "Caleb";

const emailSchema = z.string().trim().min(1).pipe(z.email());

/** What updateDraft() accepts. Every key optional; unknown keys rejected. */
export const draftPatchSchema = z
  .object({
    to_emails: z.array(emailSchema).max(20).optional(),
    cc_emails: z.array(emailSchema).max(20).optional(),
    subject: z.string().trim().min(1, "Subject is required").max(300).optional(),
    body_text: z.string().max(20000).optional(),
    include_customer_name: z.boolean().optional(),
  })
  .strict();
export type DraftPatch = z.infer<typeof draftPatchSchema>;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Everything the Route and RFQs tabs need for one request. Throws when the request is not visible. */
export async function loadRoutingContext(session: BrokerSession, requestId: string): Promise<RoutingContext> {
  const request = await loadRequest(session, requestId);
  const [lines, branches, history, drafts] = await Promise.all([
    loadLiveLines(session, requestId),
    loadBranches(session),
    loadHistory(session),
    loadRfqs(session, requestId, request.revision, RFQS_TAB_STATUSES),
  ]);
  const rfqLines = await loadRfqLines(
    session,
    drafts.map((d) => d.id),
  );
  return { request, lines, branches, history, drafts, rfqLines };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Set the branches one line is routed to (AC-6.2). Ensures an editable draft
 * exists per chosen branch (created with the branch's primary contact as the
 * recipient and include_customer_name false), adds or removes this line's
 * rfq_lines rows, deletes a draft left with no lines, and regenerates the
 * subject and body of every draft touched. Branches whose RFQ for this
 * revision has already been sent are left alone.
 */
export async function setLineBranches(
  session: BrokerSession,
  requestId: string,
  lineId: string,
  branchIds: string[],
): Promise<void> {
  const request = await loadRequest(session, requestId);
  await assertNotSuperseded(session, requestId);
  const line = await loadLine(session, lineId);
  if (line.request_id !== requestId) {
    throw new Error("That line belongs to another request.");
  }
  if (line.status === "removed") {
    throw new Error("A removed line cannot be routed.");
  }

  const wanted = Array.from(new Set(branchIds));
  const branches = await loadBranches(session);
  const byId = new Map(branches.map((b) => [b.branch_id, b]));
  for (const id of wanted) {
    if (!byId.has(id)) throw new Error("Branch not found.");
  }

  const existing = await loadRfqs(session, requestId, request.revision, null);
  const sentBranches = new Set(existing.filter((r) => !isEditable(r.status)).map((r) => r.branch_id));
  const editable = existing.filter((r) => isEditable(r.status));
  const touched = new Set<string>();

  // Add: an editable draft per wanted branch, then this line on it.
  for (const branchId of wanted) {
    if (sentBranches.has(branchId)) continue;
    let rfq = editable.find((r) => r.branch_id === branchId);
    if (!rfq) {
      rfq = await createDraft(session, request, byId.get(branchId)!);
      editable.push(rfq);
    }
    const added = await addRfqLine(session, rfq.id, lineId);
    if (added) touched.add(rfq.id);
  }

  // Remove: this line from every editable draft of a branch no longer wanted.
  for (const rfq of editable) {
    if (wanted.includes(rfq.branch_id)) continue;
    const removed = await removeRfqLine(session, rfq.id, lineId);
    if (removed) touched.add(rfq.id);
  }

  for (const rfqId of touched) {
    const remaining = await countLiveRfqLines(session, rfqId);
    if (remaining === 0) {
      await deleteRfq(session, rfqId);
      continue;
    }
    await rebuildRfqText(session, rfqId);
  }

  await logActivity(session, "request_line", lineId, "request_line.routed", {
    request_id: requestId,
    branch_ids: wanted,
    skipped_sent_branch_ids: wanted.filter((id) => sentBranches.has(id)),
  });
}

/** Rebuild an editable draft's subject and body from its current lines and include_customer_name. */
export async function regenerateDraft(session: BrokerSession, rfqId: string): Promise<void> {
  const rfq = await loadRfq(session, rfqId);
  if (!isEditable(rfq.status)) {
    throw new Error("A sent RFQ cannot be changed. Edit the request to start a new revision.");
  }
  await assertNotSuperseded(session, rfq.request_id);
  const after = await rebuildRfqText(session, rfqId);
  await logActivity(session, "rfq", rfqId, "rfq.regenerated", {
    before: { subject: rfq.subject, body_text: rfq.body_text },
    after: { subject: after.subject, body_text: after.body_text },
  });
}

/**
 * Edit a draft's recipients, subject, body, or include_customer_name (AC-7.4).
 * Only while the RFQ is a draft or failed. Flipping include_customer_name
 * regenerates the body (the customer line lives there). Logs rfq.updated with
 * the before and after of the fields that changed.
 */
export async function updateDraft(session: BrokerSession, rfqId: string, patch: DraftPatch): Promise<void> {
  const edit = draftPatchSchema.parse(patch);
  const before = await loadRfq(session, rfqId);
  if (before.status !== "draft" && before.status !== "failed") {
    throw new Error(
      before.status === "queued"
        ? "This RFQ is queued to send and cannot be edited."
        : "A sent RFQ cannot be changed. Edit the request to start a new revision.",
    );
  }
  await assertNotSuperseded(session, before.request_id);

  const update: TablesUpdate<"rfqs"> = {};
  if (edit.to_emails !== undefined) update.to_emails = edit.to_emails;
  if (edit.cc_emails !== undefined) update.cc_emails = edit.cc_emails;
  if (edit.subject !== undefined) update.subject = edit.subject;
  if (edit.body_text !== undefined) update.body_text = edit.body_text;

  const toggled = edit.include_customer_name !== undefined && edit.include_customer_name !== before.include_customer_name;
  if (toggled) {
    update.include_customer_name = edit.include_customer_name;
    // The To edited in this same patch, if any, decides the greeting.
    const current = { ...before, to_emails: edit.to_emails ?? before.to_emails };
    const draft = await buildDraftFromRows(session, current, edit.include_customer_name!);
    update.body_text = draft.body_text;
  }

  const diff = diffRfq(before, update);
  if (diff.changed.length === 0) return;

  const { error } = await session.supabase
    .from("rfqs")
    .update(update)
    .eq("broker_id", session.brokerId)
    .eq("id", rfqId);
  if (error) {
    throw new Error(`Could not save the RFQ: ${error.message}`);
  }
  await logActivity(session, "rfq", rfqId, "rfq.updated", { before: diff.before, after: diff.after });
}

/**
 * Move a reviewed request to rfqs_drafted once at least one draft exists.
 * Throws when the request has not been confirmed yet (AC-3.3 gate) or has no
 * drafts; does nothing when the request is already past rfqs_drafted.
 */
export async function markRequestDrafted(session: BrokerSession, requestId: string): Promise<void> {
  const request = await loadRequest(session, requestId);
  await assertNotSuperseded(session, requestId);
  const drafts = await loadRfqs(session, requestId, request.revision, EDITABLE_RFQ_STATUSES);
  if (drafts.length === 0) {
    throw new Error("Route at least one line to a vendor first.");
  }
  if (request.status === "new" || request.status === "parsing" || request.status === "needs_review") {
    throw new Error("Confirm the request on the Review tab before generating drafts.");
  }
  if (request.status !== "reviewed") return;

  const { error } = await session.supabase
    .from("requests")
    .update({ status: "rfqs_drafted" })
    .eq("broker_id", session.brokerId)
    .eq("id", requestId);
  if (error) {
    throw new Error(`Could not update the request status: ${error.message}`);
  }
  await logActivity(session, "request", requestId, "request.rfqs_drafted", { draft_count: drafts.length });
}

// ---------------------------------------------------------------------------
// Keeping drafts in step with line edits
// ---------------------------------------------------------------------------

type LineChangeReason = "line_edited" | "line_removed" | "reparse";

/**
 * Keep the editable drafts of a request in step with one Review-tab line edit
 * (AC-7.1, AC-7.3). `before` and `after` are the row as it was and as it is
 * now. Called by writeLineChange in review.ts for every change that reaches
 * the body (values, catalog link, removal); nothing happens when no editable
 * draft carries the line.
 *
 * For every draft with status draft, queued, or failed that carries the line:
 *   the line is now removed      -> its rfq_lines row goes, and a draft left with
 *                                   no live line is deleted (it would be a
 *                                   "0 items" RFQ); otherwise the text follows
 *                                   the two rules below
 *   the body is still generated  -> subject and body are rebuilt from the
 *                                   current lines; nothing of the broker's is
 *                                   lost because the broker never touched them
 *   the body was edited by hand  -> the text is left as the broker wrote it
 *                                   (AC-7.4), rfq.body_stale is logged, and the
 *                                   RFQs tab marks the card until Regenerate body
 *
 * "Still generated" is decided by rebuilding the body from the rows as they
 * were before this edit (the `before` row standing in for the line) and
 * comparing it with the stored body, so a line edit is never mistaken for a
 * hand edit. Sent RFQs are never touched: they belong to the old revision.
 */
export async function syncDraftsForLine(session: BrokerSession, before: LineRow, after: LineRow): Promise<void> {
  // A removed line has already left every draft; nothing links it any more.
  if (before.status === "removed") return;
  const rfqs = await loadEditableRfqsForLine(session, after.id);
  if (rfqs.length === 0) return;

  const removed = after.status === "removed";
  for (const rfq of rfqs) {
    const generatedBefore = await buildDraftFromRows(session, rfq, rfq.include_customer_name, { lineId: before.id, row: before });
    const handEdited = !sameText(rfq.body_text, generatedBefore.body_text);
    if (removed) {
      await removeRfqLine(session, rfq.id, after.id);
      if ((await countLiveRfqLines(session, rfq.id)) === 0) {
        await deleteRfq(session, rfq.id);
        continue;
      }
    }
    await settleDraftText(session, rfq, handEdited, removed ? "line_removed" : "line_edited", [after.id]);
  }
}

/**
 * Take lines off every editable draft before they are deleted (a re-parse
 * replaces every parsed line, see parse-request.ts; rfq_lines references them
 * with no cascade). Same rules as syncDraftsForLine: the rows go, an emptied
 * draft is deleted, a generated body is rebuilt, a hand-edited one is left and
 * logged stale. A line still carried by a sent RFQ cannot be replaced at all;
 * that request should have been revised, so the parse is refused instead of
 * failing on the foreign key.
 */
export async function unrouteLines(session: BrokerSession, requestId: string, lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return;
  const { data: links, error } = await session.supabase
    .from("rfq_lines")
    .select("rfq_id, request_line_id")
    .eq("broker_id", session.brokerId)
    .in("request_line_id", lineIds);
  if (error) {
    throw new Error(`Could not read RFQ lines: ${error.message}`);
  }
  const byRfq = groupLinksByRfq(links ?? [], lineIds);
  if (byRfq.size === 0) return;

  const rfqs = await loadRfqsById(session, Array.from(byRfq.keys()));
  const sent = rfqs.filter((rfq) => !isEditable(rfq.status));
  if (sent.length > 0) {
    throw new Error("Some of these lines are on an RFQ that has been sent. Edit a line to start a new revision, then parse that one.");
  }
  for (const rfq of rfqs) {
    if (rfq.request_id !== requestId) continue;
    const linked = byRfq.get(rfq.id) ?? [];
    const generatedBefore = await buildDraftFromRows(session, rfq, rfq.include_customer_name);
    const handEdited = !sameText(rfq.body_text, generatedBefore.body_text);
    const { error: deleteError } = await session.supabase
      .from("rfq_lines")
      .delete()
      .eq("broker_id", session.brokerId)
      .eq("rfq_id", rfq.id)
      .in("request_line_id", linked);
    if (deleteError) {
      throw new Error(`Could not remove the lines from the RFQ: ${deleteError.message}`);
    }
    if ((await countLiveRfqLines(session, rfq.id)) === 0) {
      await deleteRfq(session, rfq.id);
      continue;
    }
    await settleDraftText(session, rfq, handEdited, "reparse", linked);
  }
}

/** rfq_lines rows for the given lines, grouped by rfq id in first-seen order. Pure. */
export function groupLinksByRfq(
  links: Array<{ rfq_id: string; request_line_id: string }>,
  lineIds: string[],
): Map<string, string[]> {
  const wanted = new Set(lineIds);
  const out = new Map<string, string[]>();
  for (const link of links) {
    if (!wanted.has(link.request_line_id)) continue;
    const list = out.get(link.rfq_id);
    if (list) {
      if (!list.includes(link.request_line_id)) list.push(link.request_line_id);
    } else {
      out.set(link.rfq_id, [link.request_line_id]);
    }
  }
  return out;
}

/**
 * Whether two bodies are the same text: line endings and trailing whitespace
 * do not count (a textarea round trip may change either), anything else does.
 */
export function sameText(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/** Rebuild a draft's text after its lines changed, or leave a hand-edited body and log it stale. */
async function settleDraftText(
  session: BrokerSession,
  rfq: Tables<"rfqs">,
  handEdited: boolean,
  reason: LineChangeReason,
  lineIds: string[],
): Promise<void> {
  if (handEdited) {
    await logActivity(session, "rfq", rfq.id, "rfq.body_stale", { reason, request_line_ids: lineIds });
    return;
  }
  const after = await rebuildRfqText(session, rfq.id);
  await logActivity(session, "rfq", rfq.id, "rfq.regenerated", {
    reason,
    request_line_ids: lineIds,
    before: { subject: rfq.subject, body_text: rfq.body_text },
    after: { subject: after.subject, body_text: after.body_text },
  });
}

/**
 * The subject and body a draft would have if regenerated now. The RFQs tab
 * compares it with the stored text to mark a card whose body no longer matches
 * its lines (edited by hand, or a line changed under a hand-edited body).
 */
export async function generatedDraftText(
  session: BrokerSession,
  rfq: Tables<"rfqs">,
): Promise<{ subject: string; body_text: string }> {
  const draft = await buildDraftFromRows(session, rfq, rfq.include_customer_name);
  return { subject: draft.subject, body_text: draft.body_text };
}

// ---------------------------------------------------------------------------
// Draft assembly
// ---------------------------------------------------------------------------

function isEditable(status: RfqStatus): boolean {
  return EDITABLE_RFQ_STATUSES.includes(status);
}

type ContactRow = Pick<Tables<"vendor_contacts">, "email" | "name" | "is_primary">;

/**
 * The sign-off: the signed-in person's display name, or "Caleb" when the
 * account has none. Never the broker row's name, which is the company
 * ("Caleb's company (set name)" in the seed) and no way to end a note.
 */
export function senderNameFor(displayName: string | null | undefined): string {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  return name === "" ? DEFAULT_SENDER_NAME : name;
}

/**
 * The contacts as buildDraft should see them when a draft is regenerated: the
 * one whose email is the draft's first To address (case-insensitive) comes
 * first and is the primary, so the greeting follows an edited To (AC-7.4).
 * When To is empty or names no stored contact, the stored contacts are
 * returned as they are and the greeting stays with the branch's primary.
 */
export function pickGreetingContacts<T extends { email: string; is_primary: boolean }>(contacts: T[], toEmails: string[]): T[] {
  const first = toEmails.map((email) => email.trim().toLowerCase()).find((email) => email !== "");
  if (first === undefined) return contacts;
  const match = contacts.find((contact) => contact.email.trim().toLowerCase() === first);
  if (!match) return contacts;
  return [{ ...match, is_primary: true }, ...contacts.filter((contact) => contact !== match).map((contact) => ({ ...contact, is_primary: false }))];
}

async function loadContacts(session: BrokerSession, branchId: string): Promise<ContactRow[]> {
  const { data, error } = await session.supabase
    .from("vendor_contacts")
    .select("email, name, is_primary")
    .eq("broker_id", session.brokerId)
    .eq("branch_id", branchId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Could not read vendor contacts: ${error.message}`);
  }
  return data ?? [];
}

async function loadCustomer(
  session: BrokerSession,
  customerId: string | null,
): Promise<{ name: string; short_name: string } | null> {
  if (customerId === null) return null;
  const { data, error } = await session.supabase
    .from("customers")
    .select("name, short_name")
    .eq("broker_id", session.brokerId)
    .eq("id", customerId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the customer: ${error.message}`);
  }
  return data;
}

/** One line's row as it was before an edit, standing in for the stored row while a draft is rebuilt for comparison. */
type LineOverride = { lineId: string; row: LineRow };

/**
 * The live lines of one RFQ as RfqLineView values, in line_no order. With an
 * override, that line is read from the given row instead of the table (so a
 * line just edited or removed can be seen as it was), and "live" is judged on
 * the row used.
 */
async function loadRfqLineViews(session: BrokerSession, rfqId: string, override?: LineOverride): Promise<RfqLineView[]> {
  const { data: links, error } = await session.supabase
    .from("rfq_lines")
    .select("request_line_id, note")
    .eq("broker_id", session.brokerId)
    .eq("rfq_id", rfqId);
  if (error) {
    throw new Error(`Could not read RFQ lines: ${error.message}`);
  }
  const noteByLine = new Map((links ?? []).map((l) => [l.request_line_id, l.note]));
  if (noteByLine.size === 0) return [];

  const { data: stored, error: linesError } = await session.supabase
    .from("request_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .in("id", Array.from(noteByLine.keys()))
    .order("line_no", { ascending: true });
  if (linesError) {
    throw new Error(`Could not read request lines: ${linesError.message}`);
  }
  const lines = (stored ?? [])
    .map((line) => (override && line.id === override.lineId ? override.row : line))
    .filter((line) => line.status !== "removed")
    .sort((a, b) => a.line_no - b.line_no);
  const designations = await loadDesignations(session, lines);
  return lines.map((line) => toRfqLineView(line, designations, noteByLine.get(line.id) ?? null));
}

async function loadDesignations(session: BrokerSession, lines: Tables<"request_lines">[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(lines.map((l) => l.catalog_item_id).filter((v): v is string => v !== null)));
  if (ids.length === 0) return new Map();
  const { data, error } = await session.supabase.from("catalog_items").select("id, designation").in("id", ids);
  if (error) {
    throw new Error(`Could not read catalog items: ${error.message}`);
  }
  return new Map((data ?? []).map((item) => [item.id, item.designation]));
}

/** A request_lines row as the template sees it. The designation is the linked item's, null for a custom line. */
export function toRfqLineView(
  line: Tables<"request_lines">,
  designations: Map<string, string>,
  note: string | null,
): RfqLineView {
  return {
    designation: line.catalog_item_id ? (designations.get(line.catalog_item_id) ?? null) : null,
    raw_text: line.raw_text,
    description: line.description,
    qty: line.qty,
    unit: line.unit,
    length_ft: line.length_ft,
    length_text: line.length_text,
    grade_spec: line.grade_spec,
    note,
    delivery_notes: line.delivery_notes,
    dims: jsonObject(line.dims),
  };
}

/** A jsonb value as a plain object, or null when it is a scalar or an array (request_lines.dims is {} by default). */
function jsonObject(value: Json): { [key: string]: unknown } | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * buildDraft() over the stored rows of an existing rfq. The greeting follows
 * the draft's current first To address (pickGreetingContacts); an override
 * reads one line from the given row instead of the table (syncDraftsForLine).
 */
async function buildDraftFromRows(
  session: BrokerSession,
  rfq: Tables<"rfqs">,
  includeCustomerName: boolean,
  override?: LineOverride,
) {
  const [request, branches] = await Promise.all([loadRequest(session, rfq.request_id), loadBranches(session)]);
  const branch = branches.find((b) => b.branch_id === rfq.branch_id);
  if (!branch) {
    throw new Error("Branch not found.");
  }
  const [customer, contacts, lines] = await Promise.all([
    loadCustomer(session, request.customer_id),
    loadContacts(session, rfq.branch_id),
    loadRfqLineViews(session, rfq.id, override),
  ]);
  const input: DraftInput = {
    request: {
      id: request.id,
      revision: request.revision,
      subject: request.subject,
      delivery_requirements: request.delivery_requirements,
    },
    customer,
    branch: { id: branch.branch_id, name: branch.branch_name, vendor_name: branch.vendor_name },
    contacts: pickGreetingContacts(contacts, rfq.to_emails),
    lines,
    includeCustomerName,
    senderName: senderNameFor(session.displayName),
    now: new Date(),
  };
  return buildDraft(input);
}

/** Regenerate and store the subject and body of one rfq from its current rows. Returns the new text. */
async function rebuildRfqText(session: BrokerSession, rfqId: string): Promise<{ subject: string; body_text: string }> {
  const rfq = await loadRfq(session, rfqId);
  const draft = await buildDraftFromRows(session, rfq, rfq.include_customer_name);
  const { error } = await session.supabase
    .from("rfqs")
    .update({ subject: draft.subject, body_text: draft.body_text })
    .eq("broker_id", session.brokerId)
    .eq("id", rfqId);
  if (error) {
    throw new Error(`Could not update the RFQ text: ${error.message}`);
  }
  return { subject: draft.subject, body_text: draft.body_text };
}

/** Insert a new draft rfq for a branch with no lines yet (the caller adds them and regenerates the text). */
async function createDraft(
  session: BrokerSession,
  request: Tables<"requests">,
  branch: BranchForRouting,
): Promise<Tables<"rfqs">> {
  const [customer, contacts] = await Promise.all([
    loadCustomer(session, request.customer_id),
    loadContacts(session, branch.branch_id),
  ]);
  const draft = buildDraft({
    request: {
      id: request.id,
      revision: request.revision,
      subject: request.subject,
      delivery_requirements: request.delivery_requirements,
    },
    customer,
    branch: { id: branch.branch_id, name: branch.branch_name, vendor_name: branch.vendor_name },
    contacts,
    lines: [],
    includeCustomerName: false,
    senderName: senderNameFor(session.displayName),
    now: new Date(),
  });
  const row: TablesInsert<"rfqs"> = {
    broker_id: session.brokerId,
    request_id: request.id,
    branch_id: branch.branch_id,
    revision: request.revision,
    status: "draft",
    to_emails: draft.to_emails,
    cc_emails: draft.cc_emails,
    subject: draft.subject,
    body_text: draft.body_text,
    include_customer_name: false,
    idempotency_key: idempotencyKey(request.id, branch.branch_id, request.revision),
  };
  const { data, error } = await session.supabase.from("rfqs").insert(row).select("*").single();
  if (error) {
    throw new Error(`Could not create the RFQ draft: ${error.message}`);
  }
  await logActivity(session, "rfq", data.id, "rfq.created", {
    request_id: request.id,
    branch_id: branch.branch_id,
    revision: request.revision,
    to_emails: draft.to_emails,
  });
  return data;
}

/** Add a line to an rfq. Returns false when it was already there. */
async function addRfqLine(session: BrokerSession, rfqId: string, lineId: string): Promise<boolean> {
  const { data: existing, error: existingError } = await session.supabase
    .from("rfq_lines")
    .select("id")
    .eq("broker_id", session.brokerId)
    .eq("rfq_id", rfqId)
    .eq("request_line_id", lineId)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Could not read RFQ lines: ${existingError.message}`);
  }
  if (existing) return false;

  const row: TablesInsert<"rfq_lines"> = { broker_id: session.brokerId, rfq_id: rfqId, request_line_id: lineId };
  const { error } = await session.supabase
    .from("rfq_lines")
    .upsert(row, { onConflict: "rfq_id,request_line_id", ignoreDuplicates: true });
  if (error) {
    throw new Error(`Could not add the line to the RFQ: ${error.message}`);
  }
  return true;
}

/** Remove a line from an rfq. Returns false when it was not there. */
async function removeRfqLine(session: BrokerSession, rfqId: string, lineId: string): Promise<boolean> {
  const { data, error } = await session.supabase
    .from("rfq_lines")
    .delete()
    .eq("broker_id", session.brokerId)
    .eq("rfq_id", rfqId)
    .eq("request_line_id", lineId)
    .select("id");
  if (error) {
    throw new Error(`Could not remove the line from the RFQ: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

/**
 * Live lines per rfq: rfq_lines rows whose request line is not removed. A row
 * pointing at a removed line counts for nothing, so a draft whose lines were
 * all removed reads as empty. Every id asked for is in the map (zero included).
 */
export async function loadLiveLineCounts(session: BrokerSession, rfqIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>(rfqIds.map((id) => [id, 0]));
  if (rfqIds.length === 0) return counts;
  const { data: links, error } = await session.supabase
    .from("rfq_lines")
    .select("rfq_id, request_line_id")
    .eq("broker_id", session.brokerId)
    .in("rfq_id", rfqIds);
  if (error) {
    throw new Error(`Could not read RFQ lines: ${error.message}`);
  }
  if (!links || links.length === 0) return counts;

  const lineIds = Array.from(new Set(links.map((link) => link.request_line_id)));
  const { data: lines, error: linesError } = await session.supabase
    .from("request_lines")
    .select("id")
    .eq("broker_id", session.brokerId)
    .in("id", lineIds)
    .neq("status", "removed");
  if (linesError) {
    throw new Error(`Could not read request lines: ${linesError.message}`);
  }
  const live = new Set((lines ?? []).map((line) => line.id));
  for (const link of links) {
    if (live.has(link.request_line_id)) counts.set(link.rfq_id, (counts.get(link.rfq_id) ?? 0) + 1);
  }
  return counts;
}

async function countLiveRfqLines(session: BrokerSession, rfqId: string): Promise<number> {
  return (await loadLiveLineCounts(session, [rfqId])).get(rfqId) ?? 0;
}

/** Delete an editable draft that has no lines left (rfq_lines cascade). */
async function deleteRfq(session: BrokerSession, rfqId: string): Promise<void> {
  const { error } = await session.supabase
    .from("rfqs")
    .delete()
    .eq("broker_id", session.brokerId)
    .eq("id", rfqId)
    .in("status", [...EDITABLE_RFQ_STATUSES]);
  if (error) {
    throw new Error(`Could not delete the empty RFQ draft: ${error.message}`);
  }
  await logActivity(session, "rfq", rfqId, "rfq.deleted", { reason: "no lines left" });
}

// ---------------------------------------------------------------------------
// Row loaders
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

async function loadLine(session: BrokerSession, lineId: string): Promise<Tables<"request_lines">> {
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

async function loadLiveLines(session: BrokerSession, requestId: string): Promise<Tables<"request_lines">[]> {
  const { data, error } = await session.supabase
    .from("request_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId)
    .neq("status", "removed")
    .order("line_no", { ascending: true });
  if (error) {
    throw new Error(`Could not read request lines: ${error.message}`);
  }
  return data ?? [];
}

export async function loadRfq(session: BrokerSession, rfqId: string): Promise<Tables<"rfqs">> {
  const { data, error } = await session.supabase
    .from("rfqs")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", rfqId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the RFQ: ${error.message}`);
  }
  if (!data) {
    throw new Error("RFQ not found.");
  }
  return data;
}

/** rfqs of one request revision, oldest first; statuses null means every status. */
export async function loadRfqs(
  session: BrokerSession,
  requestId: string,
  revision: number,
  statuses: readonly RfqStatus[] | null,
): Promise<Tables<"rfqs">[]> {
  let query = session.supabase
    .from("rfqs")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId)
    .eq("revision", revision);
  if (statuses !== null) query = query.in("status", [...statuses]);
  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Could not read RFQs: ${error.message}`);
  }
  return data ?? [];
}

/** rfqs by id, any status, oldest first. */
async function loadRfqsById(session: BrokerSession, rfqIds: string[]): Promise<Tables<"rfqs">[]> {
  if (rfqIds.length === 0) return [];
  const { data, error } = await session.supabase
    .from("rfqs")
    .select("*")
    .eq("broker_id", session.brokerId)
    .in("id", rfqIds)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Could not read RFQs: ${error.message}`);
  }
  return data ?? [];
}

/** The editable (draft, queued, failed) rfqs that carry one request line. */
async function loadEditableRfqsForLine(session: BrokerSession, lineId: string): Promise<Tables<"rfqs">[]> {
  const { data: links, error } = await session.supabase
    .from("rfq_lines")
    .select("rfq_id")
    .eq("broker_id", session.brokerId)
    .eq("request_line_id", lineId);
  if (error) {
    throw new Error(`Could not read RFQ lines: ${error.message}`);
  }
  const ids = Array.from(new Set((links ?? []).map((link) => link.rfq_id)));
  const rfqs = await loadRfqsById(session, ids);
  return rfqs.filter((rfq) => isEditable(rfq.status));
}

async function loadRfqLines(session: BrokerSession, rfqIds: string[]): Promise<Tables<"rfq_lines">[]> {
  if (rfqIds.length === 0) return [];
  const { data, error } = await session.supabase
    .from("rfq_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .in("rfq_id", rfqIds)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Could not read RFQ lines: ${error.message}`);
  }
  return data ?? [];
}

/** The broker's vendor directory as BranchForRouting values (vendors, branches, capabilities, contacts). */
export async function loadBranches(session: BrokerSession): Promise<BranchForRouting[]> {
  const { supabase, brokerId } = session;
  const [vendors, branches, capabilities, contacts] = await Promise.all([
    supabase.from("vendors").select("id, name").eq("broker_id", brokerId),
    supabase.from("vendor_branches").select("id, vendor_id, name, preferred").eq("broker_id", brokerId),
    supabase.from("vendor_capabilities").select("branch_id, category").eq("broker_id", brokerId),
    supabase
      .from("vendor_contacts")
      .select("branch_id, email, is_primary")
      .eq("broker_id", brokerId)
      .order("created_at", { ascending: true }),
  ]);
  if (vendors.error) {
    throw new Error(`Could not read vendors: ${vendors.error.message}`);
  }
  if (branches.error) {
    throw new Error(`Could not read vendor branches: ${branches.error.message}`);
  }
  if (capabilities.error) {
    throw new Error(`Could not read vendor capabilities: ${capabilities.error.message}`);
  }
  if (contacts.error) {
    throw new Error(`Could not read vendor contacts: ${contacts.error.message}`);
  }
  return buildBranchesForRouting(vendors.data ?? [], branches.data ?? [], capabilities.data ?? [], contacts.data ?? []);
}

/**
 * Past purchases per branch and category: purchases -> purchase_lines ->
 * sourcing_selections -> request_lines.category. Each step is one query over
 * the ids of the previous one; an empty step short-circuits (zero purchases is
 * the Phase 1 normal case).
 */
async function loadHistory(session: BrokerSession): Promise<CategoryPurchaseCount[]> {
  const { supabase, brokerId } = session;

  const purchases = await supabase.from("purchases").select("id, branch_id").eq("broker_id", brokerId);
  if (purchases.error) {
    throw new Error(`Could not read purchases: ${purchases.error.message}`);
  }
  if (!purchases.data || purchases.data.length === 0) return [];
  const branchByPurchase = new Map(purchases.data.map((p) => [p.id, p.branch_id]));

  const purchaseLines = await supabase
    .from("purchase_lines")
    .select("purchase_id, selection_id")
    .eq("broker_id", brokerId)
    .in("purchase_id", Array.from(branchByPurchase.keys()));
  if (purchaseLines.error) {
    throw new Error(`Could not read purchase lines: ${purchaseLines.error.message}`);
  }
  if (!purchaseLines.data || purchaseLines.data.length === 0) return [];
  const purchaseBySelection = new Map(purchaseLines.data.map((pl) => [pl.selection_id, pl.purchase_id]));

  const selections = await supabase
    .from("sourcing_selections")
    .select("id, request_line_id")
    .eq("broker_id", brokerId)
    .in("id", Array.from(purchaseBySelection.keys()));
  if (selections.error) {
    throw new Error(`Could not read sourcing selections: ${selections.error.message}`);
  }
  if (!selections.data || selections.data.length === 0) return [];

  const lineIds = Array.from(new Set(selections.data.map((s) => s.request_line_id)));
  const lines = await supabase.from("request_lines").select("id, category").eq("broker_id", brokerId).in("id", lineIds);
  if (lines.error) {
    throw new Error(`Could not read request lines: ${lines.error.message}`);
  }
  const categoryByLine = new Map((lines.data ?? []).map((l) => [l.id, l.category]));

  const rows: Array<{ branch_id: string; category: Tables<"request_lines">["category"] }> = [];
  for (const selection of selections.data) {
    const purchaseId = purchaseBySelection.get(selection.id);
    const branchId = purchaseId ? branchByPurchase.get(purchaseId) : undefined;
    if (!branchId) continue;
    rows.push({ branch_id: branchId, category: categoryByLine.get(selection.request_line_id) ?? null });
  }
  return tallyCategoryPurchases(rows);
}

// ---------------------------------------------------------------------------
// Diff and log
// ---------------------------------------------------------------------------

const RFQ_DIFF_KEYS = ["to_emails", "cc_emails", "subject", "body_text", "include_customer_name"] as const;
type RfqDiffKey = (typeof RFQ_DIFF_KEYS)[number];

function diffRfq(
  before: Tables<"rfqs">,
  update: TablesUpdate<"rfqs">,
): { before: { [key: string]: Json | undefined }; after: { [key: string]: Json | undefined }; changed: RfqDiffKey[] } {
  const out = { before: {} as { [key: string]: Json | undefined }, after: {} as { [key: string]: Json | undefined }, changed: [] as RfqDiffKey[] };
  for (const key of RFQ_DIFF_KEYS) {
    const next = update[key];
    if (next === undefined) continue;
    if (JSON.stringify(next) === JSON.stringify(before[key])) {
      delete update[key];
      continue;
    }
    out.changed.push(key);
    out.before[key] = before[key];
    out.after[key] = next;
  }
  return out;
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

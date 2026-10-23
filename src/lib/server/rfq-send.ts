// Sending RFQs, server side (PRD AC-8.1 to AC-8.3, PLAN Step 5).
//
// sendAll() and retryRfq() build SendPorts over session.supabase (the RLS
// client) and hand them with the configured MailAdapter to the pure
// sendRfqs() in src/lib/rfq/send.ts. Both run only on an explicit click (the
// Send all and Retry buttons): nothing here is scheduled or automatic.
//
// The from address is the signed-in user's email. When the session has none
// (a Supabase user created without an email), "caleb@example.com" stands in
// so the messages row is still complete; the noop adapter sends nothing either
// way. Every sent RFQ gets a messages row with the full outbound text (PRD
// section 10, auditability), even in no-op mode.
//
// Nothing goes out before the request is confirmed (AC-3.3, then AC-8.1's
// "reviewed draft"): sendBlockedReason() refuses a request still at new,
// parsing, or needs_review. Without that gate a request sent from needs_review
// could never be confirmed (confirmRequestAction refuses once an RFQ is sent)
// and would sit at needs_review with sent RFQs for good.
//
// Two more refusals: a request with a newer revision is superseded and sends
// nothing (assertNotSuperseded), and a draft with no live line (every line it
// carried was removed) is marked failed with "No lines" instead of going out
// as a "0 items" RFQ (AC-7.1). partitionByLiveLines() and mergeOutcomes() are
// the pure parts.

import type { Tables, TablesInsert } from "@/lib/db/client";
import type { RequestStatus } from "@/lib/db/enums";
import type { Json } from "@/lib/db/types";
import { getMailAdapter, type OutboundMessage } from "@/lib/mail/adapter";
import { sendRfqs, type SendableRfq, type SendOutcome, type SendPorts } from "@/lib/rfq/send";
import { assertNotSuperseded } from "@/lib/server/revisions";
import { EDITABLE_RFQ_STATUSES, loadLiveLineCounts, loadRfq, loadRfqs, SENT_RFQ_STATUSES } from "@/lib/server/routing";
import type { BrokerSession } from "@/lib/server/session";

/** Used as the from address when the signed-in user has no email on the session. */
export const FALLBACK_FROM_EMAIL = "caleb@example.com";

/** last_error of a draft refused because none of its lines is live. */
export const NO_LINES_ERROR = "No lines";

/** Request statuses before Confirm on the Review tab. */
const UNCONFIRMED_STATUSES: readonly RequestStatus[] = ["new", "parsing", "needs_review"];

/**
 * Why a request's RFQs may not be sent yet, or null when they may. Pure, so
 * the rule is tested without a database. Every later status (reviewed,
 * rfqs_drafted, rfqs_sent, collecting, comparing, sourced, closed) may send: a
 * branch added after the first send still has to get its RFQ.
 */
export function sendBlockedReason(status: RequestStatus): string | null {
  return UNCONFIRMED_STATUSES.includes(status) ? "Confirm the request on the Review tab before sending." : null;
}

/** Split the rfqs about to be sent by whether they still carry a live line (loadLiveLineCounts). Pure; order kept. */
export function partitionByLiveLines<T extends { id: string }>(
  rfqs: T[],
  liveCounts: Map<string, number>,
): { sendable: T[]; empty: T[] } {
  const sendable: T[] = [];
  const empty: T[] = [];
  for (const rfq of rfqs) {
    if ((liveCounts.get(rfq.id) ?? 0) > 0) sendable.push(rfq);
    else empty.push(rfq);
  }
  return { sendable, empty };
}

/** Outcomes in the order of the rfqs they belong to (one list per path comes back, this puts them in list order). Pure. */
export function mergeOutcomes(rfqs: Array<{ id: string }>, outcomes: SendOutcome[]): SendOutcome[] {
  const byId = new Map(outcomes.map((outcome) => [outcome.rfqId, outcome]));
  const ordered: SendOutcome[] = [];
  for (const rfq of rfqs) {
    const outcome = byId.get(rfq.id);
    if (outcome) ordered.push(outcome);
  }
  return ordered;
}

/**
 * Send every draft, queued, or failed RFQ of the request's current revision.
 * Already sent RFQs are skipped by the idempotency key. When every RFQ of the
 * revision has gone out the request moves to rfqs_sent. Logs rfqs.sent with
 * the outcomes.
 */
export async function sendAll(session: BrokerSession, requestId: string): Promise<SendOutcome[]> {
  const request = await loadRequest(session, requestId);
  const blocked = sendBlockedReason(request.status);
  if (blocked !== null) {
    throw new Error(blocked);
  }
  await assertNotSuperseded(session, requestId);
  const rfqs = await loadRfqs(session, requestId, request.revision, EDITABLE_RFQ_STATUSES);
  const { sendable, empty } = partitionByLiveLines(rfqs, await loadLiveLineCounts(session, rfqs.map((rfq) => rfq.id)));
  const ports = buildPorts(session, requestId);
  const refused = await failEmpty(empty, ports);
  const sent = await sendRfqs(sendable.map(toSendable), ports);
  const outcomes = mergeOutcomes(rfqs, [...refused, ...sent]);

  await settleRequestStatus(session, request);
  await logActivity(session, "request", requestId, "rfqs.sent", {
    revision: request.revision,
    outcomes: outcomes.map(outcomeJson),
  });
  return outcomes;
}

/** Send one RFQ again after a failure (AC-8.3). Only a failed or draft RFQ can be retried. */
export async function retryRfq(session: BrokerSession, rfqId: string): Promise<SendOutcome> {
  const rfq = await loadRfq(session, rfqId);
  if (rfq.status !== "failed" && rfq.status !== "draft") {
    throw new Error(
      rfq.status === "queued" ? "This RFQ is already queued to send." : "This RFQ has already been sent.",
    );
  }
  const request = await loadRequest(session, rfq.request_id);
  const blocked = sendBlockedReason(request.status);
  if (blocked !== null) {
    throw new Error(blocked);
  }
  await assertNotSuperseded(session, rfq.request_id);
  const ports = buildPorts(session, rfq.request_id);
  const { sendable, empty } = partitionByLiveLines([rfq], await loadLiveLineCounts(session, [rfq.id]));
  const [outcome] = empty.length > 0 ? await failEmpty(empty, ports) : await sendRfqs(sendable.map(toSendable), ports);

  await settleRequestStatus(session, request);
  await logActivity(session, "rfq", rfqId, "rfq.retried", { outcome: outcomeJson(outcome) });
  return outcome;
}

/** Mark every draft with no live line failed with "No lines"; the adapter never sees them. */
async function failEmpty(rfqs: Tables<"rfqs">[], ports: SendPorts): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];
  for (const rfq of rfqs) {
    await ports.markFailed(rfq.id, NO_LINES_ERROR);
    outcomes.push({ rfqId: rfq.id, result: "failed", error: NO_LINES_ERROR });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function toSendable(rfq: Tables<"rfqs">): SendableRfq {
  return {
    id: rfq.id,
    status: rfq.status,
    idempotency_key: rfq.idempotency_key,
    to_emails: rfq.to_emails,
    cc_emails: rfq.cc_emails,
    subject: rfq.subject,
    body_text: rfq.body_text,
    provider_message_id: rfq.provider_message_id,
  };
}

function buildPorts(session: BrokerSession, requestId: string): SendPorts {
  const { supabase, brokerId } = session;
  return {
    adapter: getMailAdapter(),
    from: session.email ?? FALLBACK_FROM_EMAIL,

    async findSentByKey(key) {
      const { data, error } = await supabase
        .from("rfqs")
        .select("id, provider_message_id")
        .eq("broker_id", brokerId)
        .eq("idempotency_key", key)
        .eq("status", "sent")
        .maybeSingle();
      if (error) {
        throw new Error(`Could not check for a sent RFQ: ${error.message}`);
      }
      return data;
    },

    async markSent(rfqId, providerMessageId, sentAt) {
      const { error } = await supabase
        .from("rfqs")
        .update({ status: "sent", sent_at: sentAt.toISOString(), provider_message_id: providerMessageId, last_error: null })
        .eq("broker_id", brokerId)
        .eq("id", rfqId);
      if (error) {
        throw new Error(`Could not mark the RFQ sent: ${error.message}`);
      }
    },

    async markFailed(rfqId, errorText) {
      const { error } = await supabase
        .from("rfqs")
        .update({ status: "failed", last_error: errorText })
        .eq("broker_id", brokerId)
        .eq("id", rfqId);
      if (error) {
        throw new Error(`Could not mark the RFQ failed: ${error.message}`);
      }
    },

    async recordOutbound(msg: OutboundMessage, providerMessageId, sentAt) {
      const row: TablesInsert<"messages"> = {
        broker_id: brokerId,
        direction: "out",
        rfq_id: msg.rfqId,
        request_id: requestId,
        from_email: msg.from,
        to_emails: msg.to,
        cc_emails: msg.cc,
        subject: msg.subject,
        body_text: msg.bodyText,
        received_at: sentAt.toISOString(),
        provider_message_id: providerMessageId,
        matched_by: "none",
      };
      const { error } = await supabase.from("messages").insert(row);
      if (error) {
        throw new Error(`Could not record the outbound message: ${error.message}`);
      }
    },

    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// Request status
// ---------------------------------------------------------------------------

/** rfqs_sent once every RFQ of the revision has gone out (and there is at least one). */
async function settleRequestStatus(session: BrokerSession, request: Tables<"requests">): Promise<void> {
  const all = await loadRfqs(session, request.id, request.revision, null);
  if (all.length === 0) return;
  const everySent = all.every((rfq) => SENT_RFQ_STATUSES.includes(rfq.status));
  if (!everySent || request.status === "rfqs_sent") return;
  // Do not move a request backwards once replies are being collected or compared.
  if (!["reviewed", "rfqs_drafted"].includes(request.status)) return;

  const { error } = await session.supabase
    .from("requests")
    .update({ status: "rfqs_sent" })
    .eq("broker_id", session.brokerId)
    .eq("id", request.id);
  if (error) {
    throw new Error(`Could not update the request status: ${error.message}`);
  }
}

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

function outcomeJson(outcome: SendOutcome): { [key: string]: Json | undefined } {
  return {
    rfq_id: outcome.rfqId,
    result: outcome.result,
    provider_message_id: outcome.providerMessageId ?? null,
    error: outcome.error ?? null,
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

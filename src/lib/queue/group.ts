// Work queue grouping (PRD FR-12). Pure: the server loader hands in plain
// request rows with their RFQs and this file decides which group each one sits
// in, counts the RFQs sent and answered, and measures the wait since the first
// send. Nothing here reads a clock; the caller passes `now` so the tests are
// deterministic and the page renders one consistent moment.
//
// Groups follow AC-12.1 (new, needs review, drafts ready, awaiting responses,
// ready to compare, sourced) plus closed, in the order the home screen shows
// them. A request's group is a function of its status alone; what the card
// shows beyond that (received / sent, days per RFQ) comes from its RFQs.

import type { RequestStatus, RfqStatus } from "@/lib/db/enums";

export const QUEUE_GROUPS = [
  "new",
  "needs_review",
  "drafts_ready",
  "awaiting_responses",
  "ready_to_compare",
  "sourced",
  "closed",
] as const;

export type QueueGroup = (typeof QUEUE_GROUPS)[number];

export const QUEUE_GROUP_LABELS: Record<QueueGroup, string> = {
  new: "New",
  needs_review: "Needs review",
  drafts_ready: "Drafts ready",
  awaiting_responses: "Awaiting responses",
  ready_to_compare: "Ready to compare",
  sourced: "Sourced",
  closed: "Closed",
};

/** Where a request with this status sits on the home screen. */
export function queueGroupForStatus(status: RequestStatus): QueueGroup {
  switch (status) {
    case "new":
    case "parsing":
      return "new";
    case "needs_review":
      return "needs_review";
    case "reviewed":
    case "rfqs_drafted":
      return "drafts_ready";
    case "rfqs_sent":
    case "collecting":
      return "awaiting_responses";
    case "comparing":
      return "ready_to_compare";
    case "sourced":
      return "sourced";
    case "closed":
      return "closed";
  }
}

export type QueueRfq = {
  id: string;
  branch_name: string;
  vendor_name: string;
  status: RfqStatus;
  sent_at: string | null;
};

export type QueueRequest = {
  id: string;
  subject: string | null;
  customer_name: string | null;
  status: RequestStatus;
  revision: number;
  received_at: string;
  /** Lines that are not removed. */
  line_count: number;
  /** The RFQs of this request's current revision. */
  rfqs: QueueRfq[];
};

export type QueueRfqDays = {
  rfq_id: string;
  vendor_name: string;
  branch_name: string;
  status: RfqStatus;
  /** Whole days since this RFQ went out; null while it has not. */
  days: number | null;
};

export type QueueCard = QueueRequest & {
  group: QueueGroup;
  /** RFQs that went out (a sent_at, or a status past sent). */
  sent_count: number;
  /** RFQs answered: responded or declined (AC-9.4 stops the wait on a decline). */
  received_count: number;
  /** Whole days from the earliest sent_at to now; null when nothing has been sent. */
  days_since_send: number | null;
  /** One entry per RFQ, sent or not, in vendor then branch order (AC-12.2). */
  per_rfq_days: QueueRfqDays[];
};

/** RFQ statuses that mean the RFQ went out, whatever happened after. Mirrors SENT_RFQ_STATUSES in src/lib/server/routing.ts. */
const SENT_STATUSES: readonly RfqStatus[] = ["sent", "responded", "declined", "closed"];

/** RFQ statuses that count as an answer for "received n / sent m". */
const RECEIVED_STATUSES: readonly RfqStatus[] = ["responded", "declined"];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** An RFQ counts as sent when it carries a sent_at or its status is past sent. */
export function rfqWasSent(rfq: Pick<QueueRfq, "status" | "sent_at">): boolean {
  return rfq.sent_at !== null || SENT_STATUSES.includes(rfq.status);
}

export function rfqWasReceived(rfq: Pick<QueueRfq, "status">): boolean {
  return RECEIVED_STATUSES.includes(rfq.status);
}

/**
 * Completed whole days between an instant and now: 47 hours is 1 day, 48 is
 * 2. Measured on elapsed time, not calendar days, so neither the server's nor
 * the browser's time zone changes the answer. A timestamp in the future (clock
 * skew) reads 0, and an unparseable one reads null.
 *
 * The one rule for "days since send" everywhere it is shown: the queue cards,
 * the Offers tab's awaiting list, and the Compare tab's purchase bar all call
 * this, so one RFQ never reads two different waits one click apart.
 */
export function wholeDaysSince(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const elapsed = now.getTime() - then;
  if (elapsed <= 0) return 0;
  return Math.floor(elapsed / MS_PER_DAY);
}

/**
 * The wait as text: "under 1 day" (less than 24 hours elapsed, which may well
 * be yesterday's date, so never "today"), "1 day", "4 days". Null when nothing
 * was sent. Shared by every screen that shows a wait.
 */
export function daysSinceText(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "under 1 day";
  return days === 1 ? "1 day" : `${days} days`;
}

/** The earliest sent_at among the RFQs, or null when none went out. */
export function earliestSentAt(rfqs: ReadonlyArray<Pick<QueueRfq, "sent_at">>): string | null {
  let earliest: { iso: string; time: number } | null = null;
  for (const rfq of rfqs) {
    if (rfq.sent_at === null) continue;
    const time = new Date(rfq.sent_at).getTime();
    if (Number.isNaN(time)) continue;
    if (earliest === null || time < earliest.time) earliest = { iso: rfq.sent_at, time };
  }
  return earliest?.iso ?? null;
}

function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** One card: the request plus what the queue shows about its RFQs. */
export function toQueueCard(request: QueueRequest, now: Date): QueueCard {
  const sent = request.rfqs.filter(rfqWasSent);
  const received = request.rfqs.filter(rfqWasReceived);
  const perRfq: QueueRfqDays[] = [...request.rfqs]
    .sort((a, b) => compareText(a.vendor_name, b.vendor_name) || compareText(a.branch_name, b.branch_name) || compareText(a.id, b.id))
    .map((rfq) => ({
      rfq_id: rfq.id,
      vendor_name: rfq.vendor_name,
      branch_name: rfq.branch_name,
      status: rfq.status,
      days: wholeDaysSince(rfq.sent_at, now),
    }));
  return {
    ...request,
    group: queueGroupForStatus(request.status),
    sent_count: sent.length,
    received_count: received.length,
    days_since_send: wholeDaysSince(earliestSentAt(request.rfqs), now),
    per_rfq_days: perRfq,
  };
}

/** Newest received first; ties broken by id so the order is stable across renders. */
function compareNewestFirst(a: QueueCard, b: QueueCard): number {
  const left = new Date(a.received_at).getTime();
  const right = new Date(b.received_at).getTime();
  if (left !== right) return right - left;
  return compareText(a.id, b.id);
}

export function emptyGroups<T>(make: () => T): Record<QueueGroup, T> {
  const groups = {} as Record<QueueGroup, T>;
  for (const group of QUEUE_GROUPS) groups[group] = make();
  return groups;
}

/**
 * Every request sorted into its group, newest received first inside each.
 * Every group key is present even when empty, so the page can render the
 * sections in QUEUE_GROUPS order without checks.
 */
export function groupForQueue(requests: readonly QueueRequest[], now: Date): Record<QueueGroup, QueueCard[]> {
  const groups = emptyGroups<QueueCard[]>(() => []);
  for (const request of requests) {
    const card = toQueueCard(request, now);
    groups[card.group].push(card);
  }
  for (const group of QUEUE_GROUPS) groups[group].sort(compareNewestFirst);
  return groups;
}

export function queueCounts(groups: Record<QueueGroup, readonly QueueCard[]>): Record<QueueGroup, number> {
  const counts = emptyGroups<number>(() => 0);
  for (const group of QUEUE_GROUPS) counts[group] = groups[group].length;
  return counts;
}

/** The sum of every group, for the heading. */
export function totalCount(counts: Record<QueueGroup, number>): number {
  return QUEUE_GROUPS.reduce((sum, group) => sum + counts[group], 0);
}

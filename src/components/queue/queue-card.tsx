// One request on the work queue (PRD FR-12): what it is, where it stands, and
// the one or two places to go next. Server component; every value arrives
// computed from src/lib/queue/group.ts, nothing is derived here beyond text.
//
// An awaiting-responses card adds "received n / sent m" (AC-12.1) and the
// per-RFQ wait in whole days since that RFQ went out (AC-12.2). The wait is
// elapsed time (wholeDaysSince), so under 24 hours reads "under 1 day", never
// "today": an RFQ sent yesterday afternoon and viewed this morning is not
// today's.

import { format } from "date-fns";
import Link from "next/link";
import { RfqStatusBadge } from "@/components/rfqs/rfq-card";
import { StatusBadge } from "@/components/status-badge";
import { daysSinceText, type QueueCard as QueueCardModel } from "@/lib/queue/group";

export const UNTITLED_REQUEST = "Material request";

/** "3 lines", "1 line", "no lines yet". */
export function lineCountText(count: number): string {
  if (count === 0) return "no lines yet";
  return count === 1 ? "1 line" : `${count} lines`;
}

/** The wait column of the per-RFQ list: "not sent", "sent under a day ago", "3 days waiting" (still open), "3 days since send" (answered). */
export function rfqWaitText(entry: Pick<QueueCardModel["per_rfq_days"][number], "status" | "days">): string {
  if (entry.days === null) return "not sent";
  if (entry.days === 0) return "sent under a day ago";
  const days = daysSinceText(entry.days);
  return entry.status === "sent" ? `${days} waiting` : `${days} since send`;
}

/** The header's wait since the first send: "first send under a day ago", "3 days since first send"; null when nothing was sent. */
export function firstSendText(daysSinceSend: number | null): string | null {
  if (daysSinceSend === null) return null;
  if (daysSinceSend === 0) return "first send under a day ago";
  return `${daysSinceText(daysSinceSend)} since first send`;
}

const linkClass = "font-medium text-zinc-900 underline hover:text-zinc-700";

export function QueueCard({ card }: { card: QueueCardModel }) {
  const title = card.subject ?? UNTITLED_REQUEST;
  const base = `/requests/${card.id}`;
  const awaiting = card.group === "awaiting_responses";
  const sinceFirstSend = firstSendText(card.days_since_send);

  return (
    <article aria-labelledby={`queue-card-${card.id}`} className="flex flex-col gap-3 rounded border border-zinc-200 bg-white p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`queue-card-${card.id}`} className="text-base font-semibold text-zinc-900">
            <Link href={base} className="hover:underline">
              {title}
            </Link>
          </h3>
          <p className="text-sm text-zinc-600">
            {card.customer_name ?? <span className="text-zinc-400">No customer</span>}
            {card.revision > 1 ? <span className="ml-2 rounded border border-zinc-200 bg-zinc-50 px-1.5 text-xs text-zinc-700">revision {card.revision}</span> : null}
          </p>
        </div>
        <StatusBadge status={card.status} />
      </header>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        <div>
          <dt className="inline">Received </dt>
          <dd className="inline text-zinc-700">{format(new Date(card.received_at), "MMM d, yyyy")}</dd>
        </div>
        <div>
          <dt className="sr-only">Lines</dt>
          <dd className="inline text-zinc-700">{lineCountText(card.line_count)}</dd>
        </div>
      </dl>

      {awaiting ? (
        <section aria-label="Replies" className="flex flex-col gap-2 rounded border border-zinc-100 bg-zinc-50 px-3 py-2 text-sm">
          <p className="text-zinc-800">
            <span className="font-medium">
              received {card.received_count} / sent {card.sent_count}
            </span>
            {sinceFirstSend !== null ? (
              <span className="text-zinc-600">
                {", "}
                {sinceFirstSend}
              </span>
            ) : null}
          </p>
          {card.per_rfq_days.length === 0 ? (
            <p className="text-xs text-zinc-500">No RFQs on this revision.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {card.per_rfq_days.map((entry) => (
                <li key={entry.rfq_id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="text-zinc-900">
                    {entry.vendor_name} <span className="text-zinc-600">{entry.branch_name}</span>
                  </span>
                  <RfqStatusBadge status={entry.status} />
                  <span className="ml-auto tabular-nums text-zinc-600">{rfqWaitText(entry)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <nav aria-label={`Open ${title}`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href={base} className={linkClass}>
          Review
        </Link>
        {awaiting ? (
          <Link href={`${base}/offers`} className={linkClass}>
            Offers
          </Link>
        ) : null}
        {card.group === "ready_to_compare" ? (
          <Link href={`${base}/compare`} className={linkClass}>
            Compare
          </Link>
        ) : null}
        {card.group === "drafts_ready" ? (
          <Link href={`${base}/rfqs`} className={linkClass}>
            RFQs
          </Link>
        ) : null}
      </nav>
    </article>
  );
}

// Request status as a small colored chip. The label and color tables are keyed
// by the request_status enum, so adding a status in SQL fails the type check
// here until it gets a label.

import type { RequestStatus } from "@/lib/db/enums";

const STATUS_LABELS: Record<RequestStatus, string> = {
  new: "New",
  parsing: "Parsing",
  needs_review: "Needs review",
  reviewed: "Reviewed",
  rfqs_drafted: "RFQs drafted",
  rfqs_sent: "RFQs sent",
  collecting: "Collecting replies",
  comparing: "Comparing",
  sourced: "Sourced",
  closed: "Closed",
};

const STATUS_CLASSES: Record<RequestStatus, string> = {
  new: "border-blue-200 bg-blue-50 text-blue-800",
  parsing: "border-zinc-200 bg-zinc-100 text-zinc-700",
  needs_review: "border-amber-200 bg-amber-50 text-amber-800",
  reviewed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  rfqs_drafted: "border-indigo-200 bg-indigo-50 text-indigo-800",
  rfqs_sent: "border-indigo-200 bg-indigo-50 text-indigo-800",
  collecting: "border-sky-200 bg-sky-50 text-sky-800",
  comparing: "border-violet-200 bg-violet-50 text-violet-800",
  sourced: "border-emerald-300 bg-emerald-100 text-emerald-900",
  closed: "border-zinc-300 bg-zinc-200 text-zinc-800",
};

export function statusLabel(status: RequestStatus): string {
  return STATUS_LABELS[status];
}

export function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

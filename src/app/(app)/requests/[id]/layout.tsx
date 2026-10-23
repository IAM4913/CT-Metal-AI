// Request workspace shell (PRD section 9, /requests/[id]): header, tab strip,
// then the active tab. The workspace is loaded through the cached loader so the
// tab page underneath reuses the same rows without a second round of queries.

import { format } from "date-fns";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { RequestTabs } from "@/components/request-tabs";
import { StatusBadge } from "@/components/status-badge";
import type { RequestSourceType } from "@/lib/db/enums";
import { loadRequestWorkspace } from "@/lib/server/requests";

const SOURCE_LABELS: Record<RequestSourceType, string> = {
  paste: "Pasted text",
  eml: "Email (.eml)",
  manual: "Manual entry",
  mailbox: "Mailbox",
};

type RequestLayoutProps = {
  params: Promise<{ id: string }>;
  children: ReactNode;
};

export default async function RequestLayout({ params, children }: RequestLayoutProps) {
  const { id } = await params;
  const workspace = await loadRequestWorkspace(id);
  if (!workspace) notFound();

  const { request, customer } = workspace;
  const title = request.subject.trim() !== "" ? request.subject : "Material request";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <StatusBadge status={request.status} />
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-600">
          {customer ? (
            <div>
              <dt className="inline font-medium text-zinc-800">Customer</dt>{" "}
              <dd className="inline">{customer.name}</dd>
            </div>
          ) : (
            <div>
              <dt className="inline font-medium text-zinc-800">Customer</dt>{" "}
              <dd className="inline text-zinc-500">not linked</dd>
            </div>
          )}
          <div>
            <dt className="inline font-medium text-zinc-800">Received</dt>{" "}
            <dd className="inline">{format(new Date(request.received_at), "MMM d, yyyy h:mm a")}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-zinc-800">Source</dt>{" "}
            <dd className="inline">{SOURCE_LABELS[request.source_type]}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-zinc-800">Revision</dt>{" "}
            <dd className="inline tabular-nums">{request.revision}</dd>
          </div>
        </dl>
      </header>

      <RequestTabs requestId={request.id} />

      {children}
    </div>
  );
}

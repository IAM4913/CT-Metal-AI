// Work queue (PRD section 9, route /): every open request grouped by status
// with counts, and for the ones waiting on vendors, received over sent and
// the days since each RFQ went out (FR-12). Server component: the rows are read
// under RLS by loadQueue and grouped by the pure code in src/lib/queue.

import Link from "next/link";
import { QueueBoard } from "@/components/queue/queue-board";
import { queueCounts } from "@/lib/queue/group";
import { loadQueue } from "@/lib/server/queue";
import { requireBroker } from "@/lib/server/session";

export default async function QueuePage() {
  const session = await requireBroker();
  const groups = await loadQueue(session);
  const counts = queueCounts(groups);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Work queue</h1>
          <p className="text-sm text-zinc-600">Requests by where they stand. A request edited after send shows once, as its newest revision.</p>
        </div>
        <Link
          href="/requests/new"
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
        >
          New request
        </Link>
      </header>
      <QueueBoard groups={groups} counts={counts} />
    </main>
  );
}

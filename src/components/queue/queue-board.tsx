// The work queue (PRD FR-12, AC-12.1): a strip of counts, one chip per group,
// then a section per group in QUEUE_GROUPS order with a card per request. Every
// group renders even when empty so the board reads the same way every day.

import { QueueCard } from "@/components/queue/queue-card";
import { QUEUE_GROUP_LABELS, QUEUE_GROUPS, totalCount, type QueueCard as QueueCardModel, type QueueGroup } from "@/lib/queue/group";

export type QueueBoardProps = {
  groups: Record<QueueGroup, QueueCardModel[]>;
  counts: Record<QueueGroup, number>;
};

export function groupAnchor(group: QueueGroup): string {
  return `group-${group}`;
}

export function QueueBoard({ groups, counts }: QueueBoardProps) {
  const total = totalCount(counts);

  return (
    <div className="flex flex-col gap-8">
      <nav aria-label="Queue counts" className="flex flex-wrap gap-2">
        {QUEUE_GROUPS.map((group) => {
          const count = counts[group];
          const muted = count === 0;
          return (
            <a
              key={group}
              href={`#${groupAnchor(group)}`}
              className={
                muted
                  ? "inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-500 hover:bg-zinc-50"
                  : "inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-zinc-50 px-3 py-1 text-sm text-zinc-900 hover:bg-zinc-100"
              }
            >
              <span>{QUEUE_GROUP_LABELS[group]}</span>
              <span className={`rounded-full px-1.5 text-xs tabular-nums ${muted ? "bg-zinc-100 text-zinc-500" : "bg-zinc-900 text-white"}`}>{count}</span>
            </a>
          );
        })}
        <span className="inline-flex items-center px-2 text-sm text-zinc-500">
          {total === 1 ? "1 request" : `${total} requests`}
        </span>
      </nav>

      {QUEUE_GROUPS.map((group) => {
        const cards = groups[group];
        const headingId = `${groupAnchor(group)}-heading`;
        return (
          <section key={group} id={groupAnchor(group)} aria-labelledby={headingId} className="flex flex-col gap-3">
            <div className="flex items-baseline gap-3 border-b border-zinc-200 pb-2">
              <h2 id={headingId} className="text-lg font-semibold text-zinc-900">
                {QUEUE_GROUP_LABELS[group]}
              </h2>
              <span className="text-sm tabular-nums text-zinc-500">{cards.length}</span>
            </div>
            {cards.length === 0 ? (
              <p className="text-sm text-zinc-500">Nothing here</p>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {cards.map((card) => (
                  <li key={card.id}>
                    <QueueCard card={card} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

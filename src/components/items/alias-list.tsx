// The aliases of one item, seed rows and this broker's learned rows in two
// lists. Seed aliases shipped with the catalog and are read-only here; each
// learned alias has a delete form. An alias that other items also carry is
// marked, since a lookup for it is ambiguous (the parser lets the learned row
// win, but the broker should know).

import type { ReactNode } from "react";
import { deleteAliasAction } from "@/app/(app)/items/actions";
import { ConfirmButton } from "@/components/vendors/confirm-button";
import { DANGER_BUTTON_CLASS } from "@/components/vendors/fields";
import type { AliasEntry, GroupedAliases } from "@/lib/server/items";

type AliasListProps = {
  itemId: string;
  aliases: GroupedAliases;
};

export function AliasList({ itemId, aliases }: AliasListProps) {
  const total = aliases.seed.length + aliases.learned.length;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-zinc-600">
        {total === 0
          ? "No aliases yet. The item is still reachable by its designation; add the phrases shops use for it below."
          : `${total} alias${total === 1 ? "" : "es"} resolve to this item. Every alias is stored normalized (lower case, inches dropped, # after a number as lb, tube as hss), which is the form a request line is compared in.`}
      </p>

      <AliasGroup
        heading="Learned by you"
        count={aliases.learned.length}
        empty="None yet. Aliases you add here, or teach by linking an unmatched line on the review screen, appear in this list."
      >
        {aliases.learned.map((entry) => (
          <AliasRow key={entry.id} entry={entry}>
            <form action={deleteAliasAction}>
              <input type="hidden" name="item_id" value={itemId} />
              <input type="hidden" name="alias_id" value={entry.id} />
              <ConfirmButton
                message={`Delete the alias "${entry.alias}"? Request lines using this phrase will no longer match this item until it is taught again.`}
                className={`${DANGER_BUTTON_CLASS} px-2 py-1 text-xs`}
              >
                Delete
              </ConfirmButton>
            </form>
          </AliasRow>
        ))}
      </AliasGroup>

      <AliasGroup
        heading="Seeded with the catalog"
        count={aliases.seed.length}
        empty="None. This item was added by hand, so it has no generated aliases."
      >
        {aliases.seed.map((entry) => (
          <AliasRow key={entry.id} entry={entry} />
        ))}
      </AliasGroup>
    </div>
  );
}

type AliasGroupProps = {
  heading: string;
  count: number;
  empty: string;
  children: ReactNode;
};

function AliasGroup({ heading, count, empty, children }: AliasGroupProps) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-zinc-800">
        {heading} <span className="font-normal text-zinc-500">({count})</span>
      </h3>
      {count === 0 ? (
        <p className="text-sm text-zinc-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded border border-zinc-200">{children}</ul>
      )}
    </section>
  );
}

function AliasRow({ entry, children }: { entry: AliasEntry; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
      <span className="font-mono text-zinc-900">{entry.alias}</span>
      {entry.also_on.length > 0 ? (
        <span className="text-xs text-amber-700">
          also on {entry.also_on.join(", ")}
          {entry.source === "seed" ? "" : " (yours wins when parsing)"}
        </span>
      ) : null}
      {children ? <span className="ml-auto">{children}</span> : null}
    </li>
  );
}

// One catalog item (PRD FR-4 AC-4.4): its fields, its aliases (seed and
// learned), and a form to add an alias. Everything is a plain form posting to
// ../actions.ts; the result of the last post comes back in the URL and is
// shown by ItemFlash.

import Link from "next/link";
import { notFound } from "next/navigation";
import { AddAliasForm } from "@/components/items/add-alias-form";
import { AliasList } from "@/components/items/alias-list";
import { ItemFlash } from "@/components/items/item-flash";
import { ItemForm } from "@/components/items/item-form";
import { formatWeight } from "@/components/items/item-table";
import { CATEGORY_LABELS } from "@/components/vendors/labels";
import { getItemWithAliases } from "@/lib/server/items";
import { requireBroker } from "@/lib/server/session";

type ItemPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ItemPage({ params, searchParams }: ItemPageProps) {
  const session = await requireBroker();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const detail = await getItemWithAliases(session, id);
  if (!detail) notFound();

  const { item, aliases } = detail;
  const aliasCount = aliases.seed.length + aliases.learned.length;

  return (
    <main className="flex flex-col gap-8">
      <nav aria-label="Breadcrumb" className="text-sm text-zinc-600">
        <Link href="/items" className="underline hover:text-zinc-900">
          Items
        </Link>
        <span className="mx-2">/</span>
        <span className="text-zinc-900">{item.designation}</span>
      </nav>

      <header>
        <h1 className="text-2xl font-semibold">{item.designation}</h1>
        <p className="mt-1 text-sm text-zinc-600">
          {CATEGORY_LABELS[item.category]}
          <span className="mx-2">/</span>
          {item.weight_per_ft === null ? "weight unknown" : `${formatWeight(item.weight_per_ft)} lb/ft`}
          <span className="mx-2">/</span>
          {item.default_grade ? `default grade ${item.default_grade}` : "no default grade"}
          <span className="mx-2">/</span>
          {aliasCount} alias{aliasCount === 1 ? "" : "es"}
        </p>
      </header>

      <ItemFlash params={query} />

      <section id="item-fields" aria-labelledby="item-fields-heading" className="rounded border border-zinc-200 p-4">
        <h2 id="item-fields-heading" className="text-lg font-semibold">
          Item
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Changing the designation renames it on every request line and RFQ that links here. Aliases stay attached.
        </p>
        <div className="mt-4">
          <ItemForm item={item} />
        </div>
      </section>

      <section id="aliases" aria-labelledby="aliases-heading" className="flex flex-col gap-4">
        <h2 id="aliases-heading" className="text-lg font-semibold">
          Aliases
        </h2>
        <AliasList itemId={item.id} aliases={aliases} />
      </section>

      <section id="add-alias" aria-labelledby="add-alias-heading" className="rounded border border-zinc-200 p-4">
        <h2 id="add-alias-heading" className="text-lg font-semibold">
          Add alias
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          A phrase customers write for this item. The next request that uses it links here without review.
        </p>
        <div className="mt-4">
          <AddAliasForm itemId={item.id} />
        </div>
      </section>
    </main>
  );
}

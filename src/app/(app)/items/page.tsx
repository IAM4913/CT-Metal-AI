// Item master (PRD FR-4, section 9: /items). Search the catalog by
// designation or alias, narrow by category, open an item to maintain its
// aliases, and add an item that the seed does not carry (AC-4.4).

import { ItemFlash } from "@/components/items/item-flash";
import { ItemForm } from "@/components/items/item-form";
import { ItemSearchForm } from "@/components/items/item-search-form";
import { ItemTable } from "@/components/items/item-table";
import { materialCategorySchema, type MaterialCategory } from "@/lib/db/enums";
import { searchItems } from "@/lib/server/items";
import { requireBroker } from "@/lib/server/session";

type ItemsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ItemsPage({ searchParams }: ItemsPageProps) {
  const session = await requireBroker();
  const params = await searchParams;

  const q = single(params, "q").trim();
  const category = categoryFrom(params);
  const searched = q !== "" || category !== null;
  const items = await searchItems(session, q, category ?? undefined);

  return (
    <main className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Items</h1>
        <p className="mt-1 text-sm text-zinc-600">
          The catalog of standard shapes and the shop phrases that resolve to each one. The catalog is shared
          reference data; the aliases you add are yours and win over the seeded ones when a request is parsed.
        </p>
      </div>

      <ItemFlash params={params} />

      <section aria-labelledby="item-search-heading" className="flex flex-col gap-3">
        <h2 id="item-search-heading" className="text-lg font-semibold">
          Search
        </h2>
        <ItemSearchForm q={q} category={category} />
      </section>

      <section aria-labelledby="item-results-heading" className="flex flex-col gap-3">
        <h2 id="item-results-heading" className="text-lg font-semibold">
          {searched ? `${items.length} match${items.length === 1 ? "" : "es"}` : `${items.length} item${items.length === 1 ? "" : "s"}`}
        </h2>
        <ItemTable items={items} searched={searched} />
      </section>

      <section id="new-item" aria-labelledby="new-item-heading" className="rounded border border-zinc-200 p-4">
        <h2 id="new-item-heading" className="text-lg font-semibold">
          New item
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          For a shape the seed does not carry. Add the item first; its aliases are added on the next screen.
        </p>
        <div className="mt-4">
          <ItemForm />
        </div>
      </section>
    </main>
  );
}

function single(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

/** The category filter, or null when absent or not a known category. */
function categoryFrom(params: Record<string, string | string[] | undefined>): MaterialCategory | null {
  const parsed = materialCategorySchema.safeParse(single(params, "category"));
  return parsed.success ? parsed.data : null;
}

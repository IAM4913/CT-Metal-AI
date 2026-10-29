// The /items results: one row per catalog item with its category, weight,
// grade, dims, and how many aliases this broker can see. Plain table; the
// designation links to the detail page.

import Link from "next/link";
import { CATEGORY_LABELS } from "@/components/vendors/labels";
import { dimsToText, ITEM_SEARCH_LIMIT, type ItemListRow } from "@/lib/server/items";

type ItemTableProps = {
  items: ItemListRow[];
  /** True when a search was made (so an empty list reads as "no match", not "empty catalog"). */
  searched: boolean;
};

export function ItemTable({ items, searched }: ItemTableProps) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-zinc-600">
        {searched
          ? "No item matches. Try the designation without spaces (C12x30) or a shop phrase (12 inch channel 30#), or add the item below."
          : "The catalog is empty. Run npm run seed, or add the first item below."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {items.length >= ITEM_SEARCH_LIMIT ? (
        <p className="text-xs text-zinc-500">Showing the first {ITEM_SEARCH_LIMIT} matches. Narrow the search to see the rest.</p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th scope="col" className="py-2 pr-4 font-medium">
                Designation
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Category
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Weight (lb/ft)
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Default grade
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Dims
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Aliases
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-zinc-100 align-top">
                <td className="py-2 pr-4">
                  <Link href={`/items/${item.id}`} className="font-medium text-zinc-900 underline hover:text-zinc-700">
                    {item.designation}
                  </Link>
                </td>
                <td className="py-2 pr-4 text-zinc-700">{CATEGORY_LABELS[item.category]}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-zinc-700">
                  {item.weight_per_ft === null ? <span className="text-zinc-400">unknown</span> : formatWeight(item.weight_per_ft)}
                </td>
                <td className="py-2 pr-4 text-zinc-700">
                  {item.default_grade ?? <span className="text-zinc-400">none</span>}
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-zinc-600">{dimsToText(item.dims)}</td>
                <td className="py-2 text-right tabular-nums text-zinc-700">{item.alias_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Pounds per foot to two decimals, as the catalog stores them. */
export function formatWeight(weight: number): string {
  return weight.toFixed(2);
}

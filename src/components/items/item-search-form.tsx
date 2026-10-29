// The /items search: a GET form, so the query lives in the URL and the result
// page can be bookmarked or reloaded. Text matches the designation (spaces
// ignored) or any alias (after normalizeAlias), the category narrows either.

import Link from "next/link";
import { INPUT_CLASS, PRIMARY_BUTTON_CLASS } from "@/components/vendors/fields";
import { CATEGORY_OPTIONS } from "@/components/vendors/labels";
import type { MaterialCategory } from "@/lib/db/enums";

type ItemSearchFormProps = {
  q: string;
  category: MaterialCategory | null;
};

export function ItemSearchForm({ q, category }: ItemSearchFormProps) {
  const hasFilter = q !== "" || category !== null;
  return (
    <form action="/items" method="get" className="flex flex-wrap items-end gap-3">
      <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-800">Designation or alias</span>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="C12x30, 8 square 5/8, 2x2x1/4 angle"
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-800">Category</span>
        <select name="category" defaultValue={category ?? ""} className={INPUT_CLASS}>
          <option value="">All categories</option>
          {CATEGORY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className={PRIMARY_BUTTON_CLASS}>
          Search
        </button>
        {hasFilter ? (
          <Link href="/items" className="text-sm text-zinc-700 underline hover:text-zinc-900">
            Clear
          </Link>
        ) : null}
      </div>
    </form>
  );
}

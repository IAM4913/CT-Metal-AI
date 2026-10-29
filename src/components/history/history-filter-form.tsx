// The purchase history search form (AC-11.2): customer, vendor, category,
// designation, date range, free text. A plain GET form, so the URL carries the
// search and a result can be bookmarked or sent along. Server component; the
// values come back from parseHistoryFilter so a dropped junk value shows blank.

import Link from "next/link";
import { materialCategoryValues, type MaterialCategory } from "@/lib/db/enums";
import type { HistoryFilter } from "@/lib/history/filter";

export const CATEGORY_LABELS: Record<MaterialCategory, string> = {
  hss_square: "HSS square",
  hss_rectangular: "HSS rectangular",
  hss_round: "HSS round",
  pipe: "Pipe",
  w_beam: "W beam",
  s_beam: "S beam",
  channel: "Channel",
  angle: "Angle",
  flat_bar: "Flat bar",
  round_bar: "Round bar",
  square_bar: "Square bar",
  plate: "Plate",
  sheet: "Sheet",
  rebar: "Rebar",
};

const inputClass =
  "w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500";
const labelClass = "flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-500";

export function HistoryFilterForm({ filter, hasFilter }: { filter: HistoryFilter; hasFilter: boolean }) {
  return (
    <form method="get" action="/history" className="flex flex-col gap-3 rounded border border-zinc-200 bg-zinc-50 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={labelClass}>
          Customer
          <input type="text" name="customer" defaultValue={filter.customer ?? ""} placeholder="any customer" className={inputClass} />
        </label>
        <label className={labelClass}>
          Vendor or branch
          <input type="text" name="vendor" defaultValue={filter.vendor ?? ""} placeholder="any vendor" className={inputClass} />
        </label>
        <label className={labelClass}>
          Category
          <select name="category" defaultValue={filter.category ?? ""} className={inputClass}>
            <option value="">Any category</option>
            {materialCategoryValues.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Designation
          <input type="text" name="designation" defaultValue={filter.designation ?? ""} placeholder="C12x30, W12x26, PL3/8" className={inputClass} />
        </label>
        <label className={labelClass}>
          Confirmed from
          <input type="date" name="from" defaultValue={filter.from ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>
          Confirmed to
          <input type="date" name="to" defaultValue={filter.to ?? ""} className={inputClass} />
        </label>
        <label className={`${labelClass} sm:col-span-2`}>
          Free text
          <input
            type="text"
            name="q"
            defaultValue={filter.q ?? ""}
            placeholder="designation, description, offered item, PO number, vendor, customer, subject"
            className={inputClass}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700">
          Search
        </button>
        {hasFilter ? (
          <Link href="/history" className="text-sm font-medium text-zinc-700 underline hover:text-zinc-900">
            Clear
          </Link>
        ) : null}
        <span className="text-xs text-zinc-500">
          Text fields match anywhere in the value, any case; a designation ignores spaces. Dates are inclusive, on the UTC calendar day the
          Confirmed column shows.
        </span>
      </div>
    </form>
  );
}

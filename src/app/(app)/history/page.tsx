// Purchase history (PRD section 9, route /history; FR-11). The filter lives in
// the URL (a GET form), the date range runs in the query, and the rest of the
// matching runs in code (src/lib/history/filter.ts). Each row links back to the
// request, the RFQ, and the reply it came from (AC-11.3).

import { HistoryFilterForm } from "@/components/history/history-filter-form";
import { HistoryTable, summaryText } from "@/components/history/history-table";
import { countPurchases, hasAnyFilter, parseHistoryFilter } from "@/lib/history/filter";
import { searchHistory } from "@/lib/server/history";
import { requireBroker } from "@/lib/server/session";

type HistoryPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function HistoryPage({ searchParams }: HistoryPageProps) {
  const [session, params] = await Promise.all([requireBroker(), searchParams]);
  const filter = parseHistoryFilter(params);
  const filtered = hasAnyFilter(filter);
  const rows = await searchHistory(session, filter);

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Purchase history</h1>
        <p className="text-sm text-zinc-600">Every confirmed purchase line, with the request, RFQ, and reply behind it.</p>
      </header>

      <HistoryFilterForm filter={filter} hasFilter={filtered} />

      <section aria-labelledby="history-results-heading" className="flex flex-col gap-3">
        <h2 id="history-results-heading" className="text-sm font-medium text-zinc-700">
          {rows.length === 0 ? "No results" : summaryText(rows.length, countPurchases(rows))}
        </h2>
        {rows.length === 0 ? (
          <p className="rounded border border-zinc-200 bg-zinc-50 px-4 py-6 text-sm text-zinc-600">
            {filtered
              ? "No purchase lines match these filters. Clear a field or two and search again."
              : "No purchases yet. Confirm a purchase from a request's Compare tab and it shows up here."}
          </p>
        ) : (
          <HistoryTable rows={rows} />
        )}
      </section>
    </main>
  );
}

"use client";

// One request line of the Compare tab (PRD section 8, AC-10.1, AC-10.6): the
// requested item, the sort controls, the table of offer rows, then the running
// "selected vs requested" line and the selection chips.
//
// Default order is vendor name (PRD section 8 rule 6). Price, ready date, and
// availability are one click away and never the default. Sorting is
// sortOffers() from src/lib/compare/build.ts, a pure function over the cells
// the server built; nothing is recomputed here.
//
// Over-selection (rule 5): the sum of selected quantities may fall short of the
// requested quantity (the remaining balance is shown) but a red warning appears
// when it exceeds it. It is a warning, not a block: the purchase bar names the
// over-selected lines in its confirm dialog and the broker decides (brokers do
// buy above the count for a bundle or the next job). The numbers come from the
// model (selected_qty, remaining, over_selected), which the server recomputes
// after every write.
//
// The requested item is named by its catalog designation when linked, else by
// the customer's own words (PRD section 8, "canonical or raw"), with the
// parser's description underneath when it adds something.

import { useTable } from "@tanstack/react-table";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { sortOffers, type LineComparison as LineModel, type OfferCell, type SortKey } from "@/lib/compare/build";
import {
  ALTERNATE_BADGE,
  formatNumber,
  formatQty,
  offerColumns,
  offerFeatures,
  parseQty,
  requestedItemTitle,
  type OfferRowMeta,
} from "@/components/compare/offer-row";

export type LineComparisonProps = {
  requestId: string;
  line: LineModel;
  /** The request is sourced or closed: selections are shown but cannot change. */
  readOnly: boolean;
  /** Each callback resolves to an error message, or null when the write succeeded. */
  onSelectExact: (line: LineModel, cell: OfferCell, qty: number) => Promise<string | null>;
  onOpenAlternate: (line: LineModel, cell: OfferCell) => void;
  onUpdateSelectionQty: (selectionId: string, qty: number) => Promise<string | null>;
  onUnselect: (selectionId: string) => Promise<string | null>;
};

const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "vendor", label: "Vendor" },
  { key: "price", label: "Price" },
  { key: "ready_date", label: "Ready date" },
  { key: "availability", label: "Availability" },
];

export const DEFAULT_SORT: SortKey = "vendor";

const smallButton =
  "rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

export function LineComparison({
  requestId,
  line,
  readOnly,
  onSelectExact,
  onOpenAlternate,
  onUpdateSelectionQty,
  onUnselect,
}: LineComparisonProps) {
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT);
  const sorted = useMemo(() => sortOffers(line.offers, sortKey), [line.offers, sortKey]);

  const selectedQty = useMemo(() => {
    const map = new Map<string, number>();
    for (const selection of line.selections) map.set(selection.offer_line_id, selection.qty);
    return map;
  }, [line.selections]);

  const meta = useMemo<OfferRowMeta>(
    () => ({
      requestId,
      requestedQty: line.line.qty,
      requestedUnit: line.line.unit,
      selectedQty,
      readOnly,
      onSelectExact: (cell, qty) => onSelectExact(line, cell, qty),
      onOpenAlternate: (cell) => onOpenAlternate(line, cell),
    }),
    [requestId, line, selectedQty, readOnly, onSelectExact, onOpenAlternate],
  );

  const table = useTable({
    features: offerFeatures,
    columns: offerColumns,
    data: sorted,
    getRowId: (row) => row.offer_line_id,
    meta,
  });

  const headingId = `line-${line.line.id}-heading`;
  const sortGroupId = `line-${line.line.id}-sort`;
  const { title, secondary } = requestedItemTitle(line.line);
  const alternateCount = line.offers.filter((cell) => !cell.is_exact_match).length;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded border border-zinc-200 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 id={headingId} className="text-base font-semibold text-zinc-900">
            <span className="tabular-nums text-zinc-500">Line {line.line.line_no}</span> {title}
          </h3>
          {secondary !== null ? <p className="text-xs text-zinc-500">{secondary}</p> : null}
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-700">
            <div>
              <dt className="inline text-zinc-500">Qty</dt> <dd className="inline tabular-nums">{formatQty(line.line.qty, line.line.unit)}</dd>
            </div>
            <div>
              <dt className="inline text-zinc-500">Length</dt>{" "}
              <dd className="inline tabular-nums">{line.line.length_ft === null ? "unknown" : `${formatNumber(line.line.length_ft)} ft`}</dd>
            </div>
            <div>
              <dt className="inline text-zinc-500">Grade</dt> <dd className="inline">{line.line.grade_spec ?? "unknown"}</dd>
            </div>
            {line.line.category !== null ? (
              <div>
                <dt className="inline text-zinc-500">Category</dt> <dd className="inline">{line.line.category.replace(/_/g, " ")}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        <div className="flex flex-col items-end gap-1">
          <div role="group" aria-labelledby={sortGroupId} className="flex flex-wrap items-center gap-1">
            <span id={sortGroupId} className="mr-1 text-xs text-zinc-500">
              Sort by
            </span>
            {SORT_OPTIONS.map((option) => {
              const active = option.key === sortKey;
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSortKey(option.key)}
                  className={
                    active
                      ? "rounded border border-zinc-900 bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white"
                      : "rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50"
                  }
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-zinc-500">
            {line.offers.length} {line.offers.length === 1 ? "offer" : "offers"}
            {alternateCount > 0 ? `, ${alternateCount} alternate` : ""}
          </span>
        </div>
      </header>

      {sorted.length === 0 ? (
        <p className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500">
          No offer covers this line yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-zinc-200">
          <table className="w-full min-w-[96rem] border-collapse text-left text-sm">
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id} className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                  {group.headers.map((header) => (
                    <th key={header.id} scope="col" className="px-2 py-2 font-medium">
                      {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {table.getRowModel().rows.map((row) => {
                const cell = row.original;
                const selected = selectedQty.has(cell.offer_line_id);
                const rowClass = [
                  "align-top",
                  cell.is_exact_match ? "" : "border-l-4 border-l-amber-400 bg-amber-50/60",
                  selected ? "outline outline-1 -outline-offset-1 outline-emerald-300" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr key={row.id} className={rowClass} aria-selected={selected}>
                    {row.getAllCells().map((tableCell) => (
                      <td key={tableCell.id} className="px-2 py-2">
                        <table.FlexRender cell={tableCell} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="flex flex-col gap-2 border-t border-zinc-200 pt-3">
        <SelectionSummary line={line} />
        {line.selections.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {line.selections.map((selection) => {
              const cell = line.offers.find((offer) => offer.offer_line_id === selection.offer_line_id) ?? null;
              // Keyed on the stored quantity too, so a change made from the
              // offer row (Update, or the alternate dialog's Change) remounts
              // the chip with the new value instead of keeping a stale draft
              // that a blur would write back.
              return (
                <SelectionChip
                  key={`${selection.selection_id}:${selection.qty}`}
                  selection={selection}
                  cell={cell}
                  unit={line.line.unit}
                  readOnly={readOnly}
                  onUpdateQty={onUpdateSelectionQty}
                  onUnselect={onUnselect}
                />
              );
            })}
          </ul>
        ) : null}
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Selected vs requested (PRD section 8 rule 5)
// ---------------------------------------------------------------------------

function SelectionSummary({ line }: { line: LineModel }) {
  const requested = line.line.qty;
  const unit = line.line.unit;
  const selected = line.selected_qty;

  if (line.selections.length === 0) {
    return (
      <p className="text-sm text-zinc-600">
        Nothing selected{requested === null ? "" : ` of ${formatQty(requested, unit)} requested`}.
      </p>
    );
  }

  if (line.over_selected && requested !== null) {
    return (
      <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
        Selected {formatQty(selected, unit)} exceeds the requested {formatQty(requested, unit)} by {formatNumber(selected - requested)}.
        Confirming buys the selected quantity.
      </p>
    );
  }

  if (requested === null || line.remaining === null) {
    return (
      <p className="text-sm text-zinc-700">
        Selected <span className="font-medium tabular-nums">{formatQty(selected, unit)}</span>. The requested quantity is unknown, so the
        remaining balance cannot be computed.
      </p>
    );
  }

  return (
    <p className="text-sm text-zinc-700">
      Selected{" "}
      <span className="font-medium tabular-nums">
        {formatNumber(selected)} of {formatQty(requested, unit)}
      </span>
      {line.remaining > 0 ? (
        <span className="text-amber-800">, {formatQty(line.remaining, unit)} remaining</span>
      ) : (
        <span className="text-emerald-800">, fully covered</span>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Selection chips: qty editable, remove
// ---------------------------------------------------------------------------

type SelectionChipProps = {
  selection: LineModel["selections"][number];
  cell: OfferCell | null;
  unit: LineModel["line"]["unit"];
  readOnly: boolean;
  onUpdateQty: (selectionId: string, qty: number) => Promise<string | null>;
  onUnselect: (selectionId: string) => Promise<string | null>;
};

function SelectionChip({ selection, cell, unit, readOnly, onUpdateQty, onUnselect }: SelectionChipProps) {
  const saved = String(selection.qty);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alternate = cell !== null && !cell.is_exact_match;
  const label = cell === null ? "offer line no longer on this request line (remove this selection)" : `${cell.vendor_name} ${cell.branch_name}`;

  async function commit() {
    if (draft.trim() === saved) return;
    const parsed = parseQty(draft);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    const message = await onUpdateQty(selection.selection_id, parsed.value);
    setSaving(false);
    setError(message);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(saved);
      setError(null);
    }
  }

  async function remove() {
    setSaving(true);
    setError(null);
    const message = await onUnselect(selection.selection_id);
    setSaving(false);
    setError(message);
  }

  return (
    <li
      className={`flex flex-col gap-1 rounded border px-2 py-1.5 text-sm ${
        alternate ? "border-amber-300 bg-amber-50" : "border-emerald-200 bg-emerald-50"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-900">{label}</span>
        {alternate ? <span className={ALTERNATE_BADGE}>alternate</span> : null}
        {cell !== null ? <span className="text-xs text-zinc-600">{cell.offered_designation ?? cell.offered_desc}</span> : null}
        {readOnly ? (
          <span className="tabular-nums">{formatQty(selection.qty, unit)}</span>
        ) : (
          <>
            <input
              type="text"
              inputMode="decimal"
              aria-label={`Selected quantity from ${label}`}
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void commit()}
              onKeyDown={onKeyDown}
              className={`w-20 rounded border bg-white px-1.5 py-0.5 text-right text-sm tabular-nums text-zinc-900 outline-none focus:border-zinc-500 ${
                error ? "border-red-400" : "border-zinc-300"
              }`}
            />
            <span className="text-xs text-zinc-600">{unit ?? ""}</span>
            <button type="button" disabled={saving} onClick={() => void remove()} className={`${smallButton} text-red-700 hover:bg-red-50`}>
              {saving ? "..." : "Remove"}
            </button>
          </>
        )}
      </div>
      {selection.note ? <span className="text-xs text-zinc-600">Note: {selection.note}</span> : null}
      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </li>
  );
}

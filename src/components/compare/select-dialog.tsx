"use client";

// Confirm an alternate before it is selected (PRD section 8 rule 3, AC-10.2).
// Alternates are never auto-selected: the row's button opens this dialog, which
// names what was asked, what was offered, and every attribute that changed,
// and only the "Select alternate anyway" button writes the selection. Cancel,
// Escape, and a click on the backdrop write nothing.
//
// The quantity defaults to the smaller of requested and available when both
// are known in one unit (defaultSelectQty); otherwise the input is blank or
// carries the requested quantity and must be checked. An optional note is
// stored on the selection (sourcing_selections.note); when the broker changes
// an existing selection the stored note is shown and kept unless edited.

import { useEffect, useRef, useState } from "react";
import type { LineComparison, OfferCell } from "@/lib/compare/build";
import {
  changedList,
  defaultSelectQty,
  extendedText,
  formatQty,
  parseQty,
  requestedItemTitle,
  unitPriceText,
} from "@/components/compare/offer-row";

export type SelectDialogProps = {
  line: LineComparison["line"];
  cell: OfferCell;
  /** Quantity already selected from this offer line, when the broker is changing it. */
  existingQty: number | null;
  /** The note stored on that selection, shown and resubmitted unless edited. */
  existingNote: string | null;
  /** Resolves to an error message, or null when the selection was saved. */
  onConfirm: (qty: number, note: string | null) => Promise<string | null>;
  onClose: () => void;
};

const inputClass =
  "w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50";

export function SelectDialog({ line, cell, existingQty, existingNote, onConfirm, onClose }: SelectDialogProps) {
  const initial = existingQty ?? defaultSelectQty(line.qty, cell.available_qty, cell.same_unit);
  const [qty, setQty] = useState(initial === null ? "" : String(initial));
  const [note, setNote] = useState(existingNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  const changed = changedList(cell);
  const { title: requested, secondary: requestedDetail } = requestedItemTitle(line);
  const offered = cell.offered_designation ?? cell.offered_desc;
  const headingId = `select-alternate-${cell.offer_line_id}-heading`;

  useEffect(() => {
    qtyRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function confirm() {
    const parsed = parseQty(qty);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    const trimmedNote = note.trim();
    const message = await onConfirm(parsed.value, trimmedNote === "" ? null : trimmedNote);
    if (message !== null) {
      setSaving(false);
      setError(message);
      return;
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-zinc-900/40 p-4 pt-24" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="flex w-full max-w-lg flex-col gap-4 rounded border border-amber-300 bg-white p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={headingId} className="text-lg font-semibold text-zinc-900">
              Select an alternate for line {line.line_no}
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              <span className="font-medium text-zinc-800">
                {cell.vendor_name} {cell.branch_name}
              </span>{" "}
              offered <span className="font-medium text-zinc-800">{offered}</span> in place of{" "}
              <span className="font-medium text-zinc-800">{requested}</span>
              {requestedDetail !== null ? <span className="text-zinc-500"> ({requestedDetail})</span> : null}.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-50">
            Close
          </button>
        </div>

        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-sm font-medium text-amber-900">What changed</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-900">
            {changed.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-zinc-700">
          <div>
            <dt className="text-xs text-zinc-500">Requested</dt>
            <dd className="tabular-nums">{formatQty(line.qty, line.unit)}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Available</dt>
            <dd className="tabular-nums">
              {formatQty(cell.available_qty, cell.unit)}
              {cell.available_qty !== null && !cell.same_unit ? <span className="text-xs text-zinc-500"> (not in the request&apos;s unit)</span> : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Unit price</dt>
            <dd className="tabular-nums">{unitPriceText(cell.unit_price, cell.price_basis)}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Extended</dt>
            <dd className="tabular-nums">{extendedText(cell.extended)}</dd>
          </div>
        </dl>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">Quantity to select{line.unit ? ` (${line.unit})` : ""}</span>
          <input
            ref={qtyRef}
            type="text"
            inputMode="decimal"
            value={qty}
            disabled={saving}
            onChange={(event) => setQty(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void confirm();
              }
            }}
            className={`${inputClass} w-32 text-right tabular-nums`}
          />
          {initial === null ? (
            <span className="text-xs text-zinc-500">No default: the requested or available quantity is unknown.</span>
          ) : existingQty === null && !cell.same_unit ? (
            <span className="text-xs text-zinc-500">The requested quantity: the vendor counts in another unit, so the two were not compared.</span>
          ) : null}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">Note (optional)</span>
          <textarea
            value={note}
            disabled={saving}
            rows={2}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why the alternate is acceptable, or what to tell the customer"
            className={inputClass}
          />
        </label>

        {error ? (
          <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={saving || qty.trim() === ""}
            className="rounded bg-amber-700 px-3 py-2 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
          >
            {saving ? "Selecting..." : "Select alternate anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}

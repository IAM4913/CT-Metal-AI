"use client";

// The top bar of the Compare tab: which RFQs declined, which are still waiting,
// how many selections exist, and the Confirm purchase button (AC-11.1).
//
// Nothing is purchased without the explicit button, then the explicit
// confirmation in the dialog (PO number and notes are optional). The button is
// disabled while there is no selection and once the request is sourced. An
// over-selected line (PRD section 8 rule 5) is a warning, not a block: the
// dialog names each such line with its selected and requested quantities so the
// broker confirms knowingly (brokers do buy above the count for a bundle or the
// next job). After a confirm the bar shows the purchases that were created (one
// per vendor branch) and points at the history page (PLAN Step 8).

import { differenceInCalendarDays, format } from "date-fns";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ComparisonModel } from "@/lib/compare/build";
import type { RequestStatus } from "@/lib/db/enums";

export type PurchaseInput = { poNumber: string | null; notes: string | null };

export type PurchaseOutcome =
  | { ok: true; purchaseIds: string[]; redirectTo: string | null }
  | { ok: false; error: string };

export type PurchaseBarProps = {
  requestId: string;
  status: RequestStatus;
  declined: ComparisonModel["declined"];
  awaiting: ComparisonModel["awaiting"];
  /** Every sourcing_selections row on this request. */
  selectionCount: number;
  /** Request lines with at least one selection, and the total number of lines. */
  linesSelected: number;
  lineCount: number;
  /** One line of text per over-selected request line ("Line 4 HSS6x6x3/8: selected 25 pcs of 20 pcs requested"), named in the confirm dialog. */
  overSelectedLines: string[];
  /** The request is sourced or closed. */
  readOnly: boolean;
  onConfirm: (input: PurchaseInput) => Promise<PurchaseOutcome>;
};

const primaryButton =
  "rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400";
const secondaryButton =
  "rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";
const inputClass =
  "w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50";

/** "sent today" or "3 days ago", for the awaiting list (AC-12.2 wording). */
export function sentAgo(sentAt: string | null, now: Date): string {
  if (sentAt === null) return "not sent";
  const days = differenceInCalendarDays(now, new Date(sentAt));
  if (days <= 0) return "sent today";
  return `sent ${days} ${days === 1 ? "day" : "days"} ago`;
}

export function PurchaseBar({
  requestId,
  status,
  declined,
  awaiting,
  selectionCount,
  linesSelected,
  lineCount,
  overSelectedLines,
  readOnly,
  onConfirm,
}: PurchaseBarProps) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Extract<PurchaseOutcome, { ok: true }> | null>(null);
  const now = new Date();

  const sourced = status === "sourced" || status === "closed";
  const disabledReason = readOnly ? (sourced ? "This request is already sourced." : "Selections are locked.") : selectionCount === 0 ? "Select at least one offer line first." : null;

  return (
    <div className="flex flex-col gap-3 rounded border border-zinc-200 bg-zinc-50 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1 text-sm text-zinc-700">
          <span>
            <span className="font-medium tabular-nums">{selectionCount}</span> {selectionCount === 1 ? "selection" : "selections"} on{" "}
            <span className="font-medium tabular-nums">
              {linesSelected} of {lineCount}
            </span>{" "}
            {lineCount === 1 ? "line" : "lines"}
          </span>
          <span className="text-xs text-zinc-600">
            Confirming creates one purchase per vendor branch from the current selections. Nothing is sent to a vendor.
          </span>
          {disabledReason !== null && !sourced ? <span className="text-xs text-zinc-600">{disabledReason}</span> : null}
          {!readOnly && overSelectedLines.length > 0 ? (
            <span className="text-xs font-medium text-red-800">
              {overSelectedLines.length === 1 ? "One line is" : `${overSelectedLines.length} lines are`} over-selected. Confirming buys the selected
              quantities.
            </span>
          ) : null}
          {sourced ? (
            <span className="text-xs text-emerald-800">This request is sourced. The selections below are the record of the purchase.</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabledReason !== null}
          title={disabledReason ?? undefined}
          className={primaryButton}
        >
          Confirm purchase
        </button>
      </div>

      {result !== null ? (
        <div role="status" className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <p className="font-medium">
            Purchase confirmed: {result.purchaseIds.length} {result.purchaseIds.length === 1 ? "purchase" : "purchases"} created.
          </p>
          {result.purchaseIds.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
              {result.purchaseIds.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-xs">
            <Link href={result.redirectTo ?? "/history"} className="font-medium underline hover:text-emerald-700">
              Open purchase history
            </Link>{" "}
            (the history page arrives in Step 8).
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <section aria-labelledby={`awaiting-${requestId}`} className="flex flex-col gap-1">
          <h2 id={`awaiting-${requestId}`} className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Awaiting a reply ({awaiting.length})
          </h2>
          {awaiting.length === 0 ? (
            <p className="text-xs text-zinc-500">Every sent RFQ has answered.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {awaiting.map((rfq) => (
                <li key={rfq.rfq_id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-zinc-800">{rfq.vendor_name}</span>
                  <span className="text-zinc-600">{rfq.branch_name}</span>
                  <span className="text-xs text-zinc-500">
                    {sentAgo(rfq.sent_at, now)}
                    {rfq.sent_at ? ` (${format(new Date(rfq.sent_at), "MMM d")})` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby={`declined-${requestId}`} className="flex flex-col gap-1">
          <h2 id={`declined-${requestId}`} className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Declined ({declined.length})
          </h2>
          {declined.length === 0 ? (
            <p className="text-xs text-zinc-500">No vendor has declined.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {declined.map((rfq) => (
                <li key={rfq.rfq_id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-zinc-800">{rfq.vendor_name}</span>
                  <span className="text-zinc-600">{rfq.branch_name}</span>
                  <span className="text-xs text-zinc-500">{rfq.reason ?? "no reason given"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {open ? (
        <ConfirmPurchaseDialog
          selectionCount={selectionCount}
          linesSelected={linesSelected}
          lineCount={lineCount}
          overSelectedLines={overSelectedLines}
          onConfirm={onConfirm}
          onDone={(outcome) => {
            setResult(outcome);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog: PO number and notes, then the explicit button
// ---------------------------------------------------------------------------

type ConfirmPurchaseDialogProps = {
  selectionCount: number;
  linesSelected: number;
  lineCount: number;
  overSelectedLines: string[];
  onConfirm: (input: PurchaseInput) => Promise<PurchaseOutcome>;
  onDone: (outcome: Extract<PurchaseOutcome, { ok: true }>) => void;
  onClose: () => void;
};

function ConfirmPurchaseDialog({ selectionCount, linesSelected, lineCount, overSelectedLines, onConfirm, onDone, onClose }: ConfirmPurchaseDialogProps) {
  const [poNumber, setPoNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    poRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function confirm() {
    setSaving(true);
    setError(null);
    const po = poNumber.trim();
    const text = notes.trim();
    const outcome = await onConfirm({ poNumber: po === "" ? null : po, notes: text === "" ? null : text });
    if (!outcome.ok) {
      setSaving(false);
      setError(outcome.error);
      return;
    }
    onDone(outcome);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-zinc-900/40 p-4 pt-24" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-purchase-heading"
        className="flex w-full max-w-md flex-col gap-4 rounded border border-zinc-200 bg-white p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <h2 id="confirm-purchase-heading" className="text-lg font-semibold text-zinc-900">
            Confirm purchase
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            <span className="font-medium tabular-nums text-zinc-800">{selectionCount}</span>{" "}
            {selectionCount === 1 ? "selection" : "selections"} on{" "}
            <span className="font-medium tabular-nums text-zinc-800">
              {linesSelected} of {lineCount}
            </span>{" "}
            {lineCount === 1 ? "line" : "lines"} become one purchase per vendor branch, stamped now. Totals are left blank
            where a price or freight is unknown.
          </p>
        </div>

        {overSelectedLines.length > 0 ? (
          <div role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <p className="font-medium">
              {overSelectedLines.length === 1 ? "This line is" : "These lines are"} selected above the requested quantity. Confirming buys the
              selected quantity.
            </p>
            <ul className="mt-1 list-disc pl-5">
              {overSelectedLines.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">PO number (optional)</span>
          <input
            ref={poRef}
            type="text"
            value={poNumber}
            disabled={saving}
            onChange={(event) => setPoNumber(event.target.value)}
            spellCheck={false}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">Notes (optional)</span>
          <textarea value={notes} disabled={saving} rows={3} onChange={(event) => setNotes(event.target.value)} className={inputClass} />
        </label>

        {error ? (
          <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className={secondaryButton}>
            Cancel
          </button>
          <button type="button" onClick={() => void confirm()} disabled={saving} className={primaryButton}>
            {saving ? "Confirming..." : "Confirm purchase"}
          </button>
        </div>
      </div>
    </div>
  );
}

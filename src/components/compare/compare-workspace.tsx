"use client";

// The Compare tab (PRD FR-10, FR-11; section 8): the purchase bar on top, then
// one block per request line with its offers side by side, and the alternate
// confirm dialog when a broker picks an alternate.
//
// Client component because it holds the banner, the open dialog, and the
// purchase result. Every write goes through a server action in
// src/app/(app)/requests/[id]/actions.ts and is followed by router.refresh(),
// so the cells and selections shown are what the database has (the server
// rebuilds the ComparisonModel on every render); nothing is patched locally.
//
// Rules this file enforces on the client side (the lib enforces them again):
//   - An alternate is selected only from the dialog, with confirmAlternate set
//     by the dialog's own button (PRD section 8 rule 3). Exactness is the
//     model's is_exact_match, which build.ts derives from the data and not the
//     stored flag alone.
//   - Confirm purchase is the explicit button in the purchase bar (AC-11.1).
//     An over-selected line is a warning named in its dialog (rule 5), never a
//     block.
//   - Once the request is sourced or closed, selections are read-only, so a
//     second click cannot buy the same material twice.
//
// A superseded revision (AC-8.4) stays writable here for the same reason the
// Offers tab does: its RFQs are the ones that went out, so its offers and
// selections live on it. A note says so and links forward.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  confirmPurchaseAction,
  selectOfferLineAction,
  unselectOfferLineAction,
  updateSelectionQtyAction,
} from "@/app/(app)/requests/[id]/actions";
import { LineComparison } from "@/components/compare/line-comparison";
import { formatQty, requestedItemTitle } from "@/components/compare/offer-row";
import { PurchaseBar, type PurchaseInput, type PurchaseOutcome } from "@/components/compare/purchase-bar";
import { SelectDialog } from "@/components/compare/select-dialog";
import type { ComparisonModel, LineComparison as LineModel, OfferCell } from "@/lib/compare/build";
import type { RequestStatus } from "@/lib/db/enums";

export type CompareWorkspaceProps = {
  request: { id: string; status: RequestStatus; revision: number };
  model: ComparisonModel;
  /** The newer revision's id when this one is superseded (AC-8.4). */
  supersededBy: string | null;
};

type ActionOutcome = { ok: boolean; error?: string; redirectTo?: string };

/** Statuses in which the purchase is already on record: no selection changes. */
const LOCKED: ReadonlySet<RequestStatus> = new Set<RequestStatus>(["sourced", "closed"]);

const FAILED_TO_REACH = "The request did not reach the server. Try again.";

export function CompareWorkspace({ request, model, supersededBy }: CompareWorkspaceProps) {
  const router = useRouter();
  const readOnly = LOCKED.has(request.status);
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [alternate, setAlternate] = useState<{ line: LineModel; cell: OfferCell } | null>(null);

  const selectionCount = useMemo(() => model.lines.reduce((sum, line) => sum + line.selections.length, 0), [model.lines]);
  const linesSelected = useMemo(() => model.lines.filter((line) => line.selections.length > 0).length, [model.lines]);
  const overSelectedLines = useMemo(
    () =>
      model.lines
        .filter((line) => line.over_selected)
        .map((line) => {
          const { title } = requestedItemTitle(line.line);
          return `Line ${line.line.line_no} ${title}: selected ${formatQty(line.selected_qty, line.line.unit)} of ${formatQty(line.line.qty, line.line.unit)} requested`;
        }),
    [model.lines],
  );
  const offerCount = useMemo(() => model.lines.reduce((sum, line) => sum + line.offers.length, 0), [model.lines]);

  // Run a server action; on success refresh the server components so the
  // model is rebuilt from the stored rows. Resolves to the error message for
  // the caller's control, or null.
  const run = useCallback(
    async (work: () => Promise<ActionOutcome>): Promise<string | null> => {
      let result: ActionOutcome;
      try {
        result = await work();
      } catch (error) {
        console.error("[compare] action failed", error);
        return FAILED_TO_REACH;
      }
      if (!result.ok) return result.error ?? "Something went wrong. Try again.";
      if (typeof result.redirectTo === "string" && result.redirectTo !== "") {
        router.push(result.redirectTo);
      } else {
        router.refresh();
      }
      return null;
    },
    [router],
  );

  const select = useCallback(
    (line: LineModel, cell: OfferCell, qty: number, note: string | null, confirmAlternate: boolean) =>
      run(() =>
        selectOfferLineAction({
          requestLineId: line.line.id,
          offerLineId: cell.offer_line_id,
          qty,
          note,
          confirmAlternate,
        }),
      ),
    [run],
  );

  // Exact rows write at once and never claim an alternate confirmation.
  const onSelectExact = useCallback(
    (line: LineModel, cell: OfferCell, qty: number) => {
      if (!cell.is_exact_match) {
        setAlternate({ line, cell });
        return Promise.resolve<string | null>("This is an alternate. Confirm what changed in the dialog first.");
      }
      return select(line, cell, qty, null, false);
    },
    [select],
  );

  const onOpenAlternate = useCallback((line: LineModel, cell: OfferCell) => {
    setBanner(null);
    setAlternate({ line, cell });
  }, []);

  const onUpdateSelectionQty = useCallback(
    (selectionId: string, qty: number) => run(() => updateSelectionQtyAction(selectionId, qty)),
    [run],
  );
  const onUnselect = useCallback((selectionId: string) => run(() => unselectOfferLineAction(selectionId)), [run]);

  const onConfirmPurchase = useCallback(
    async (input: PurchaseInput): Promise<PurchaseOutcome> => {
      let result: Awaited<ReturnType<typeof confirmPurchaseAction>>;
      try {
        result = await confirmPurchaseAction(request.id, input);
      } catch (error) {
        console.error("[compare] confirmPurchase failed", error);
        return { ok: false, error: FAILED_TO_REACH };
      }
      if (!result.ok) {
        return { ok: false, error: "error" in result && typeof result.error === "string" ? result.error : "Something went wrong. Try again." };
      }
      const purchaseIds =
        "purchaseIds" in result && Array.isArray(result.purchaseIds)
          ? result.purchaseIds.filter((id): id is string => typeof id === "string")
          : [];
      const redirectTo = "redirectTo" in result && typeof result.redirectTo === "string" && result.redirectTo !== "" ? result.redirectTo : null;
      setBanner({
        tone: "ok",
        text: `Purchase confirmed: ${purchaseIds.length} ${purchaseIds.length === 1 ? "purchase" : "purchases"} recorded. The request is now sourced.`,
      });
      router.refresh();
      return { ok: true, purchaseIds, redirectTo };
    },
    [request.id, router],
  );

  // The selection already made from the alternate being changed, so the dialog
  // shows its quantity and keeps its note unless the broker edits it.
  const alternateExisting =
    alternate === null ? null : (alternate.line.selections.find((selection) => selection.offer_line_id === alternate.cell.offer_line_id) ?? null);

  return (
    <div className="flex flex-col gap-6">
      <PurchaseBar
        requestId={request.id}
        status={request.status}
        declined={model.declined}
        awaiting={model.awaiting}
        selectionCount={selectionCount}
        linesSelected={linesSelected}
        lineCount={model.lines.length}
        overSelectedLines={overSelectedLines}
        readOnly={readOnly}
        onConfirm={onConfirmPurchase}
      />

      {supersededBy !== null ? (
        <p role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This revision has been superseded, but its RFQs are the ones that went out, so the replies and the selections live
          here. Edits to the request itself belong on{" "}
          <Link href={`/requests/${supersededBy}`} className="font-medium underline hover:text-amber-700">
            the newer revision
          </Link>
          .
        </p>
      ) : null}

      {banner ? (
        <p
          role={banner.tone === "error" ? "alert" : "status"}
          className={
            banner.tone === "error"
              ? "rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              : "rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          }
        >
          {banner.text}
        </p>
      ) : null}

      <main className="flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-semibold">Offers by line</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Every offer line from every vendor, side by side per request line. Rows sort by vendor name unless you pick
            another order. Alternates are marked and list what changed; selecting one asks for a confirmation. Unknown
            values stay unknown and are left out of totals.
          </p>
        </div>

        {model.lines.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500">
            This request has no lines to compare.
          </p>
        ) : offerCount === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500">
            No offer lines yet. Add and review the vendor replies on the{" "}
            <Link href={`/requests/${request.id}/offers`} className="font-medium text-zinc-900 underline hover:text-zinc-700">
              Offers tab
            </Link>{" "}
            and they appear here per line.
          </p>
        ) : null}

        {model.lines.map((line) => (
          <LineComparison
            key={line.line.id}
            requestId={request.id}
            line={line}
            readOnly={readOnly}
            onSelectExact={onSelectExact}
            onOpenAlternate={onOpenAlternate}
            onUpdateSelectionQty={onUpdateSelectionQty}
            onUnselect={onUnselect}
          />
        ))}
      </main>

      {alternate !== null ? (
        <SelectDialog
          line={alternate.line.line}
          cell={alternate.cell}
          existingQty={alternateExisting?.qty ?? null}
          existingNote={alternateExisting?.note ?? null}
          onConfirm={(qty, note) => select(alternate.line, alternate.cell, qty, note, true)}
          onClose={() => setAlternate(null)}
        />
      ) : null}
    </div>
  );
}

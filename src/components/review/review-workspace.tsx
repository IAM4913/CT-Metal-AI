"use client";

// The Review tab (PRD FR-3): source text on the left, editable lines on the
// right, with Parse, Confirm, add, merge, link, and clear-flags actions.
//
// Client component because it holds the selection (which line's span is
// highlighted), the merge checkboxes, the "show removed" toggle, and the open
// link dialog. Every write goes through a server action in
// src/app/(app)/requests/[id]/actions.ts and is followed by router.refresh(),
// so the rows shown are always the database rows; nothing is patched locally.

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition, type FormEvent } from "react";
import {
  addLineAction,
  clearLineFlagsAction,
  confirmRequestAction,
  linkLineToItemAction,
  mergeLinesAction,
  parseRequestAction,
  removeLineAction,
  updateLineAction,
} from "@/app/(app)/requests/[id]/actions";
import { LinesGrid, type LinePatch, type ReviewLine } from "@/components/review/lines-grid";
import { LinkItemDialog } from "@/components/review/link-item-dialog";
import {
  SourcePane,
  type SourceAttachment,
  type SourceHighlight,
  type SourceMessage,
} from "@/components/review/source-pane";
import { lineUnitValues, type RequestStatus } from "@/lib/db/enums";

export type ReviewWorkspaceProps = {
  request: { id: string; status: RequestStatus; source_text: string };
  lines: ReviewLine[];
  attachments: SourceAttachment[];
  message: SourceMessage | null;
  canConfirm: { ok: boolean; problems: string[] };
};

type ActionOutcome = { ok: true } | { ok: false; error: string };

const primaryButton =
  "rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400";
const secondaryButton =
  "rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

/** Statuses in which the request has not been confirmed yet. */
const BEFORE_REVIEW: ReadonlySet<RequestStatus> = new Set<RequestStatus>(["new", "parsing", "needs_review"]);

export function ReviewWorkspace({ request, lines, attachments, message, canConfirm }: ReviewWorkspaceProps) {
  const router = useRouter();
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [showRemoved, setShowRemoved] = useState(false);
  const [linkLine, setLinkLine] = useState<ReviewLine | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [parsePending, startParse] = useTransition();
  const [confirmPending, startConfirm] = useTransition();
  const [mergePending, startMerge] = useTransition();

  const removedCount = lines.filter((line) => line.status === "removed").length;
  const visibleLines = useMemo(
    () => (showRemoved ? lines : lines.filter((line) => line.status !== "removed")),
    [lines, showRemoved],
  );

  const selectedLine = lines.find((line) => line.id === selectedLineId) ?? null;
  const highlight = useMemo<SourceHighlight | null>(() => {
    if (!selectedLine) return null;
    const span = selectedLine.source_span;
    if (span === null) {
      return { kind: "none", reason: `Line ${selectedLine.line_no} was added by hand and has no source span.` };
    }
    if (span.kind === "text") return { kind: "text", start: span.start, end: span.end };
    const attachment = attachments.find((a) => a.id === span.attachment_id);
    return { kind: "attachment", filename: attachment?.filename ?? "an attachment", page: span.page };
  }, [selectedLine, attachments]);

  // Run a server action; on success refresh the server components so the grid
  // shows the stored row. Resolves to the error message for the caller's cell.
  const run = useCallback(
    async (work: () => Promise<ActionOutcome>): Promise<string | null> => {
      let result: ActionOutcome;
      try {
        result = await work();
      } catch (error) {
        console.error("[review] action failed", error);
        return "The request did not reach the server. Try again.";
      }
      if (!result.ok) return result.error;
      router.refresh();
      return null;
    },
    [router],
  );

  const onEdit = useCallback(
    (lineId: string, patch: LinePatch) => run(() => updateLineAction(lineId, patch)),
    [run],
  );
  const onRemove = useCallback((lineId: string) => run(() => removeLineAction(lineId)), [run]);
  const onClearFlags = useCallback((lineId: string) => run(() => clearLineFlagsAction(lineId)), [run]);
  const onSetCustom = useCallback(
    (lineId: string, custom: boolean) => run(() => updateLineAction(lineId, { status: custom ? "custom" : "parsed" })),
    [run],
  );
  const onLink = useCallback((line: ReviewLine) => setLinkLine(line), []);
  const onSelect = useCallback((lineId: string) => setSelectedLineId(lineId), []);
  const onToggleChecked = useCallback((lineId: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }, []);

  function handleParse() {
    setBanner(null);
    startParse(async () => {
      const message = await run(() => parseRequestAction(request.id));
      if (message !== null) setBanner(message);
    });
  }

  function handleConfirm() {
    setBanner(null);
    startConfirm(async () => {
      const message = await run(() => confirmRequestAction(request.id));
      if (message !== null) setBanner(message);
    });
  }

  // Merge keeps the lower-numbered line and folds the other into it.
  const checkedLines = lines.filter((line) => checked.has(line.id) && line.status !== "removed");
  const mergePair =
    checkedLines.length === 2 ? [...checkedLines].sort((a, b) => a.line_no - b.line_no) : null;

  function handleMerge() {
    if (!mergePair) return;
    const [keep, drop] = mergePair;
    setBanner(null);
    startMerge(async () => {
      const message = await run(() => mergeLinesAction(keep.id, drop.id));
      if (message !== null) setBanner(message);
      else setChecked(new Set());
    });
  }

  const hasPdf = attachments.some((a) => a.mime === "application/pdf");
  const nothingToParse = request.source_text.trim() === "" && !hasPdf;
  const hasLines = lines.some((line) => line.status !== "removed");
  const parsing = request.status === "parsing" || parsePending;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded border border-zinc-200 bg-zinc-50 px-4 py-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleParse}
              disabled={parsing || nothingToParse}
              className={hasLines ? secondaryButton : primaryButton}
              title={nothingToParse ? "There is no text or PDF to parse" : undefined}
            >
              {parsing ? "Parsing..." : hasLines ? "Re-parse" : "Parse request"}
            </button>
            <span className="text-xs text-zinc-600">
              {hasLines
                ? "Re-parse replaces parsed lines. Confirmed, custom, and removed lines are kept."
                : "Extracts one line per item with its source span. Blanks are flagged, never filled."}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm.ok || confirmPending || parsing}
            className={primaryButton}
          >
            {confirmPending ? "Confirming..." : BEFORE_REVIEW.has(request.status) ? "Confirm request" : "Confirm again"}
          </button>
          {!BEFORE_REVIEW.has(request.status) ? (
            <span className="text-xs text-emerald-700">Reviewed. Edits here still apply to this revision.</span>
          ) : null}
          {!canConfirm.ok && canConfirm.problems.length > 0 ? (
            <ul className="max-w-md list-disc pl-5 text-right text-xs text-amber-800 marker:text-amber-500">
              {canConfirm.problems.map((problem) => (
                <li key={problem} className="text-left">
                  {problem}
                </li>
              ))}
            </ul>
          ) : null}
          {!canConfirm.ok && canConfirm.problems.length === 0 ? (
            <span className="text-xs text-amber-800">Every line needs a quantity, a unit, and a catalog link or custom mark.</span>
          ) : null}
        </div>
      </div>

      {banner ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {banner}
        </p>
      ) : null}

      <main className="grid gap-8 lg:grid-cols-[2fr_3fr]">
        <SourcePane sourceText={request.source_text} attachments={attachments} message={message} highlight={highlight} />

        <section aria-labelledby="lines-heading" className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="lines-heading" className="text-lg font-semibold">
                Lines
              </h2>
              <p className="mt-1 text-sm text-zinc-600">
                {hasLines
                  ? `${lines.length - removedCount} line${lines.length - removedCount === 1 ? "" : "s"}. Click a row to see its source. Edit a cell, then Enter or click away to save.`
                  : "Nothing parsed yet."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {mergePair ? (
                <button type="button" onClick={handleMerge} disabled={mergePending} className={secondaryButton}>
                  {mergePending ? "Merging..." : `Merge ${mergePair[1].line_no} into ${mergePair[0].line_no}`}
                </button>
              ) : checkedLines.length > 0 ? (
                <span className="text-xs text-zinc-500">Check exactly two lines to merge them.</span>
              ) : null}
              {removedCount > 0 ? (
                <label className="flex items-center gap-2 text-zinc-700">
                  <input
                    type="checkbox"
                    checked={showRemoved}
                    onChange={(event) => setShowRemoved(event.target.checked)}
                    className="h-4 w-4 accent-zinc-900"
                  />
                  Show removed ({removedCount})
                </label>
              ) : null}
            </div>
          </div>

          <LinesGrid
            lines={visibleLines}
            selectedLineId={selectedLineId}
            checkedIds={checked}
            onSelect={onSelect}
            onToggleChecked={onToggleChecked}
            onEdit={onEdit}
            onRemove={onRemove}
            onClearFlags={onClearFlags}
            onSetCustom={onSetCustom}
            onLink={onLink}
          />

          <AddLineRow requestId={request.id} run={run} />
        </section>
      </main>

      {linkLine ? (
        <LinkItemDialog
          line={linkLine}
          onPick={(catalogItemId) => run(() => linkLineToItemAction(linkLine.id, catalogItemId))}
          onClose={() => setLinkLine(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add a line by hand (AC-3.2)
// ---------------------------------------------------------------------------

const addInputClass =
  "w-full rounded border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500";

function blankToNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function AddLineRow({
  requestId,
  run,
}: {
  requestId: string;
  run: (work: () => Promise<ActionOutcome>) => Promise<string | null>;
}) {
  const [pending, startAdd] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const description = blankToNull(data.get("description"));
    if (description === null) {
      setError("Description is required.");
      return;
    }
    const qtyText = blankToNull(data.get("qty"));
    const qty = qtyText === null ? null : Number(qtyText);
    if (qty !== null && (!Number.isFinite(qty) || qty <= 0)) {
      setError("Quantity must be a positive number, or blank.");
      return;
    }
    const unitText = blankToNull(data.get("unit"));
    const unit = lineUnitValues.find((value) => value === unitText) ?? null;

    setError(null);
    startAdd(async () => {
      const message = await run(() =>
        addLineAction(requestId, {
          description,
          qty,
          unit,
          length_text: blankToNull(data.get("length_text")),
          grade_spec: blankToNull(data.get("grade_spec")),
          delivery_notes: blankToNull(data.get("delivery_notes")),
        }),
      );
      if (message !== null) setError(message);
      else setFormKey((k) => k + 1);
    });
  }

  return (
    <form key={formKey} onSubmit={handleSubmit} className="rounded border border-zinc-200 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-zinc-600">
          Add a line
          <input
            type="text"
            name="description"
            required
            placeholder="Description (shop language is fine)"
            spellCheck={false}
            className={addInputClass}
          />
        </label>
        <label className="flex w-20 flex-col gap-1 text-xs text-zinc-600">
          Qty
          <input type="text" name="qty" inputMode="decimal" className={`${addInputClass} text-right`} />
        </label>
        <label className="flex w-24 flex-col gap-1 text-xs text-zinc-600">
          Unit
          <select name="unit" defaultValue="" className={addInputClass}>
            <option value="">-</option>
            {lineUnitValues.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-28 flex-col gap-1 text-xs text-zinc-600">
          Length
          <input type="text" name="length_text" placeholder="40'" className={addInputClass} />
        </label>
        <label className="flex w-28 flex-col gap-1 text-xs text-zinc-600">
          Grade
          <input type="text" name="grade_spec" className={addInputClass} />
        </label>
        <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs text-zinc-600">
          Notes
          <input type="text" name="delivery_notes" className={addInputClass} />
        </label>
        <button type="submit" disabled={pending} className={secondaryButton}>
          {pending ? "Adding..." : "Add line"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </form>
  );
}

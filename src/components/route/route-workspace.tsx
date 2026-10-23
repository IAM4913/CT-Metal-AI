"use client";

// The Route tab (PRD FR-6): one block per request line with its suggested
// branches, and the consolidated recipient list for the whole request on the
// right. Every checkbox change calls setLineBranchesAction at once; the value
// shown is optimistic for the length of the transition (action plus refresh),
// then it is the database row again. "Generate drafts" marks the request
// rfqs_drafted and moves on to the RFQs tab, where the drafts already exist
// (the lib creates one per branch as lines are routed). A superseded revision
// (supersededBy set, AC-8.4) is shown read-only: the lib refuses its writes.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { markRequestDraftedAction, setLineBranchesAction } from "@/app/(app)/requests/[id]/actions";
import { BranchPicker, type RouteSuggestion } from "@/components/route/branch-picker";
import type { LineUnit, MaterialCategory, RequestStatus } from "@/lib/db/enums";
import { consolidateRecipients, linesForBranch, type BranchForRouting } from "@/lib/routing/match";

export type RouteBranch = BranchForRouting;

export type RouteLine = {
  id: string;
  line_no: number;
  description: string;
  category: MaterialCategory | null;
  qty: number | null;
  unit: LineUnit | null;
  /** Ranked by suggestBranchesForLine on the server; empty when the line has no category or no branch carries it. */
  suggestions: RouteSuggestion[];
  /** Branches this line is routed to, from the current revision's rfq_lines. */
  selected_branch_ids: string[];
  /** Branches whose RFQ for this line is already sent; shown checked and locked. */
  locked_branch_ids: string[];
};

export type RouteWorkspaceProps = {
  request: { id: string; status: RequestStatus; revision: number };
  lines: RouteLine[];
  branches: RouteBranch[];
  /** The newer revision's id when this one is superseded; routing is then read-only. */
  supersededBy: string | null;
};

type ActionOutcome = { ok: true; redirectTo?: string | null } | { ok: false; error: string };

type LineUpdate = { lineId: string; branchIds: string[] };

const primaryButton =
  "rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400";
const secondaryButton =
  "rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

/** Statuses in which the request has not been confirmed yet (markRequestDrafted only flips a reviewed request). */
const BEFORE_REVIEW: ReadonlySet<RequestStatus> = new Set<RequestStatus>(["new", "parsing", "needs_review"]);

function applyUpdate(lines: RouteLine[], update: LineUpdate): RouteLine[] {
  return lines.map((line) => (line.id === update.lineId ? { ...line, selected_branch_ids: update.branchIds } : line));
}

async function runAction(work: () => Promise<ActionOutcome>): Promise<string | null> {
  try {
    const result = await work();
    return result.ok ? null : result.error;
  } catch (error) {
    console.error("[route] action failed", error);
    return "The request did not reach the server. Try again.";
  }
}

export function RouteWorkspace({ request, lines, branches, supersededBy }: RouteWorkspaceProps) {
  const router = useRouter();
  const readOnly = supersededBy !== null;
  const [pending, startTransition] = useTransition();
  // Both optimistic values revert to the props once the transition settles,
  // and router.refresh() inside the transition keeps it open until the new rows
  // have rendered, so there is no flash of the old selection in between.
  const [shownLines, applyOptimistic] = useOptimistic(lines, applyUpdate);
  const [savingLineIds, markSaving] = useOptimistic<string[], string>([], (current, lineId) => [...current, lineId]);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [banner, setBanner] = useState<string | null>(null);

  const perLine = shownLines.map((line) => ({ lineId: line.id, branchIds: line.selected_branch_ids }));
  const recipients = consolidateRecipients(perLine, branches);

  function setBranches(lineId: string, branchIds: string[]) {
    setBanner(null);
    startTransition(async () => {
      applyOptimistic({ lineId, branchIds });
      markSaving(lineId);
      const message = await runAction(() => setLineBranchesAction(request.id, lineId, branchIds));
      setErrors((current) => ({ ...current, [lineId]: message }));
      if (message === null) router.refresh();
    });
  }

  function removeFromAll(branchId: string) {
    const affected = shownLines
      .filter((line) => line.selected_branch_ids.includes(branchId) && !line.locked_branch_ids.includes(branchId))
      .map((line) => ({ lineId: line.id, branchIds: line.selected_branch_ids.filter((id) => id !== branchId) }));
    if (affected.length === 0) return;
    setBanner(null);
    startTransition(async () => {
      for (const update of affected) {
        applyOptimistic(update);
        markSaving(update.lineId);
      }
      let failure: string | null = null;
      for (const update of affected) {
        const message = await runAction(() => setLineBranchesAction(request.id, update.lineId, update.branchIds));
        if (message !== null) {
          failure = message;
          break;
        }
      }
      if (failure !== null) setBanner(failure);
      router.refresh();
    });
  }

  function generateDrafts() {
    setBanner(null);
    startTransition(async () => {
      let result: ActionOutcome;
      try {
        result = await markRequestDraftedAction(request.id);
      } catch (error) {
        console.error("[route] action failed", error);
        setBanner("The request did not reach the server. Try again.");
        return;
      }
      if (!result.ok) {
        setBanner(result.error);
        return;
      }
      // The action names the RFQs tab; fall back to it when the result carries no redirect.
      router.push(result.redirectTo || `/requests/${request.id}/rfqs`);
    });
  }

  const lockedEverywhere = (branchId: string) =>
    shownLines
      .filter((line) => line.selected_branch_ids.includes(branchId))
      .every((line) => line.locked_branch_ids.includes(branchId));

  return (
    <div className="flex flex-col gap-6">
      {banner ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {banner}
        </p>
      ) : null}
      {readOnly ? (
        <p role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Read-only. This revision has been superseded; route the lines on{" "}
          <Link href={`/requests/${supersededBy}/route`} className="font-medium underline hover:text-amber-700">
            the newer revision
          </Link>
          .
        </p>
      ) : null}

      <main className="grid gap-8 lg:grid-cols-[3fr_2fr]">
        <section aria-labelledby="route-lines-heading" className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 id="route-lines-heading" className="text-lg font-semibold">
              Lines
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Suggested branches carry the line&rsquo;s category, preferred first, then by past buys of that category.
              {readOnly ? " This is how the lines were routed." : " Check a branch to route the line to it; every change is saved at once."}
            </p>
          </div>

          {shownLines.length === 0 ? (
            <p className="rounded border border-zinc-200 px-3 py-6 text-center text-sm text-zinc-500">
              No lines to route. Parse or add lines on the Review tab first.
            </p>
          ) : (
            <ul className="flex flex-col gap-4">
              {shownLines.map((line) => (
                <li key={line.id} className="rounded border border-zinc-200 p-4">
                  <LineHeader line={line} />
                  <div className="mt-3">
                    <BranchPicker
                      lineNo={line.line_no}
                      branches={branches}
                      suggestions={line.suggestions}
                      selectedBranchIds={line.selected_branch_ids}
                      lockedBranchIds={line.locked_branch_ids}
                      saving={savingLineIds.includes(line.id)}
                      readOnly={readOnly}
                      error={errors[line.id] ?? null}
                      onChange={(branchIds) => setBranches(line.id, branchIds)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside aria-labelledby="recipients-heading" className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
          <div>
            <h2 id="recipients-heading" className="text-lg font-semibold">
              Recipients
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              One RFQ per branch, with only the lines routed to it.
            </p>
          </div>

          {recipients.length === 0 ? (
            <p className="rounded border border-zinc-200 px-3 py-6 text-center text-sm text-zinc-500">
              No branches picked yet.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 text-sm">
              {recipients.map((branch) => {
                const count = linesForBranch(perLine, branch.branch_id).length;
                const locked = lockedEverywhere(branch.branch_id);
                return (
                  <li key={branch.branch_id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-zinc-900">
                        {branch.vendor_name} <span className="font-normal text-zinc-600">{branch.branch_name}</span>
                      </div>
                      <div className="text-xs text-zinc-500">
                        {count} {count === 1 ? "line" : "lines"}
                        {" / "}
                        {branch.primary_contact_email ?? <span className="text-amber-800">no primary contact</span>}
                      </div>
                    </div>
                    {readOnly ? null : (
                      <button
                        type="button"
                        onClick={() => removeFromAll(branch.branch_id)}
                        disabled={pending || locked}
                        title={locked ? "This branch's RFQ is already sent" : "Take this branch off every line"}
                        className={secondaryButton}
                      >
                        Remove from all
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-col gap-2 rounded border border-zinc-200 bg-zinc-50 px-4 py-3">
            <button
              type="button"
              onClick={generateDrafts}
              disabled={pending || recipients.length === 0 || readOnly}
              className={primaryButton}
              title={readOnly ? "This revision has been superseded" : undefined}
            >
              {pending ? "Working..." : "Generate drafts"}
            </button>
            <p className="text-xs text-zinc-600">
              Opens the RFQs tab with one editable draft per branch. Nothing is sent from here.
            </p>
            {!readOnly && BEFORE_REVIEW.has(request.status) ? (
              <p className="text-xs text-amber-800">
                The request is not confirmed yet. Drafts can be prepared now; confirm it on the Review tab before
                sending.
              </p>
            ) : null}
          </div>
        </aside>
      </main>
    </div>
  );
}

function LineHeader({ line }: { line: RouteLine }) {
  const qty = line.qty !== null ? `${line.qty}${line.unit ? ` ${line.unit}` : ""}` : null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Line {line.line_no}</span>
      <span className="font-medium text-zinc-900">{line.description}</span>
      <span className="text-xs text-zinc-500">
        {line.category ? line.category.replace(/_/g, " ") : "no category"}
        {qty ? ` / ${qty}` : ""}
      </span>
    </div>
  );
}

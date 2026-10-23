"use client";

// Branch checkboxes for one request line (PRD AC-6.1 to AC-6.3). The ranked
// suggestions come from suggestBranchesForLine on the server; this component
// only renders them, adds the branches the broker picked by hand, and offers
// every other branch of the broker in a select. Each change hands the full new
// set of branch ids to the parent, which calls the server action; the parent
// also owns the optimistic value, the saving flag, and the error text.
//
// A branch whose RFQ for this line is already sent is shown checked and locked:
// the lib never touches a sent RFQ, so unchecking it here would be a lie.

import { useId, type ReactNode } from "react";
import { compareBranchNames, type BranchForRouting } from "@/lib/routing/match";

export type RouteSuggestion = { branch_id: string; past_buys: number };

export type BranchPickerProps = {
  lineNo: number;
  branches: BranchForRouting[];
  suggestions: RouteSuggestion[];
  selectedBranchIds: string[];
  lockedBranchIds: string[];
  saving: boolean;
  /** Show the routing without letting it change (a superseded revision). */
  readOnly?: boolean;
  error: string | null;
  onChange: (branchIds: string[]) => void;
};

type PickerRow = {
  branch: BranchForRouting;
  pastBuys: number;
  suggested: boolean;
  checked: boolean;
  locked: boolean;
};

/**
 * The rows to show: the ranked suggestions first, then any selected branch
 * that was not suggested (added by hand), by vendor and branch name.
 */
export function pickerRows(
  branches: BranchForRouting[],
  suggestions: RouteSuggestion[],
  selectedBranchIds: string[],
  lockedBranchIds: string[],
): PickerRow[] {
  const byId = new Map(branches.map((branch) => [branch.branch_id, branch]));
  const selected = new Set(selectedBranchIds);
  const locked = new Set(lockedBranchIds);
  const rows: PickerRow[] = [];
  const shown = new Set<string>();

  for (const suggestion of suggestions) {
    const branch = byId.get(suggestion.branch_id);
    if (!branch || shown.has(branch.branch_id)) continue;
    shown.add(branch.branch_id);
    rows.push({
      branch,
      pastBuys: suggestion.past_buys,
      suggested: true,
      checked: selected.has(branch.branch_id),
      locked: locked.has(branch.branch_id),
    });
  }

  const added = selectedBranchIds
    .filter((id) => !shown.has(id))
    .map((id) => byId.get(id))
    .filter((branch): branch is BranchForRouting => branch !== undefined)
    .sort(compareBranchNames);
  for (const branch of added) {
    shown.add(branch.branch_id);
    rows.push({ branch, pastBuys: 0, suggested: false, checked: true, locked: locked.has(branch.branch_id) });
  }

  return rows;
}

export function BranchPicker({
  lineNo,
  branches,
  suggestions,
  selectedBranchIds,
  lockedBranchIds,
  saving,
  readOnly = false,
  error,
  onChange,
}: BranchPickerProps) {
  const selectId = useId();
  const rows = pickerRows(branches, suggestions, selectedBranchIds, lockedBranchIds);
  const shown = new Set(rows.map((row) => row.branch.branch_id));
  const others = branches.filter((branch) => !shown.has(branch.branch_id)).sort(compareBranchNames);

  function toggle(branchId: string, checked: boolean) {
    const next = new Set(selectedBranchIds);
    if (checked) next.add(branchId);
    else next.delete(branchId);
    // Locked branches stay whatever the checkbox says; they are disabled anyway.
    for (const id of lockedBranchIds) next.add(id);
    onChange([...next]);
  }

  function add(branchId: string) {
    if (branchId === "" || selectedBranchIds.includes(branchId)) return;
    onChange([...selectedBranchIds, branchId]);
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {readOnly ? "No suggested vendors, and the line was not routed." : "No suggested vendors. Pick a branch below to route this line by hand."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.branch.branch_id}>
              <label
                className={`flex flex-wrap items-center gap-2 text-sm ${row.locked ? "text-zinc-500" : "text-zinc-800"}`}
              >
                <input
                  type="checkbox"
                  checked={row.checked}
                  disabled={saving || row.locked || readOnly}
                  onChange={(event) => toggle(row.branch.branch_id, event.target.checked)}
                  aria-label={`Line ${lineNo}: route to ${row.branch.vendor_name}, ${row.branch.branch_name}`}
                  className="h-4 w-4 accent-zinc-900"
                />
                <span className="font-medium">{row.branch.vendor_name}</span>
                <span className="text-zinc-600">{row.branch.branch_name}</span>
                {row.branch.preferred ? <Badge tone="emerald">preferred</Badge> : null}
                {row.pastBuys > 0 ? (
                  <Badge tone="sky">
                    {row.pastBuys} past {row.pastBuys === 1 ? "buy" : "buys"}
                  </Badge>
                ) : null}
                {!row.suggested ? <Badge tone="zinc">added by hand</Badge> : null}
                {row.locked ? <Badge tone="indigo">sent</Badge> : null}
                {row.branch.primary_contact_email === null ? <Badge tone="amber">no primary contact</Badge> : null}
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={selectId} className="text-xs text-zinc-600">
          Add another branch
        </label>
        <select
          id={selectId}
          value=""
          disabled={saving || others.length === 0 || readOnly}
          onChange={(event) => add(event.target.value)}
          className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50 disabled:text-zinc-400"
        >
          <option value="">{others.length === 0 ? "Every branch is listed" : "Pick a branch"}</option>
          {others.map((branch) => (
            <option key={branch.branch_id} value={branch.branch_id}>
              {branch.vendor_name}, {branch.branch_name}
            </option>
          ))}
        </select>
        {saving ? (
          <span className="text-xs text-zinc-500" role="status">
            Saving...
          </span>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const BADGE_TONES = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  sky: "border-sky-200 bg-sky-50 text-sky-800",
  zinc: "border-zinc-200 bg-zinc-100 text-zinc-700",
  indigo: "border-indigo-200 bg-indigo-50 text-indigo-800",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
} as const;

function Badge({ tone, children }: { tone: keyof typeof BADGE_TONES; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  );
}

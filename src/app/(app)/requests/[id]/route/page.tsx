// Route tab (PRD FR-6): suggested branches per line and the consolidated
// recipient list for the request.
//
// Server component: loads the routing context (lines, the broker's branches
// with their capabilities and primary contact, purchase history per branch and
// category, and the current revision's RFQ drafts), ranks the branches for
// each line with the pure matcher, and hands plain serializable props to the
// client workspace. The [id] layout has already returned 404 for an unknown id.

import { RouteWorkspace, type RouteLine } from "@/components/route/route-workspace";
import { suggestBranchesForLine } from "@/lib/routing/match";
import { loadRequestWorkspace } from "@/lib/server/requests";
import { loadRoutingContext, SENT_RFQ_STATUSES } from "@/lib/server/routing";
import { requireBroker } from "@/lib/server/session";

type RoutePageProps = {
  params: Promise<{ id: string }>;
};

export default async function RoutePage({ params }: RoutePageProps) {
  const { id } = await params;
  const session = await requireBroker();
  // The cached workspace (already loaded by the [id] layout) says whether a newer revision exists.
  const [{ request, lines, branches, history, drafts, rfqLines }, workspace] = await Promise.all([
    loadRoutingContext(session, id),
    loadRequestWorkspace(id),
  ]);

  // Which branches each line is routed to today, and which of those RFQs have
  // already gone out, answered or not (the lib never touches a sent RFQ, so
  // the picker locks them).
  const rfqById = new Map(drafts.map((rfq) => [rfq.id, rfq]));
  const selectedByLine = new Map<string, Set<string>>();
  const lockedByLine = new Map<string, Set<string>>();
  for (const rfqLine of rfqLines) {
    const rfq = rfqById.get(rfqLine.rfq_id);
    if (!rfq) continue;
    addTo(selectedByLine, rfqLine.request_line_id, rfq.branch_id);
    if (SENT_RFQ_STATUSES.includes(rfq.status)) addTo(lockedByLine, rfqLine.request_line_id, rfq.branch_id);
  }

  // Past purchases of a category from a branch, for the "n past buys" badge.
  const pastBuys = new Map<string, number>();
  for (const row of history) pastBuys.set(`${row.branch_id}:${row.category}`, row.count);

  const routeLines: RouteLine[] = lines.map((line) => ({
    id: line.id,
    line_no: line.line_no,
    description: line.description,
    category: line.category,
    qty: line.qty,
    unit: line.unit,
    suggestions: suggestBranchesForLine(line.category, branches, history).map((branch) => ({
      branch_id: branch.branch_id,
      past_buys: line.category === null ? 0 : (pastBuys.get(`${branch.branch_id}:${line.category}`) ?? 0),
    })),
    selected_branch_ids: [...(selectedByLine.get(line.id) ?? [])],
    locked_branch_ids: [...(lockedByLine.get(line.id) ?? [])],
  }));

  return (
    <RouteWorkspace
      request={{ id: request.id, status: request.status, revision: request.revision }}
      lines={routeLines}
      branches={branches}
      supersededBy={workspace?.childRequestId ?? null}
    />
  );
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

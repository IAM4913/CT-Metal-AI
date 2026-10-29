// Compare tab (PRD FR-10, FR-11; section 8): offers side by side per request
// line, exact vs alternate, unfilled balances, unknowns, the early-pay
// scenario, selections with splits, and Confirm purchase.
//
// Server component: the [id] layout has already returned 404 for an unknown
// id. This page loads the comparison model through the RLS client
// (loadComparison in src/lib/server/compare.ts computes every number in pure
// functions from src/lib/compare) and hands plain serializable props (strings,
// numbers, booleans, null, arrays, and { value } | { reason } cost results) to
// the client workspace. Nothing from the admin client reaches this file.

import { notFound } from "next/navigation";
import { CompareWorkspace } from "@/components/compare/compare-workspace";
import { loadComparison } from "@/lib/server/compare";
import { loadRequestWorkspace } from "@/lib/server/requests";
import { requireBroker } from "@/lib/server/session";

type ComparePageProps = {
  params: Promise<{ id: string }>;
};

export default async function ComparePage({ params }: ComparePageProps) {
  const { id } = await params;
  const [workspace, session] = await Promise.all([loadRequestWorkspace(id), requireBroker()]);
  if (!workspace) notFound();

  const model = await loadComparison(session, workspace.request.id);

  return (
    <CompareWorkspace
      request={{ id: workspace.request.id, status: workspace.request.status, revision: workspace.request.revision }}
      model={model}
      supersededBy={workspace.childRequestId}
    />
  );
}

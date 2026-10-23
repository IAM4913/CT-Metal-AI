// RFQs tab (PRD FR-7, FR-8): one card per RFQ for the current revision, with
// edit, regenerate, send all, and retry.
//
// Server component: loads the routing context (which already carries the
// revision's rfqs, their rfq_lines, the non-removed request lines, and the
// branches with vendor names), joins them into plain serializable cards sorted
// by vendor then branch, and hands them to the client workspace. The [id]
// layout has already returned 404 for an unknown id.
//
// Each editable card also carries body_stale: whether the stored body differs
// from what the current lines would generate (the broker edited it by hand, or
// a line changed under a hand-edited body and syncDraftsForLine left the text
// alone). The card then points at Regenerate body.

import type { RfqCardData } from "@/components/rfqs/rfq-card";
import { RfqsWorkspace } from "@/components/rfqs/rfqs-workspace";
import { compareText } from "@/lib/routing/match";
import { loadRequestWorkspace } from "@/lib/server/requests";
import { EDITABLE_RFQ_STATUSES, generatedDraftText, loadRoutingContext, sameText } from "@/lib/server/routing";
import { requireBroker } from "@/lib/server/session";

type RfqsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RfqsPage({ params }: RfqsPageProps) {
  const { id } = await params;
  const session = await requireBroker();
  // The cached workspace (already loaded by the [id] layout) says whether a newer revision exists.
  const [{ request, lines, branches, drafts, rfqLines }, workspace] = await Promise.all([
    loadRoutingContext(session, id),
    loadRequestWorkspace(id),
  ]);

  const branchById = new Map(branches.map((branch) => [branch.branch_id, branch]));
  const lineById = new Map(lines.map((line) => [line.id, line]));

  // What each editable draft would say if regenerated now, to flag a body that no longer matches its lines.
  const editable = drafts.filter((rfq) => EDITABLE_RFQ_STATUSES.includes(rfq.status));
  const generated = new Map(
    await Promise.all(editable.map(async (rfq) => [rfq.id, await generatedDraftText(session, rfq)] as const)),
  );

  const cards: RfqCardData[] = drafts.map((rfq) => {
    const branch = branchById.get(rfq.branch_id);
    const cardLines = rfqLines
      .filter((rfqLine) => rfqLine.rfq_id === rfq.id)
      .map((rfqLine) => lineById.get(rfqLine.request_line_id))
      .filter((line): line is NonNullable<typeof line> => line !== undefined)
      .sort((a, b) => a.line_no - b.line_no)
      .map((line) => ({ id: line.id, line_no: line.line_no, description: line.description }));
    return {
      id: rfq.id,
      branch_id: rfq.branch_id,
      vendor_name: branch?.vendor_name ?? "Unknown vendor",
      branch_name: branch?.branch_name ?? "Unknown branch",
      status: rfq.status,
      to_emails: rfq.to_emails,
      cc_emails: rfq.cc_emails,
      subject: rfq.subject,
      body_text: rfq.body_text,
      include_customer_name: rfq.include_customer_name,
      sent_at: rfq.sent_at,
      provider_message_id: rfq.provider_message_id,
      last_error: rfq.last_error,
      lines: cardLines,
      body_stale: generated.has(rfq.id) ? !sameText(rfq.body_text, generated.get(rfq.id)!.body_text) : false,
    };
  });

  // Same order as the Route tab's recipient list (compareBranchNames): vendor, then branch, case-insensitive.
  cards.sort((a, b) => compareText(a.vendor_name, b.vendor_name) || compareText(a.branch_name, b.branch_name));

  return (
    <RfqsWorkspace
      request={{ id: request.id, status: request.status, revision: request.revision }}
      rfqs={cards}
      supersededBy={workspace?.childRequestId ?? null}
    />
  );
}

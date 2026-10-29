// Read side of the work queue (PRD FR-12, the home screen). Loads every
// request of the broker with its customer name, its count of live lines, and
// the RFQs of its current revision with vendor and branch names, then hands the
// plain rows to groupForQueue (src/lib/queue/group.ts), which does the sorting.
//
// Revisions (AC-8.4): a request edited after its RFQs went out is copied to a
// new revision whose parent_request_id points back at it. Only the newest
// revision of a family is work to do, so any request that appears as another's
// parent is left off the queue. Its RFQs and replies stay reachable from the
// newer revision's header and from the history page.
//
// Every query runs through session.supabase (the RLS client); the broker_id
// filters are belt and braces on top of the policies. Rows are joined in code,
// the pattern the other loaders use, so the page does not depend on PostgREST
// resolving the composite foreign keys.

import type { Tables } from "@/lib/db/client";
import { groupForQueue, type QueueCard, type QueueGroup, type QueueRequest, type QueueRfq } from "@/lib/queue/group";
import type { BrokerSession } from "@/lib/server/session";

type RequestRow = Pick<Tables<"requests">, "id" | "subject" | "customer_id" | "status" | "revision" | "received_at" | "parent_request_id">;
type RfqRow = Pick<Tables<"rfqs">, "id" | "request_id" | "branch_id" | "revision" | "status" | "sent_at">;

/**
 * The ids of requests that have a child revision: every parent_request_id in
 * the set. Those are superseded and hidden from the queue.
 */
export function supersededIds(requests: ReadonlyArray<Pick<RequestRow, "parent_request_id">>): Set<string> {
  const ids = new Set<string>();
  for (const request of requests) {
    if (request.parent_request_id !== null) ids.add(request.parent_request_id);
  }
  return ids;
}

/** Non-removed lines per request id. */
export function countLiveLines(lines: ReadonlyArray<Pick<Tables<"request_lines">, "request_id" | "status">>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.status === "removed") continue;
    counts.set(line.request_id, (counts.get(line.request_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The RFQs that belong to each request's current revision, with names. An RFQ
 * from an older revision of the same row (none exist today, since a revision
 * is a new request row) would be dropped here.
 */
export function rfqsByRequest(
  requests: ReadonlyArray<Pick<RequestRow, "id" | "revision">>,
  rfqs: readonly RfqRow[],
  names: ReadonlyMap<string, { branch: string; vendor: string }>,
): Map<string, QueueRfq[]> {
  const revisionById = new Map(requests.map((request) => [request.id, request.revision]));
  const byRequest = new Map<string, QueueRfq[]>();
  for (const rfq of rfqs) {
    const revision = revisionById.get(rfq.request_id);
    if (revision === undefined || rfq.revision !== revision) continue;
    const name = names.get(rfq.branch_id);
    const list = byRequest.get(rfq.request_id) ?? [];
    list.push({
      id: rfq.id,
      branch_name: name?.branch ?? "Unknown branch",
      vendor_name: name?.vendor ?? "Unknown vendor",
      status: rfq.status,
      sent_at: rfq.sent_at,
    });
    byRequest.set(rfq.request_id, list);
  }
  return byRequest;
}

/** Everything the home screen shows, grouped and sorted. `now` defaults to the render time. */
export async function loadQueue(session: BrokerSession, now: Date = new Date()): Promise<Record<QueueGroup, QueueCard[]>> {
  const { supabase, brokerId } = session;

  const requestsResult = await supabase
    .from("requests")
    .select("id, subject, customer_id, status, revision, received_at, parent_request_id")
    .eq("broker_id", brokerId)
    .order("received_at", { ascending: false });
  if (requestsResult.error) {
    throw new Error(`Could not read requests: ${requestsResult.error.message}`);
  }
  const allRequests: RequestRow[] = requestsResult.data ?? [];
  const hidden = supersededIds(allRequests);
  const requests = allRequests.filter((request) => !hidden.has(request.id));
  if (requests.length === 0) return groupForQueue([], now);

  const requestIds = requests.map((request) => request.id);
  const customerIds = unique(requests.map((request) => request.customer_id));

  const [customersResult, linesResult, rfqsResult] = await Promise.all([
    customerIds.length === 0
      ? Promise.resolve({ data: [] as Array<Pick<Tables<"customers">, "id" | "name">>, error: null })
      : supabase.from("customers").select("id, name").eq("broker_id", brokerId).in("id", customerIds),
    supabase.from("request_lines").select("request_id, status").eq("broker_id", brokerId).in("request_id", requestIds),
    supabase
      .from("rfqs")
      .select("id, request_id, branch_id, revision, status, sent_at")
      .eq("broker_id", brokerId)
      .in("request_id", requestIds),
  ]);
  if (customersResult.error) {
    throw new Error(`Could not read customers: ${customersResult.error.message}`);
  }
  if (linesResult.error) {
    throw new Error(`Could not read request lines: ${linesResult.error.message}`);
  }
  if (rfqsResult.error) {
    throw new Error(`Could not read RFQs: ${rfqsResult.error.message}`);
  }

  const customerName = new Map((customersResult.data ?? []).map((customer) => [customer.id, customer.name]));
  const lineCounts = countLiveLines(linesResult.data ?? []);
  const rfqRows: RfqRow[] = rfqsResult.data ?? [];
  const names = await loadBranchNames(
    session,
    rfqRows.map((rfq) => rfq.branch_id),
  );
  const rfqs = rfqsByRequest(requests, rfqRows, names);

  const queueRequests: QueueRequest[] = requests.map((request) => ({
    id: request.id,
    subject: request.subject.trim() === "" ? null : request.subject,
    customer_name: request.customer_id === null ? null : (customerName.get(request.customer_id) ?? null),
    status: request.status,
    revision: request.revision,
    received_at: request.received_at,
    line_count: lineCounts.get(request.id) ?? 0,
    rfqs: rfqs.get(request.id) ?? [],
  }));

  return groupForQueue(queueRequests, now);
}

/** Branch and vendor names by branch id, in two reads joined in code. */
async function loadBranchNames(session: BrokerSession, branchIds: string[]): Promise<Map<string, { branch: string; vendor: string }>> {
  const ids = unique(branchIds);
  if (ids.length === 0) return new Map();
  const { data: branches, error: branchError } = await session.supabase
    .from("vendor_branches")
    .select("id, name, vendor_id")
    .eq("broker_id", session.brokerId)
    .in("id", ids);
  if (branchError) {
    throw new Error(`Could not read vendor branches: ${branchError.message}`);
  }
  const vendorIds = unique((branches ?? []).map((branch) => branch.vendor_id));
  const { data: vendors, error: vendorError } =
    vendorIds.length === 0
      ? { data: [] as Array<Pick<Tables<"vendors">, "id" | "name">>, error: null }
      : await session.supabase.from("vendors").select("id, name").eq("broker_id", session.brokerId).in("id", vendorIds);
  if (vendorError) {
    throw new Error(`Could not read vendors: ${vendorError.message}`);
  }
  const vendorName = new Map((vendors ?? []).map((vendor) => [vendor.id, vendor.name]));
  return new Map(
    (branches ?? []).map((branch) => [branch.id, { branch: branch.name, vendor: vendorName.get(branch.vendor_id) ?? "Unknown vendor" }]),
  );
}

function unique(values: ReadonlyArray<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => value !== null)));
}

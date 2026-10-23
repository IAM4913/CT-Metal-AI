// Request revisions, the chain side (PRD AC-8.4, section 10).
//
// createRevision() in review.ts copies a request whose RFQs went out into a
// new request (revision + 1, parent_request_id set). Once that child exists the
// old revision is superseded: its lines, routing, and drafts are history, and
// every edit, routing change, and send belongs on the newest revision. Without
// this guard a second edit on the old revision would fork a second child with
// the same revision number, and a leftover draft on the old revision could be
// sent with the pre-edit lines.
//
// findChildRevision() is the lookup, newestRevision() the pure pick (highest
// revision, then newest created_at, so two siblings never tie), and
// assertNotSuperseded() the guard the write paths call. SupersededError carries
// the child's URL so a server action can hand the client a redirect along with
// the message.

import type { BrokerSession } from "@/lib/server/session";

export type RevisionRow = { id: string; revision: number; created_at: string };

/** The newest of several revisions: highest revision number, then the latest created_at. Null for none. */
export function newestRevision<T extends RevisionRow>(rows: T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (best === null || row.revision > best.revision || (row.revision === best.revision && row.created_at > best.created_at)) {
      best = row;
    }
  }
  return best;
}

/** The message a superseded revision answers every write with. */
export function supersededMessage(child: Pick<RevisionRow, "revision">): string {
  return `This revision has been superseded by revision ${child.revision}. Make the change there instead.`;
}

export class SupersededError extends Error {
  readonly childRequestId: string;
  readonly redirectTo: string;

  constructor(child: Pick<RevisionRow, "id" | "revision">) {
    super(supersededMessage(child));
    this.name = "SupersededError";
    this.childRequestId = child.id;
    this.redirectTo = `/requests/${child.id}`;
  }
}

/** The newest request whose parent_request_id is this request, or null when none exists. */
export async function findChildRevision(session: BrokerSession, requestId: string): Promise<RevisionRow | null> {
  const { data, error } = await session.supabase
    .from("requests")
    .select("id, revision, created_at")
    .eq("broker_id", session.brokerId)
    .eq("parent_request_id", requestId);
  if (error) {
    throw new Error(`Could not read request revisions: ${error.message}`);
  }
  return newestRevision(data ?? []);
}

/** Throws SupersededError when a newer revision of this request exists. */
export async function assertNotSuperseded(session: BrokerSession, requestId: string): Promise<void> {
  const child = await findChildRevision(session, requestId);
  if (child) throw new SupersededError(child);
}

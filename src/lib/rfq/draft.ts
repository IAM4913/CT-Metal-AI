// Per-branch RFQ drafts (PRD AC-7.1, AC-7.2, AC-7.5, AC-8.2). Pure: the
// server layer loads the rows and writes the result.
//
// One draft per branch, holding only that branch's lines. The recipient is the
// branch's primary contact (or its first contact when none is marked primary),
// so a draft can only ever carry that branch's address. idempotencyKey() is
// the AC-8.2 key: request id, branch id, request revision.
//
// assertRecipientIsolation() is the AC-7.5 check: given every branch's own
// strings (its contact emails and its vendor name), no draft may address
// another branch's contact or mention another branch's vendor by name. It is
// run in tests over generated drafts, and can be run again before a send.

import { rfqBody, rfqSubject, type RfqLineView } from "./templates";

export type DraftInput = {
  request: { id: string; revision: number; subject: string | null; delivery_requirements: string | null };
  customer: { name: string; short_name: string } | null;
  branch: { id: string; name: string; vendor_name: string };
  contacts: Array<{ email: string; name: string; is_primary: boolean }>;
  lines: RfqLineView[];
  includeCustomerName: boolean;
  senderName: string;
  now: Date;
};

export type RfqDraft = {
  branch_id: string;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  body_text: string;
  include_customer_name: boolean;
  idempotency_key: string;
};

/** AC-8.2: "<requestId>:<branchId>:<revision>". */
export function idempotencyKey(requestId: string, branchId: string, revision: number): string {
  return `${requestId}:${branchId}:${revision}`;
}

/** The contact an RFQ goes to: the primary one, else the first one, else none. */
export function pickRecipient<T extends { is_primary: boolean }>(contacts: T[]): T | null {
  return contacts.find((c) => c.is_primary) ?? contacts[0] ?? null;
}

/** "Marcus Reed" -> "Marcus"; blank -> null. */
export function firstName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first === "" ? null : first;
}

function blankToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * One draft for one branch. to = the primary contact's email (or the first
 * contact's when no primary, or none), cc = []. The subject carries the
 * customer's short name per AC-7.2; the body names the customer only when
 * includeCustomerName is on (AC-7.3).
 */
export function buildDraft(input: DraftInput): RfqDraft {
  const recipient = pickRecipient(input.contacts);
  const to = recipient ? [recipient.email] : [];
  const subject = rfqSubject({
    customerShortName: input.customer ? blankToNull(input.customer.short_name) : null,
    itemCount: input.lines.length,
    date: input.now,
  });
  const body = rfqBody({
    contactFirstName: recipient ? firstName(recipient.name) : null,
    lines: input.lines,
    customerName: input.customer ? blankToNull(input.customer.name) : null,
    includeCustomerName: input.includeCustomerName,
    deliveryRequirements: input.request.delivery_requirements,
    senderName: input.senderName,
  });
  return {
    branch_id: input.branch.id,
    to_emails: to,
    cc_emails: [],
    subject,
    body_text: body,
    include_customer_name: input.includeCustomerName,
    idempotency_key: idempotencyKey(input.request.id, input.branch.id, input.request.revision),
  };
}

export function buildDrafts(inputs: DraftInput[]): RfqDraft[] {
  return inputs.map(buildDraft);
}

/**
 * AC-7.5. contactsByBranch maps each branch id to the strings that belong to
 * that branch: its contact emails and its vendor name. A draft leaks when any
 * to or cc address belongs to another branch, or when its body mentions
 * another branch's vendor name (or email). Strings shared with the draft's own
 * branch (two branches of one vendor share the vendor name) are not leaks.
 * Matching is case-insensitive.
 */
export function assertRecipientIsolation(
  drafts: RfqDraft[],
  contactsByBranch: Map<string, string[]>,
): { ok: boolean; leaks: string[] } {
  const leaks: string[] = [];
  for (const draft of drafts) {
    const own = new Set((contactsByBranch.get(draft.branch_id) ?? []).map((s) => s.toLowerCase()));
    const recipients = [...draft.to_emails, ...draft.cc_emails].map((s) => s.trim().toLowerCase());
    const body = draft.body_text.toLowerCase();
    for (const [otherBranchId, strings] of contactsByBranch) {
      if (otherBranchId === draft.branch_id) continue;
      for (const raw of strings) {
        const value = raw.trim().toLowerCase();
        if (value === "" || own.has(value)) continue;
        if (recipients.includes(value)) {
          leaks.push(`RFQ for branch ${draft.branch_id} addresses ${raw}, which belongs to branch ${otherBranchId}`);
        }
        if (body.includes(value)) {
          leaks.push(`RFQ for branch ${draft.branch_id} mentions ${raw}, which belongs to branch ${otherBranchId}`);
        }
      }
    }
  }
  return { ok: leaks.length === 0, leaks };
}

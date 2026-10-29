// Tie an inbound reply to the RFQ it answers from its threading headers
// (PRD AC-9.1: auto-match by In-Reply-To and References when present).
//
// matchReplyToRfq() compares the reply's In-Reply-To, then each References
// entry (closest parent first), against the provider_message_id of the
// request's outbound messages. When no stored id matches, the noop adapter's
// own id form "<anvil-rfq-<rfq uuid>@noop.anvil.local>" is read for the rfq
// uuid it carries (parseNoopRfqId) and matched against rfq_id directly, so a
// reply threaded to a noop send still lands even when the outbound row was
// recorded with a different id. A uuid that names no RFQ of this request (the
// all-zero placeholder in fixtures/replies/quote.pdf.eml, say) is no match.
//
// Pure: no I/O. The caller loads the outbound messages under RLS.

const NOOP_ID = /^<?anvil-rfq-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@noop\.anvil\.local>?$/i;

export type ReplyHeaders = { inReplyTo: string | null; references: string[] };
export type OutboundRef = { rfq_id: string; provider_message_id: string | null };
export type ThreadMatch = { rfqId: string; matchedBy: "thread" };

/** Trim and drop the angle brackets so "<id>" and "id" compare equal. */
export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<+|>+$/g, "").trim();
}

/** The rfq uuid inside a noop provider id ("<anvil-rfq-<uuid>@noop.anvil.local>"), lowercased, or null. */
export function parseNoopRfqId(messageId: string): string | null {
  const match = NOOP_ID.exec(messageId.trim());
  return match ? match[1].toLowerCase() : null;
}

/** The candidate ids in match order: In-Reply-To first, then References from the last (closest) entry back. */
function candidateIds(headers: ReplyHeaders): string[] {
  const ids: string[] = [];
  if (headers.inReplyTo !== null && headers.inReplyTo.trim() !== "") ids.push(headers.inReplyTo);
  for (let i = headers.references.length - 1; i >= 0; i -= 1) {
    const ref = headers.references[i];
    if (typeof ref === "string" && ref.trim() !== "") ids.push(ref);
  }
  return ids;
}

export function matchReplyToRfq(headers: ReplyHeaders, outbound: OutboundRef[]): ThreadMatch | null {
  const candidates = candidateIds(headers);
  if (candidates.length === 0 || outbound.length === 0) return null;

  const byProviderId = new Map<string, string>();
  for (const message of outbound) {
    if (message.provider_message_id === null) continue;
    const key = normalizeMessageId(message.provider_message_id);
    if (key !== "" && !byProviderId.has(key)) byProviderId.set(key, message.rfq_id);
  }
  const rfqIds = new Set(outbound.map((message) => message.rfq_id.toLowerCase()));

  for (const candidate of candidates) {
    const rfqId = byProviderId.get(normalizeMessageId(candidate));
    if (rfqId !== undefined) return { rfqId, matchedBy: "thread" };
  }

  for (const candidate of candidates) {
    const noopRfqId = parseNoopRfqId(candidate);
    if (noopRfqId === null) continue;
    const known = outbound.find((message) => message.rfq_id.toLowerCase() === noopRfqId);
    if (known && rfqIds.has(noopRfqId)) return { rfqId: known.rfq_id, matchedBy: "thread" };
  }

  return null;
}

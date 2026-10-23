// Sending RFQs (PRD AC-8.1, AC-8.2, AC-8.3). Pure orchestration over a set of
// ports; src/lib/server/rfq-send.ts supplies ports backed by Supabase and the
// configured MailAdapter, tests supply in-memory ones.
//
// For each RFQ, in order:
//   already sent (status "sent", or a sent row exists with the same
//   idempotency key)      -> skipped_already_sent, the adapter is not called
//   no recipient          -> markFailed("No recipient"), skipped_no_recipient
//   otherwise             -> adapter.send, markSent, recordOutbound, sent
//   the adapter throws    -> markFailed(error), failed, and the loop goes on
//
// A port that throws (a database write failing after the mail went out) is
// not swallowed: that is an infrastructure fault the caller must see, not a
// per-RFQ send failure. Nothing here decides *whether* to send; the broker's
// click does that (CLAUDE.md: nothing is sent without an explicit action).

import type { MailAdapter, OutboundMessage } from "@/lib/mail/adapter";
import type { RfqStatus } from "@/lib/db/enums";

export type SendableRfq = {
  id: string;
  status: RfqStatus;
  idempotency_key: string;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  body_text: string;
  provider_message_id: string | null;
};

export type SendPorts = {
  adapter: MailAdapter;
  /** The sender address every outbound message carries. */
  from: string;
  findSentByKey(key: string): Promise<{ id: string; provider_message_id: string | null } | null>;
  markSent(rfqId: string, providerMessageId: string, sentAt: Date): Promise<void>;
  markFailed(rfqId: string, error: string): Promise<void>;
  recordOutbound(msg: OutboundMessage, providerMessageId: string, sentAt: Date): Promise<void>;
  now(): Date;
};

export type SendOutcome = {
  rfqId: string;
  result: "sent" | "skipped_already_sent" | "skipped_no_recipient" | "failed";
  providerMessageId?: string;
  error?: string;
};

export const NO_RECIPIENT_ERROR = "No recipient";

/** Addresses with the blanks dropped and whitespace trimmed. */
export function cleanAddresses(addresses: string[]): string[] {
  return addresses.map((a) => a.trim()).filter((a) => a !== "");
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return "Send failed";
}

export async function sendRfqs(rfqs: SendableRfq[], ports: SendPorts): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];

  for (const rfq of rfqs) {
    if (rfq.status === "sent") {
      outcomes.push({
        rfqId: rfq.id,
        result: "skipped_already_sent",
        ...(rfq.provider_message_id ? { providerMessageId: rfq.provider_message_id } : {}),
      });
      continue;
    }

    const existing = await ports.findSentByKey(rfq.idempotency_key);
    if (existing) {
      outcomes.push({
        rfqId: rfq.id,
        result: "skipped_already_sent",
        ...(existing.provider_message_id ? { providerMessageId: existing.provider_message_id } : {}),
      });
      continue;
    }

    const to = cleanAddresses(rfq.to_emails);
    if (to.length === 0) {
      await ports.markFailed(rfq.id, NO_RECIPIENT_ERROR);
      outcomes.push({ rfqId: rfq.id, result: "skipped_no_recipient", error: NO_RECIPIENT_ERROR });
      continue;
    }

    const msg: OutboundMessage = {
      rfqId: rfq.id,
      from: ports.from,
      to,
      cc: cleanAddresses(rfq.cc_emails),
      subject: rfq.subject,
      bodyText: rfq.body_text,
    };

    let providerMessageId: string;
    try {
      providerMessageId = (await ports.adapter.send(msg)).providerMessageId;
    } catch (error) {
      const text = errorText(error);
      await ports.markFailed(rfq.id, text);
      outcomes.push({ rfqId: rfq.id, result: "failed", error: text });
      continue;
    }

    const sentAt = ports.now();
    await ports.markSent(rfq.id, providerMessageId, sentAt);
    await ports.recordOutbound(msg, providerMessageId, sentAt);
    outcomes.push({ rfqId: rfq.id, result: "sent", providerMessageId });
  }

  return outcomes;
}

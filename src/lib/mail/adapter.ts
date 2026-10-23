// Outbound mail boundary (PRD section 12, FR-8). Phase 1 ships only the
// interface and NoopMailAdapter; a real provider (Microsoft Graph or Gmail,
// OPEN) implements the same interface in Phase 2.
//
// getMailAdapter() picks the adapter from MAIL_ADAPTER (default "noop"). Any
// other value throws, so a misconfigured deployment fails on the first send
// instead of silently dropping mail.

import { NoopMailAdapter } from "./noop";

export type OutboundMessage = {
  rfqId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
};

export interface MailAdapter {
  readonly name: string;
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
  // Phase 2 adds fetchNew(since: Date): Promise<InboundMessage[]> for mailbox polling.
}

const DEFAULT_ADAPTER = "noop";

/** The adapter named by MAIL_ADAPTER. Only "noop" exists in Phase 1. */
export function getMailAdapter(): MailAdapter {
  const raw = process.env.MAIL_ADAPTER;
  const name = raw === undefined || raw.trim() === "" ? DEFAULT_ADAPTER : raw.trim();
  if (name === DEFAULT_ADAPTER) return new NoopMailAdapter();
  throw new Error(`Mail adapter ${name} is not available in Phase 1`);
}

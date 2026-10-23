// NoopMailAdapter (PRD AC-8.1): sends nothing and returns a deterministic
// provider message id. The caller (src/lib/rfq/send.ts through the server
// ports) records the full outbound text in `messages`, so the audit trail is
// complete even though no mail leaves the machine.
//
// The id is minted as <anvil-rfq-<rfq uuid>@noop.anvil.local>. The reply
// fixture fixtures/replies/quote.pdf.eml threads to its RFQ through exactly this
// form in In-Reply-To and References, and the Step 6 reply matcher reads it.

import type { MailAdapter, OutboundMessage } from "./adapter";

const NOOP_DOMAIN = "noop.anvil.local";

/** "<anvil-rfq-<rfqId>@noop.anvil.local>", angle brackets included, as a Message-ID header carries it. */
export function noopProviderMessageId(rfqId: string): string {
  return `<anvil-rfq-${rfqId}@${NOOP_DOMAIN}>`;
}

export class NoopMailAdapter implements MailAdapter {
  readonly name = "noop";

  async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    return { providerMessageId: noopProviderMessageId(msg.rfqId) };
  }
}

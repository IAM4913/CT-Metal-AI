import { describe, expect, it } from "vitest";
import type { MailAdapter, OutboundMessage } from "@/lib/mail/adapter";
import { NoopMailAdapter, noopProviderMessageId } from "@/lib/mail/noop";
import { cleanAddresses, NO_RECIPIENT_ERROR, sendRfqs, type SendableRfq, type SendPorts } from "./send";

const REQUEST = "11111111-1111-4111-8111-111111111111";

function rfq(id: string, branch: string, overrides: Partial<SendableRfq> = {}): SendableRfq {
  return {
    id,
    status: "draft",
    idempotency_key: `${REQUEST}:${branch}:1`,
    to_emails: [`${branch}@example.com`],
    cc_emails: [],
    subject: "RFQ: Lone Star, 2 items, Oct 23, 2026",
    body_text: "Hi,\nNeed pricing and availability on the below.\n\n8 pcs W12x26 x 50' A992\n\nLet me know what you can do.\n\nCaleb",
    provider_message_id: null,
    ...overrides,
  };
}

/** A counting wrapper so the tests can assert exactly how often the adapter ran. */
class CountingAdapter implements MailAdapter {
  readonly name = "counting";
  readonly sent: OutboundMessage[] = [];
  constructor(private readonly inner: MailAdapter = new NoopMailAdapter()) {}
  async send(msg: OutboundMessage) {
    this.sent.push(msg);
    return this.inner.send(msg);
  }
}

class FlakyAdapter implements MailAdapter {
  readonly name = "flaky";
  readonly sent: OutboundMessage[] = [];
  constructor(private readonly failFor: Set<string>) {}
  async send(msg: OutboundMessage) {
    if (this.failFor.has(msg.rfqId)) throw new Error(`Provider rejected ${msg.rfqId}`);
    this.sent.push(msg);
    return { providerMessageId: noopProviderMessageId(msg.rfqId) };
  }
}

/** In-memory store standing in for the rfqs and messages tables. */
class MemoryStore {
  readonly rows = new Map<string, SendableRfq & { sent_at: Date | null; last_error: string | null }>();
  readonly messages: Array<{ msg: OutboundMessage; providerMessageId: string; sentAt: Date }> = [];
  readonly failures: Array<{ rfqId: string; error: string }> = [];
  clock = new Date(2026, 9, 23, 10, 0, 0);

  constructor(rfqs: SendableRfq[]) {
    for (const r of rfqs) this.rows.set(r.id, { ...r, sent_at: null, last_error: null });
  }

  /** The rows as the next sendAll would load them. */
  snapshot(): SendableRfq[] {
    return Array.from(this.rows.values()).map((row) => ({
      id: row.id,
      status: row.status,
      idempotency_key: row.idempotency_key,
      to_emails: row.to_emails,
      cc_emails: row.cc_emails,
      subject: row.subject,
      body_text: row.body_text,
      provider_message_id: row.provider_message_id,
    }));
  }

  ports(adapter: MailAdapter): SendPorts {
    return {
      adapter,
      from: "caleb@example.com",
      findSentByKey: async (key) => {
        for (const row of this.rows.values()) {
          if (row.idempotency_key === key && row.status === "sent") {
            return { id: row.id, provider_message_id: row.provider_message_id };
          }
        }
        return null;
      },
      markSent: async (rfqId, providerMessageId, sentAt) => {
        const row = this.rows.get(rfqId);
        if (!row) throw new Error(`no row ${rfqId}`);
        row.status = "sent";
        row.provider_message_id = providerMessageId;
        row.sent_at = sentAt;
        row.last_error = null;
      },
      markFailed: async (rfqId, error) => {
        const row = this.rows.get(rfqId);
        if (!row) throw new Error(`no row ${rfqId}`);
        row.status = "failed";
        row.last_error = error;
        this.failures.push({ rfqId, error });
      },
      recordOutbound: async (msg, providerMessageId, sentAt) => {
        this.messages.push({ msg, providerMessageId, sentAt });
      },
      now: () => this.clock,
    };
  }
}

describe("sendRfqs (AC-8.1, AC-8.2, AC-8.3)", () => {
  it("sends each draft once, marks it sent, and records the outbound message", async () => {
    const store = new MemoryStore([rfq("r1", "delta"), rfq("r2", "morgan")]);
    const adapter = new CountingAdapter();

    const outcomes = await sendRfqs(store.snapshot(), store.ports(adapter));

    expect(outcomes).toEqual([
      { rfqId: "r1", result: "sent", providerMessageId: noopProviderMessageId("r1") },
      { rfqId: "r2", result: "sent", providerMessageId: noopProviderMessageId("r2") },
    ]);
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.sent[0]).toEqual({
      rfqId: "r1",
      from: "caleb@example.com",
      to: ["delta@example.com"],
      cc: [],
      subject: "RFQ: Lone Star, 2 items, Oct 23, 2026",
      bodyText: expect.stringContaining("Let me know what you can do."),
    });
    expect(store.rows.get("r1")).toMatchObject({
      status: "sent",
      provider_message_id: noopProviderMessageId("r1"),
      sent_at: store.clock,
      last_error: null,
    });
    expect(store.messages).toHaveLength(2);
    expect(store.messages[1]).toEqual({
      msg: adapter.sent[1],
      providerMessageId: noopProviderMessageId("r2"),
      sentAt: store.clock,
    });
  });

  it("calling send twice over the same drafts produces exactly one adapter send per rfq (AC-8.2)", async () => {
    const store = new MemoryStore([rfq("r1", "delta"), rfq("r2", "morgan"), rfq("r3", "bull-moose")]);
    const adapter = new CountingAdapter();

    const first = await sendRfqs(store.snapshot(), store.ports(adapter));
    expect(first.every((o) => o.result === "sent")).toBe(true);

    // Second pass: the rows now carry status "sent" as markSent left them.
    const second = await sendRfqs(store.snapshot(), store.ports(adapter));
    expect(second).toEqual([
      { rfqId: "r1", result: "skipped_already_sent", providerMessageId: noopProviderMessageId("r1") },
      { rfqId: "r2", result: "skipped_already_sent", providerMessageId: noopProviderMessageId("r2") },
      { rfqId: "r3", result: "skipped_already_sent", providerMessageId: noopProviderMessageId("r3") },
    ]);
    expect(adapter.sent).toHaveLength(3);
    expect(store.messages).toHaveLength(3);
  });

  it("skips a draft whose idempotency key already has a sent row, even when the draft row itself still says draft", async () => {
    // A stale draft object (loaded before another request marked the row sent)
    // must not send again: findSentByKey answers from the store.
    const store = new MemoryStore([rfq("r1", "delta")]);
    const adapter = new CountingAdapter();
    await sendRfqs(store.snapshot(), store.ports(adapter));

    const stale = [rfq("r1", "delta")]; // status draft, provider id null
    const outcomes = await sendRfqs(stale, store.ports(adapter));
    expect(outcomes).toEqual([{ rfqId: "r1", result: "skipped_already_sent", providerMessageId: noopProviderMessageId("r1") }]);
    expect(adapter.sent).toHaveLength(1);
  });

  it("marks a throwing send failed with the error and still sends the rest (AC-8.3)", async () => {
    const store = new MemoryStore([rfq("r1", "delta"), rfq("r2", "morgan"), rfq("r3", "bull-moose")]);
    const adapter = new FlakyAdapter(new Set(["r2"]));

    const outcomes = await sendRfqs(store.snapshot(), store.ports(adapter));

    expect(outcomes).toEqual([
      { rfqId: "r1", result: "sent", providerMessageId: noopProviderMessageId("r1") },
      { rfqId: "r2", result: "failed", error: "Provider rejected r2" },
      { rfqId: "r3", result: "sent", providerMessageId: noopProviderMessageId("r3") },
    ]);
    expect(store.rows.get("r2")).toMatchObject({ status: "failed", last_error: "Provider rejected r2", provider_message_id: null });
    expect(store.failures).toEqual([{ rfqId: "r2", error: "Provider rejected r2" }]);
    expect(store.messages.map((m) => m.msg.rfqId)).toEqual(["r1", "r3"]);
    expect(adapter.sent.map((m) => m.rfqId)).toEqual(["r1", "r3"]);
  });

  it("a failed rfq is retryable: the next pass sends it and skips the already sent ones", async () => {
    const store = new MemoryStore([rfq("r1", "delta"), rfq("r2", "morgan")]);
    await sendRfqs(store.snapshot(), store.ports(new FlakyAdapter(new Set(["r2"]))));
    expect(store.rows.get("r2")?.status).toBe("failed");

    const retryAdapter = new CountingAdapter();
    const retry = await sendRfqs(store.snapshot(), store.ports(retryAdapter));
    expect(retry).toEqual([
      { rfqId: "r1", result: "skipped_already_sent", providerMessageId: noopProviderMessageId("r1") },
      { rfqId: "r2", result: "sent", providerMessageId: noopProviderMessageId("r2") },
    ]);
    expect(retryAdapter.sent.map((m) => m.rfqId)).toEqual(["r2"]);
    expect(store.rows.get("r2")).toMatchObject({ status: "sent", last_error: null });
  });

  it("never hands an rfq with no recipient to the adapter; it is marked failed with No recipient", async () => {
    const store = new MemoryStore([
      rfq("r1", "delta", { to_emails: [] }),
      rfq("r2", "morgan", { to_emails: ["  ", ""] }),
      rfq("r3", "bull-moose"),
    ]);
    const adapter = new CountingAdapter();

    const outcomes = await sendRfqs(store.snapshot(), store.ports(adapter));

    expect(outcomes).toEqual([
      { rfqId: "r1", result: "skipped_no_recipient", error: NO_RECIPIENT_ERROR },
      { rfqId: "r2", result: "skipped_no_recipient", error: NO_RECIPIENT_ERROR },
      { rfqId: "r3", result: "sent", providerMessageId: noopProviderMessageId("r3") },
    ]);
    expect(adapter.sent.map((m) => m.rfqId)).toEqual(["r3"]);
    expect(store.rows.get("r1")).toMatchObject({ status: "failed", last_error: "No recipient" });
    expect(store.rows.get("r2")).toMatchObject({ status: "failed", last_error: "No recipient" });
    expect(store.messages).toHaveLength(1);
  });

  it("trims and drops blank addresses before sending", async () => {
    const store = new MemoryStore([rfq("r1", "delta", { to_emails: [" marcus@example.com ", ""], cc_emails: ["", " priya@example.com"] })]);
    const adapter = new CountingAdapter();
    await sendRfqs(store.snapshot(), store.ports(adapter));
    expect(adapter.sent[0].to).toEqual(["marcus@example.com"]);
    expect(adapter.sent[0].cc).toEqual(["priya@example.com"]);
    expect(cleanAddresses(["", " a@b.c "])).toEqual(["a@b.c"]);
  });

  it("does nothing for an empty list", async () => {
    const store = new MemoryStore([]);
    const adapter = new CountingAdapter();
    expect(await sendRfqs([], store.ports(adapter))).toEqual([]);
    expect(adapter.sent).toHaveLength(0);
  });

  it("turns a non-Error throw into a failed outcome with a plain message", async () => {
    const store = new MemoryStore([rfq("r1", "delta")]);
    const adapter: MailAdapter = {
      name: "weird",
      async send() {
        throw "socket closed";
      },
    };
    const outcomes = await sendRfqs(store.snapshot(), store.ports(adapter));
    expect(outcomes).toEqual([{ rfqId: "r1", result: "failed", error: "socket closed" }]);
  });

  it("lets a port failure after the send surface instead of marking the rfq failed", async () => {
    const store = new MemoryStore([rfq("r1", "delta")]);
    const ports = store.ports(new CountingAdapter());
    ports.recordOutbound = async () => {
      throw new Error("messages insert failed");
    };
    await expect(sendRfqs(store.snapshot(), ports)).rejects.toThrow("messages insert failed");
    // markSent ran before recordOutbound, so the rfq cannot be sent twice.
    expect(store.rows.get("r1")?.status).toBe("sent");
  });
});

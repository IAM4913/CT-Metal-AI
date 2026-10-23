import { afterEach, describe, expect, it } from "vitest";
import { readFixture } from "@/lib/fixtures";
import { getMailAdapter, type OutboundMessage } from "./adapter";
import { NoopMailAdapter, noopProviderMessageId } from "./noop";

const RFQ_ID = "00000000-0000-4000-8000-000000000000";

const message: OutboundMessage = {
  rfqId: RFQ_ID,
  from: "caleb@example.com",
  to: ["marcus.reed@example.com"],
  cc: [],
  subject: "RFQ: Lone Star, 4 items, Oct 23, 2026",
  bodyText: "Hi Marcus,\nNeed pricing and availability on the below.\n\n8 pcs W12x26 x 50' A992\n\nLet me know what you can do.\n\nCaleb",
};

describe("noopProviderMessageId", () => {
  it("mints <anvil-rfq-<rfq id>@noop.anvil.local>", () => {
    expect(noopProviderMessageId(RFQ_ID)).toBe("<anvil-rfq-00000000-0000-4000-8000-000000000000@noop.anvil.local>");
  });

  it("matches the id the quote.pdf.eml reply fixture threads to (SESSION_NOTES)", () => {
    const eml = readFixture("replies/quote.pdf.eml").toString("utf8");
    const inReplyTo = /^In-Reply-To:\s*(\S+)\s*$/m.exec(eml)?.[1];
    expect(inReplyTo).toBe(noopProviderMessageId(RFQ_ID));
    expect(eml).toContain(`References: ${noopProviderMessageId(RFQ_ID)}`);
  });
});

describe("NoopMailAdapter", () => {
  it("is named noop and returns the deterministic id without touching the network", async () => {
    const adapter = new NoopMailAdapter();
    expect(adapter.name).toBe("noop");
    await expect(adapter.send(message)).resolves.toEqual({
      providerMessageId: "<anvil-rfq-00000000-0000-4000-8000-000000000000@noop.anvil.local>",
    });
    // Same rfq, same id: a retry after a failed database write threads the same way.
    const again = await adapter.send({ ...message, subject: "edited" });
    expect(again.providerMessageId).toBe(noopProviderMessageId(RFQ_ID));
  });
});

describe("getMailAdapter", () => {
  const original = process.env.MAIL_ADAPTER;

  afterEach(() => {
    if (original === undefined) delete process.env.MAIL_ADAPTER;
    else process.env.MAIL_ADAPTER = original;
  });

  it("defaults to noop when MAIL_ADAPTER is unset or blank", () => {
    delete process.env.MAIL_ADAPTER;
    expect(getMailAdapter()).toBeInstanceOf(NoopMailAdapter);
    process.env.MAIL_ADAPTER = "  ";
    expect(getMailAdapter().name).toBe("noop");
  });

  it("returns noop when asked for it", () => {
    process.env.MAIL_ADAPTER = "noop";
    expect(getMailAdapter().name).toBe("noop");
  });

  it("throws for any other adapter in Phase 1", () => {
    process.env.MAIL_ADAPTER = "graph";
    expect(() => getMailAdapter()).toThrow("Mail adapter graph is not available in Phase 1");
    process.env.MAIL_ADAPTER = "gmail";
    expect(() => getMailAdapter()).toThrow("Mail adapter gmail is not available in Phase 1");
  });
});

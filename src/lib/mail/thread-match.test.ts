import { describe, expect, it } from "vitest";
import { readFixture } from "@/lib/fixtures";
import { noopProviderMessageId } from "./noop";
import { matchReplyToRfq, normalizeMessageId, parseNoopRfqId } from "./thread-match";

const RFQ_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RFQ_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

const outbound = [
  { rfq_id: RFQ_A, provider_message_id: noopProviderMessageId(RFQ_A) },
  { rfq_id: RFQ_B, provider_message_id: "<real-provider-id-123@mail.example.com>" },
];

describe("parseNoopRfqId", () => {
  it("reads the uuid out of the noop adapter's id form", () => {
    expect(parseNoopRfqId(noopProviderMessageId(RFQ_A))).toBe(RFQ_A);
    expect(parseNoopRfqId(`<anvil-rfq-${PLACEHOLDER}@noop.anvil.local>`)).toBe(PLACEHOLDER);
  });

  it("accepts the id without angle brackets and in upper case", () => {
    expect(parseNoopRfqId(`anvil-rfq-${RFQ_A}@noop.anvil.local`)).toBe(RFQ_A);
    expect(parseNoopRfqId(`<ANVIL-RFQ-${RFQ_A.toUpperCase()}@NOOP.ANVIL.LOCAL>`)).toBe(RFQ_A);
    expect(parseNoopRfqId(`  ${noopProviderMessageId(RFQ_A)}  `)).toBe(RFQ_A);
  });

  it("is null for anything else", () => {
    expect(parseNoopRfqId("<real-provider-id-123@mail.example.com>")).toBeNull();
    expect(parseNoopRfqId("<anvil-rfq-not-a-uuid@noop.anvil.local>")).toBeNull();
    expect(parseNoopRfqId(`<anvil-rfq-${RFQ_A}@other.host>`)).toBeNull();
    expect(parseNoopRfqId("")).toBeNull();
  });
});

describe("normalizeMessageId", () => {
  it("drops angle brackets and whitespace", () => {
    expect(normalizeMessageId(" <abc@x> ")).toBe("abc@x");
    expect(normalizeMessageId("abc@x")).toBe("abc@x");
  });
});

describe("matchReplyToRfq", () => {
  it("matches In-Reply-To against a stored provider id", () => {
    expect(matchReplyToRfq({ inReplyTo: "<real-provider-id-123@mail.example.com>", references: [] }, outbound)).toEqual({
      rfqId: RFQ_B,
      matchedBy: "thread",
    });
  });

  it("matches with or without angle brackets", () => {
    expect(matchReplyToRfq({ inReplyTo: "real-provider-id-123@mail.example.com", references: [] }, outbound)?.rfqId).toBe(RFQ_B);
    const bare = [{ rfq_id: RFQ_B, provider_message_id: "real-provider-id-123@mail.example.com" }];
    expect(matchReplyToRfq({ inReplyTo: "<real-provider-id-123@mail.example.com>", references: [] }, bare)?.rfqId).toBe(RFQ_B);
  });

  it("falls back to the References entries, closest parent first", () => {
    const headers = {
      inReplyTo: "<unrelated@elsewhere.example>",
      references: ["<root@elsewhere.example>", noopProviderMessageId(RFQ_A)],
    };
    expect(matchReplyToRfq(headers, outbound)?.rfqId).toBe(RFQ_A);
    const both = {
      inReplyTo: null,
      references: [noopProviderMessageId(RFQ_A), "<real-provider-id-123@mail.example.com>"],
    };
    expect(matchReplyToRfq(both, outbound)?.rfqId).toBe(RFQ_B);
  });

  it("prefers In-Reply-To over References", () => {
    const headers = { inReplyTo: noopProviderMessageId(RFQ_A), references: ["<real-provider-id-123@mail.example.com>"] };
    expect(matchReplyToRfq(headers, outbound)?.rfqId).toBe(RFQ_A);
  });

  it("recognizes the noop id form when the stored provider id differs", () => {
    const stored = [{ rfq_id: RFQ_A, provider_message_id: "<something-else@mail.example.com>" }];
    expect(matchReplyToRfq({ inReplyTo: noopProviderMessageId(RFQ_A), references: [] }, stored)).toEqual({
      rfqId: RFQ_A,
      matchedBy: "thread",
    });
    const unsent = [{ rfq_id: RFQ_A, provider_message_id: null }];
    expect(matchReplyToRfq({ inReplyTo: null, references: [noopProviderMessageId(RFQ_A)] }, unsent)?.rfqId).toBe(RFQ_A);
  });

  it("gives no match for the quote.pdf.eml placeholder id when no such RFQ was sent", () => {
    const eml = readFixture("replies/quote.pdf.eml").toString("utf8");
    const inReplyTo = /^In-Reply-To:\s*(\S+)\s*$/m.exec(eml)?.[1] ?? null;
    const references = /^References:\s*(.+)$/m.exec(eml)?.[1].trim().split(/\s+/) ?? [];
    expect(inReplyTo).toBe(noopProviderMessageId(PLACEHOLDER));
    expect(parseNoopRfqId(inReplyTo!)).toBe(PLACEHOLDER);
    expect(matchReplyToRfq({ inReplyTo, references }, outbound)).toBeNull();
    // Once an RFQ with that id exists, the same headers thread to it.
    const withPlaceholder = [...outbound, { rfq_id: PLACEHOLDER, provider_message_id: noopProviderMessageId(PLACEHOLDER) }];
    expect(matchReplyToRfq({ inReplyTo, references }, withPlaceholder)?.rfqId).toBe(PLACEHOLDER);
  });

  it("gives no match without headers, without outbound messages, or for unknown ids", () => {
    expect(matchReplyToRfq({ inReplyTo: null, references: [] }, outbound)).toBeNull();
    expect(matchReplyToRfq({ inReplyTo: "  ", references: [""] }, outbound)).toBeNull();
    expect(matchReplyToRfq({ inReplyTo: noopProviderMessageId(RFQ_A), references: [] }, [])).toBeNull();
    expect(matchReplyToRfq({ inReplyTo: "<nobody@nowhere.example>", references: ["<x@y>"] }, outbound)).toBeNull();
  });

  it("never matches an outbound row with a null provider id by provider id", () => {
    const stored = [{ rfq_id: RFQ_A, provider_message_id: null }];
    expect(matchReplyToRfq({ inReplyTo: "null", references: [] }, stored)).toBeNull();
    expect(matchReplyToRfq({ inReplyTo: "", references: [] }, stored)).toBeNull();
  });
});

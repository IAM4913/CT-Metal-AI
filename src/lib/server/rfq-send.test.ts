import { describe, expect, it } from "vitest";
import { requestStatusValues } from "@/lib/db/enums";
import type { SendOutcome } from "@/lib/rfq/send";
import { FALLBACK_FROM_EMAIL, mergeOutcomes, NO_LINES_ERROR, partitionByLiveLines, sendBlockedReason } from "./rfq-send";

describe("sendBlockedReason (AC-3.3 before AC-8.1)", () => {
  it("refuses a request that has not been confirmed", () => {
    for (const status of ["new", "parsing", "needs_review"] as const) {
      expect(sendBlockedReason(status)).toBe("Confirm the request on the Review tab before sending.");
    }
  });

  it("lets every confirmed status send, including the ones after the first send", () => {
    for (const status of ["reviewed", "rfqs_drafted", "rfqs_sent", "collecting", "comparing", "sourced", "closed"] as const) {
      expect(sendBlockedReason(status)).toBeNull();
    }
  });

  it("decides every request status the database knows", () => {
    for (const status of requestStatusValues) {
      const reason = sendBlockedReason(status);
      expect(reason === null || typeof reason === "string").toBe(true);
    }
    expect(requestStatusValues.filter((s) => sendBlockedReason(s) !== null)).toEqual(["new", "parsing", "needs_review"]);
  });
});

describe("FALLBACK_FROM_EMAIL", () => {
  it("is the documented stand-in for a session with no email", () => {
    expect(FALLBACK_FROM_EMAIL).toBe("caleb@example.com");
  });
});

describe("partitionByLiveLines (a draft with no live line is not sent)", () => {
  const rfqs = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];

  it("sends the drafts with at least one live line and refuses the rest, keeping the order", () => {
    const counts = new Map([
      ["r1", 2],
      ["r2", 0],
      ["r3", 1],
    ]);
    expect(partitionByLiveLines(rfqs, counts)).toEqual({ sendable: [{ id: "r1" }, { id: "r3" }], empty: [{ id: "r2" }] });
  });

  it("treats a draft missing from the counts as empty", () => {
    expect(partitionByLiveLines(rfqs, new Map([["r1", 1]]))).toEqual({ sendable: [{ id: "r1" }], empty: [{ id: "r2" }, { id: "r3" }] });
    expect(partitionByLiveLines([], new Map())).toEqual({ sendable: [], empty: [] });
  });

  it("names the refusal", () => {
    expect(NO_LINES_ERROR).toBe("No lines");
  });
});

describe("mergeOutcomes", () => {
  it("puts the refused and sent outcomes back in the order of the rfqs", () => {
    const rfqs = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
    const refused: SendOutcome[] = [{ rfqId: "r2", result: "failed", error: NO_LINES_ERROR }];
    const sent: SendOutcome[] = [
      { rfqId: "r1", result: "sent", providerMessageId: "<a>" },
      { rfqId: "r3", result: "sent", providerMessageId: "<c>" },
    ];
    expect(mergeOutcomes(rfqs, [...refused, ...sent]).map((o) => o.rfqId)).toEqual(["r1", "r2", "r3"]);
  });

  it("drops an outcome for an rfq that was not in the list and skips an rfq with no outcome", () => {
    expect(mergeOutcomes([{ id: "r1" }, { id: "r2" }], [{ rfqId: "r9", result: "sent" }, { rfqId: "r2", result: "sent" }])).toEqual([
      { rfqId: "r2", result: "sent" },
    ]);
  });
});

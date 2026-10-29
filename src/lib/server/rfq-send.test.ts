import { describe, expect, it } from "vitest";
import { requestStatusValues, rfqStatusValues } from "@/lib/db/enums";
import type { SendOutcome } from "@/lib/rfq/send";
import {
  FALLBACK_FROM_EMAIL,
  incompleteLinesReason,
  mergeOutcomes,
  NO_LINES_ERROR,
  partitionByLiveLines,
  requestStatusAfterSend,
  sendBlockedReason,
} from "./rfq-send";

const EM_DASH = String.fromCharCode(0x2014);

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

describe("incompleteLinesReason (the AC-3.3 gate behind the status check)", () => {
  it("is null when canConfirm found no problem", () => {
    expect(incompleteLinesReason([])).toBeNull();
  });

  it("names every problem and points at the Review tab", () => {
    const reason = incompleteLinesReason(["Line 2 needs a quantity.", "Line 3 needs a unit."]);
    expect(reason).toContain("Line 2 needs a quantity.");
    expect(reason).toContain("Line 3 needs a unit.");
    expect(reason).toContain("Review tab");
    expect(reason).not.toContain(EM_DASH);
  });
});

describe("requestStatusAfterSend", () => {
  it("moves a reviewed or drafted request to rfqs_sent once every RFQ of the revision went out", () => {
    for (const status of ["reviewed", "rfqs_drafted"] as const) {
      expect(requestStatusAfterSend(status, ["sent"]), status).toBe("rfqs_sent");
      expect(requestStatusAfterSend(status, ["sent", "sent"]), status).toBe("rfqs_sent");
      expect(requestStatusAfterSend(status, ["sent", "responded"]), status).toBe("rfqs_sent");
    }
  });

  it("leaves a partial send where it is (one draft failed or still unsent)", () => {
    for (const status of ["reviewed", "rfqs_drafted"] as const) {
      expect(requestStatusAfterSend(status, ["sent", "failed"]), status).toBeNull();
      expect(requestStatusAfterSend(status, ["sent", "draft"]), status).toBeNull();
      expect(requestStatusAfterSend(status, ["failed"]), status).toBeNull();
    }
  });

  it("moves a comparing request back to collecting when a late send leaves a sent RFQ unanswered", () => {
    expect(requestStatusAfterSend("comparing", ["responded", "declined", "sent"])).toBe("collecting");
    expect(requestStatusAfterSend("comparing", ["declined", "sent"])).toBe("collecting");
  });

  it("keeps a comparing request comparing while every sent RFQ is answered", () => {
    expect(requestStatusAfterSend("comparing", ["responded", "declined"])).toBeNull();
    expect(requestStatusAfterSend("comparing", ["responded", "closed", "failed"])).toBeNull();
  });

  it("never moves rfqs_sent, collecting, sourced, or closed, nor a request before Confirm, and does nothing with no RFQ", () => {
    for (const status of ["rfqs_sent", "collecting", "sourced", "closed", "new", "parsing", "needs_review"] as const) {
      expect(requestStatusAfterSend(status, ["sent"]), status).toBeNull();
      expect(requestStatusAfterSend(status, ["responded", "sent"]), status).toBeNull();
    }
    expect(requestStatusAfterSend("reviewed", [])).toBeNull();
    expect(requestStatusAfterSend("comparing", [])).toBeNull();
  });

  it("decides every request status and every rfq status the database knows", () => {
    for (const status of requestStatusValues) {
      for (const rfqStatus of rfqStatusValues) {
        const next = requestStatusAfterSend(status, [rfqStatus]);
        expect(next === null || requestStatusValues.includes(next)).toBe(true);
      }
    }
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

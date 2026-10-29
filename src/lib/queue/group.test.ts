import { describe, expect, it } from "vitest";
import { requestStatusValues, type RequestStatus, type RfqStatus } from "@/lib/db/enums";
import {
  daysSinceText,
  earliestSentAt,
  groupForQueue,
  QUEUE_GROUP_LABELS,
  QUEUE_GROUPS,
  queueCounts,
  queueGroupForStatus,
  rfqWasReceived,
  rfqWasSent,
  toQueueCard,
  totalCount,
  wholeDaysSince,
  type QueueGroup,
  type QueueRequest,
  type QueueRfq,
} from "./group";

const EM_DASH = String.fromCharCode(0x2014);
const NOW = new Date("2026-10-29T18:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR).toISOString();
}

function rfq(overrides: Partial<QueueRfq> & { id: string }): QueueRfq {
  return {
    branch_name: "Houston",
    vendor_name: "Delta Steel",
    status: "draft",
    sent_at: null,
    ...overrides,
  };
}

function request(overrides: Partial<QueueRequest> & { id: string }): QueueRequest {
  return {
    subject: "Beams for the warehouse job",
    customer_name: "Acme Fabrication",
    status: "new",
    revision: 1,
    received_at: "2026-10-28T14:00:00.000Z",
    line_count: 3,
    rfqs: [],
    ...overrides,
  };
}

describe("queueGroupForStatus", () => {
  const expected: Record<RequestStatus, QueueGroup> = {
    new: "new",
    parsing: "new",
    needs_review: "needs_review",
    reviewed: "drafts_ready",
    rfqs_drafted: "drafts_ready",
    rfqs_sent: "awaiting_responses",
    collecting: "awaiting_responses",
    comparing: "ready_to_compare",
    sourced: "sourced",
    closed: "closed",
  };

  it.each(requestStatusValues)("maps %s to its group", (status) => {
    expect(queueGroupForStatus(status)).toBe(expected[status]);
  });

  it("covers every request status with a group that exists", () => {
    for (const status of requestStatusValues) {
      expect(QUEUE_GROUPS).toContain(queueGroupForStatus(status));
    }
  });

  it("orders the groups the way AC-12.1 lists them", () => {
    expect(QUEUE_GROUPS).toEqual(["new", "needs_review", "drafts_ready", "awaiting_responses", "ready_to_compare", "sourced", "closed"]);
  });

  it("labels every group without an em dash", () => {
    for (const group of QUEUE_GROUPS) {
      expect(QUEUE_GROUP_LABELS[group]).not.toBe("");
      expect(QUEUE_GROUP_LABELS[group]).not.toContain(EM_DASH);
    }
  });
});

describe("rfqWasSent and rfqWasReceived", () => {
  const sentStatuses: RfqStatus[] = ["sent", "responded", "declined", "closed"];
  const unsentStatuses: RfqStatus[] = ["draft", "queued", "failed"];

  it.each(sentStatuses)("counts a %s RFQ as sent even without sent_at", (status) => {
    expect(rfqWasSent({ status, sent_at: null })).toBe(true);
  });

  it.each(unsentStatuses)("does not count a %s RFQ as sent without sent_at", (status) => {
    expect(rfqWasSent({ status, sent_at: null })).toBe(false);
  });

  it("counts a sent_at as sent whatever the status says", () => {
    expect(rfqWasSent({ status: "failed", sent_at: hoursAgo(1) })).toBe(true);
  });

  it("counts responded and declined as received, nothing else", () => {
    expect(rfqWasReceived({ status: "responded" })).toBe(true);
    expect(rfqWasReceived({ status: "declined" })).toBe(true);
    expect(rfqWasReceived({ status: "sent" })).toBe(false);
    expect(rfqWasReceived({ status: "closed" })).toBe(false);
    expect(rfqWasReceived({ status: "draft" })).toBe(false);
  });
});

describe("wholeDaysSince", () => {
  it("is null when nothing was sent", () => {
    expect(wholeDaysSince(null, NOW)).toBeNull();
  });

  it("counts completed days, never rounding up", () => {
    expect(wholeDaysSince(hoursAgo(0), NOW)).toBe(0);
    expect(wholeDaysSince(hoursAgo(23), NOW)).toBe(0);
    expect(wholeDaysSince(hoursAgo(24), NOW)).toBe(1);
    expect(wholeDaysSince(hoursAgo(47), NOW)).toBe(1);
    expect(wholeDaysSince(hoursAgo(48), NOW)).toBe(2);
    expect(wholeDaysSince(hoursAgo(49), NOW)).toBe(2);
    expect(wholeDaysSince(hoursAgo(24 * 10 + 12), NOW)).toBe(10);
  });

  it("reads a future timestamp as 0 days, not a negative number", () => {
    expect(wholeDaysSince(new Date(NOW.getTime() + 3 * HOUR).toISOString(), NOW)).toBe(0);
  });

  it("is null for a timestamp it cannot read", () => {
    expect(wholeDaysSince("not a date", NOW)).toBeNull();
  });

  it("counts elapsed time across midnight: sent 11pm, viewed 9am the next day is 0, and Monday 11pm to Thursday 9am is 2", () => {
    // Central Daylight Time (UTC-5): 11pm Monday Oct 26 is 04:00Z Tuesday; 9am Thursday Oct 29 is 14:00Z.
    const mondayNight = "2026-10-27T04:00:00.000Z";
    expect(wholeDaysSince(mondayNight, new Date("2026-10-27T14:00:00.000Z"))).toBe(0);
    expect(wholeDaysSince(mondayNight, new Date("2026-10-29T14:00:00.000Z"))).toBe(2);
    // The same instants read the same in any zone: there is no local-day arithmetic here.
    expect(wholeDaysSince("2026-10-28T22:00:00.000Z", new Date("2026-10-29T14:00:00.000Z"))).toBe(0);
  });
});

describe("daysSinceText", () => {
  it("never says today: under 24 hours is 'under 1 day'", () => {
    expect(daysSinceText(0)).toBe("under 1 day");
    expect(daysSinceText(1)).toBe("1 day");
    expect(daysSinceText(2)).toBe("2 days");
    expect(daysSinceText(10)).toBe("10 days");
    expect(daysSinceText(null)).toBeNull();
  });

  it("agrees with wholeDaysSince on the cross-midnight case", () => {
    const days = wholeDaysSince("2026-10-28T22:00:00.000Z", new Date("2026-10-29T14:00:00.000Z"));
    expect(daysSinceText(days)).toBe("under 1 day");
  });
});

describe("earliestSentAt", () => {
  it("picks the earliest sent_at and skips unsent RFQs", () => {
    const rfqs = [rfq({ id: "a", sent_at: hoursAgo(5) }), rfq({ id: "b", sent_at: null }), rfq({ id: "c", sent_at: hoursAgo(30) })];
    expect(earliestSentAt(rfqs)).toBe(hoursAgo(30));
  });

  it("is null when nothing was sent", () => {
    expect(earliestSentAt([rfq({ id: "a" }), rfq({ id: "b" })])).toBeNull();
    expect(earliestSentAt([])).toBeNull();
  });
});

describe("toQueueCard", () => {
  it("counts received over sent and measures the wait from the first send", () => {
    const card = toQueueCard(
      request({
        id: "r1",
        status: "collecting",
        rfqs: [
          rfq({ id: "x", vendor_name: "Delta Steel", branch_name: "Houston", status: "responded", sent_at: hoursAgo(50) }),
          rfq({ id: "y", vendor_name: "Alamo Iron", branch_name: "San Antonio", status: "sent", sent_at: hoursAgo(26) }),
          rfq({ id: "z", vendor_name: "Coastal", branch_name: "Beaumont", status: "declined", sent_at: hoursAgo(26) }),
          rfq({ id: "w", vendor_name: "Norfolk", branch_name: "Dallas", status: "draft", sent_at: null }),
        ],
      }),
      NOW,
    );
    expect(card.group).toBe("awaiting_responses");
    expect(card.sent_count).toBe(3);
    expect(card.received_count).toBe(2);
    expect(card.days_since_send).toBe(2);
    expect(card.per_rfq_days.map((entry) => [entry.vendor_name, entry.days])).toEqual([
      ["Alamo Iron", 1],
      ["Coastal", 1],
      ["Delta Steel", 2],
      ["Norfolk", null],
    ]);
    expect(card.per_rfq_days[0]).toEqual({
      rfq_id: "y",
      vendor_name: "Alamo Iron",
      branch_name: "San Antonio",
      status: "sent",
      days: 1,
    });
  });

  it("has null days and zero counts when nothing was sent", () => {
    const card = toQueueCard(request({ id: "r2", status: "rfqs_drafted", rfqs: [rfq({ id: "a" })] }), NOW);
    expect(card.sent_count).toBe(0);
    expect(card.received_count).toBe(0);
    expect(card.days_since_send).toBeNull();
    expect(card.per_rfq_days).toEqual([{ rfq_id: "a", vendor_name: "Delta Steel", branch_name: "Houston", status: "draft", days: null }]);
  });

  it("keeps the request fields on the card", () => {
    const card = toQueueCard(request({ id: "r3", subject: null, customer_name: null, revision: 2, line_count: 7 }), NOW);
    expect(card.id).toBe("r3");
    expect(card.subject).toBeNull();
    expect(card.customer_name).toBeNull();
    expect(card.revision).toBe(2);
    expect(card.line_count).toBe(7);
  });
});

describe("groupForQueue", () => {
  it("has every group key even when there are no requests", () => {
    const groups = groupForQueue([], NOW);
    expect(Object.keys(groups).sort()).toEqual([...QUEUE_GROUPS].sort());
    for (const group of QUEUE_GROUPS) expect(groups[group]).toEqual([]);
  });

  it("puts each request in the group of its status", () => {
    const groups = groupForQueue(
      [
        request({ id: "a", status: "new" }),
        request({ id: "b", status: "parsing" }),
        request({ id: "c", status: "needs_review" }),
        request({ id: "d", status: "reviewed" }),
        request({ id: "e", status: "rfqs_drafted" }),
        request({ id: "f", status: "rfqs_sent" }),
        request({ id: "g", status: "collecting" }),
        request({ id: "h", status: "comparing" }),
        request({ id: "i", status: "sourced" }),
        request({ id: "j", status: "closed" }),
      ],
      NOW,
    );
    const ids = (group: QueueGroup) => groups[group].map((card) => card.id).sort();
    expect(ids("new")).toEqual(["a", "b"]);
    expect(ids("needs_review")).toEqual(["c"]);
    expect(ids("drafts_ready")).toEqual(["d", "e"]);
    expect(ids("awaiting_responses")).toEqual(["f", "g"]);
    expect(ids("ready_to_compare")).toEqual(["h"]);
    expect(ids("sourced")).toEqual(["i"]);
    expect(ids("closed")).toEqual(["j"]);
  });

  it("sorts newest received first within a group, ties by id", () => {
    const groups = groupForQueue(
      [
        request({ id: "old", received_at: "2026-10-01T10:00:00.000Z" }),
        request({ id: "newest", received_at: "2026-10-28T10:00:00.000Z" }),
        request({ id: "tie-b", received_at: "2026-10-15T10:00:00.000Z" }),
        request({ id: "tie-a", received_at: "2026-10-15T10:00:00.000Z" }),
      ],
      NOW,
    );
    expect(groups.new.map((card) => card.id)).toEqual(["newest", "tie-a", "tie-b", "old"]);
  });
});

describe("queueCounts", () => {
  it("counts every group, zero included, and totals them", () => {
    const groups = groupForQueue(
      [
        request({ id: "a", status: "new" }),
        request({ id: "b", status: "new" }),
        request({ id: "c", status: "collecting" }),
        request({ id: "d", status: "sourced" }),
      ],
      NOW,
    );
    const counts = queueCounts(groups);
    expect(counts).toEqual({
      new: 2,
      needs_review: 0,
      drafts_ready: 0,
      awaiting_responses: 1,
      ready_to_compare: 0,
      sourced: 1,
      closed: 0,
    });
    expect(totalCount(counts)).toBe(4);
  });
});

// The queue card's text rules. The wait is elapsed whole days
// (wholeDaysSince in src/lib/queue/group.ts), so a card never says "today" for
// an RFQ sent yesterday afternoon and viewed this morning: under 24 hours
// reads "under 1 day". TZ is pinned to the broker's zone before any Date is
// built so the cross-midnight case is a real one.

process.env.TZ = "America/Chicago";

import { format } from "date-fns";
import { describe, expect, it } from "vitest";

// 5pm Central on Oct 28, viewed 9am Central on Oct 29: 16 hours, two calendar days.
const SENT = "2026-10-28T22:00:00.000Z";
const VIEWED = new Date("2026-10-29T14:00:00.000Z");

describe("lineCountText", () => {
  it("counts lines in words", async () => {
    const { lineCountText } = await import("./queue-card");
    expect(lineCountText(0)).toBe("no lines yet");
    expect(lineCountText(1)).toBe("1 line");
    expect(lineCountText(4)).toBe("4 lines");
  });
});

describe("rfqWaitText", () => {
  it("says under a day, never today, for an RFQ sent yesterday afternoon and viewed this morning", async () => {
    const { wholeDaysSince } = await import("@/lib/queue/group");
    const { rfqWaitText } = await import("./queue-card");
    expect(format(new Date(SENT), "yyyy-MM-dd")).toBe("2026-10-28");
    expect(format(VIEWED, "yyyy-MM-dd")).toBe("2026-10-29");
    const days = wholeDaysSince(SENT, VIEWED);
    expect(days).toBe(0);
    expect(rfqWaitText({ status: "sent", days })).toBe("sent under a day ago");
    expect(rfqWaitText({ status: "responded", days })).toBe("sent under a day ago");
  });

  it("says waiting while the RFQ is open and since send once it is answered", async () => {
    const { rfqWaitText } = await import("./queue-card");
    expect(rfqWaitText({ status: "sent", days: 1 })).toBe("1 day waiting");
    expect(rfqWaitText({ status: "sent", days: 3 })).toBe("3 days waiting");
    expect(rfqWaitText({ status: "responded", days: 3 })).toBe("3 days since send");
    expect(rfqWaitText({ status: "declined", days: 1 })).toBe("1 day since send");
  });

  it("says not sent for a draft", async () => {
    const { rfqWaitText } = await import("./queue-card");
    expect(rfqWaitText({ status: "draft", days: null })).toBe("not sent");
    expect(rfqWaitText({ status: "failed", days: null })).toBe("not sent");
  });
});

describe("firstSendText", () => {
  it("names the wait since the first send with the same rule", async () => {
    const { firstSendText } = await import("./queue-card");
    expect(firstSendText(null)).toBeNull();
    expect(firstSendText(0)).toBe("first send under a day ago");
    expect(firstSendText(1)).toBe("1 day since first send");
    expect(firstSendText(4)).toBe("4 days since first send");
  });
});

describe("one rule across screens", () => {
  it("gives the Offers tab and the purchase bar the same wait as the queue card", async () => {
    const { daysSince } = await import("@/components/offers/offers-workspace");
    const { sentAgo } = await import("@/components/compare/purchase-bar");
    const { rfqWaitText } = await import("./queue-card");
    const { wholeDaysSince } = await import("@/lib/queue/group");
    expect(daysSince(SENT, VIEWED)).toBe("sent under a day ago");
    expect(sentAgo(SENT, VIEWED)).toBe("sent under a day ago");
    expect(rfqWaitText({ status: "sent", days: wholeDaysSince(SENT, VIEWED) })).toBe("sent under a day ago");

    // Monday 11pm Central to Thursday 9am Central: 58 hours, 2 whole days on every screen.
    const mondayNight = "2026-10-27T04:00:00.000Z";
    const thursdayMorning = new Date("2026-10-29T14:00:00.000Z");
    expect(wholeDaysSince(mondayNight, thursdayMorning)).toBe(2);
    expect(daysSince(mondayNight, thursdayMorning)).toBe("2 days ago");
    expect(sentAgo(mondayNight, thursdayMorning)).toBe("sent 2 days ago");
    expect(rfqWaitText({ status: "sent", days: 2 })).toBe("2 days waiting");
    expect(sentAgo(null, thursdayMorning)).toBe("not sent");
  });
});

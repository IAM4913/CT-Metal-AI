// The history date range under a US time zone. confirmed_at is an instant; the
// filter compares its UTC day (inDateRange, and the query bounds in
// src/lib/server/history.ts) and the table shows that same UTC day
// (confirmedDayText). A purchase confirmed at 7:30pm Central on Oct 28 is
// 2026-10-29T00:30Z: the row reads Oct 29 and from=to=2026-10-29 finds it. The
// plain local format would have shown Oct 28, a day no search could find the
// row on (the bug this test pins down). TZ is set before any Date is built.

process.env.TZ = "America/Chicago";

import { format } from "date-fns";
import { describe, expect, it } from "vitest";

const CONFIRMED = "2026-10-29T00:30:00.000Z";

describe("history dates under America/Chicago", () => {
  it("runs in a zone west of Greenwich, where the local format reads the day before", () => {
    expect(new Date(CONFIRMED).getTimezoneOffset()).toBeGreaterThan(0);
    expect(format(new Date(CONFIRMED), "yyyy-MM-dd")).toBe("2026-10-28");
  });

  it("shows the Confirmed cell on the same day the filter matches", async () => {
    const { confirmedDayText, inDateRange, utcDayOf } = await import("./filter");
    const { dayEndUtc, dayStartUtc } = await import("@/lib/server/history");
    expect(utcDayOf(CONFIRMED)).toBe("2026-10-29");
    expect(confirmedDayText(CONFIRMED)).toBe("Oct 29, 2026");
    expect(inDateRange(CONFIRMED, "2026-10-29", "2026-10-29")).toBe(true);
    expect(inDateRange(CONFIRMED, "2026-10-28", "2026-10-28")).toBe(false);
    expect(CONFIRMED >= dayStartUtc("2026-10-29") && CONFIRMED <= dayEndUtc("2026-10-29")).toBe(true);
    expect(CONFIRMED <= dayEndUtc("2026-10-28")).toBe(false);
  });

  it("agrees for an afternoon confirmation too", async () => {
    const { confirmedDayText, inDateRange } = await import("./filter");
    const afternoon = "2026-10-27T21:30:00.000Z";
    expect(confirmedDayText(afternoon)).toBe("Oct 27, 2026");
    expect(inDateRange(afternoon, "2026-10-27", "2026-10-27")).toBe(true);
    expect(format(new Date(afternoon), "yyyy-MM-dd")).toBe("2026-10-27");
  });
});

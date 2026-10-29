// The query bounds of the history date range. The database compares
// confirmed_at against these two instants; inDateRange (filter.ts) compares
// the UTC day after flattening, and confirmedDayText shows that day. The three
// must agree, or a row could be shown on a day a search for that day misses.
// The PostgREST query itself is type-checked only (no database in this session).

import { describe, expect, it } from "vitest";
import { confirmedDayText, inDateRange, utcDayOf } from "@/lib/history/filter";
import { dayEndUtc, dayStartUtc } from "./history";

describe("dayStartUtc and dayEndUtc", () => {
  it("bound a yyyy-mm-dd day at its first and last UTC instant", () => {
    expect(dayStartUtc("2026-10-27")).toBe("2026-10-27T00:00:00.000Z");
    expect(dayEndUtc("2026-10-27")).toBe("2026-10-27T23:59:59.999Z");
  });

  it("agree with inDateRange at both bounds and exclude the neighbouring instants", () => {
    const from = dayStartUtc("2026-10-27");
    const to = dayEndUtc("2026-10-27");
    expect(inDateRange(from, "2026-10-27", "2026-10-27")).toBe(true);
    expect(inDateRange(to, "2026-10-27", "2026-10-27")).toBe(true);
    expect(inDateRange("2026-10-28T00:00:00.000Z", "2026-10-27", "2026-10-27")).toBe(false);
    expect(inDateRange("2026-10-26T23:59:59.999Z", "2026-10-27", "2026-10-27")).toBe(false);
    // The bounds are parseable instants that fall on the day they name.
    expect(utcDayOf(from)).toBe("2026-10-27");
    expect(utcDayOf(to)).toBe("2026-10-27");
  });

  it("match the day the Confirmed column shows for an instant inside them", () => {
    const at = "2026-10-27T21:30:00.000Z";
    expect(at >= dayStartUtc("2026-10-27") && at <= dayEndUtc("2026-10-27")).toBe(true);
    expect(confirmedDayText(at)).toBe("Oct 27, 2026");
    // Just past the UTC midnight: the query for Oct 29 holds it, and so does the shown day.
    const late = "2026-10-29T00:30:00.000Z";
    expect(late >= dayStartUtc("2026-10-29") && late <= dayEndUtc("2026-10-29")).toBe(true);
    expect(late <= dayEndUtc("2026-10-28")).toBe(false);
    expect(confirmedDayText(late)).toBe("Oct 29, 2026");
  });
});

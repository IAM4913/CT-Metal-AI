// The calendar-day helpers under a US time zone. A date-only expiry is stored
// at 00:00 UTC (parseQuoteExpiry, toExpiryTimestamp); read through the
// browser's zone that instant is the evening before, so a Texas broker saw
// "good through 11/30" as Nov 29. These tests pin TZ before any Date is built
// and check that the helpers give the stored day, that the round trip through
// the server's toExpiryTimestamp keeps it, and that the plain local format
// does not (the bug the helpers exist to avoid).

process.env.TZ = "America/Chicago";

import { format } from "date-fns";
import { describe, expect, it } from "vitest";

const STORED = "2026-11-30T00:00:00.000Z";

describe("calendar days under America/Chicago", () => {
  it("runs in a zone west of Greenwich", () => {
    expect(new Date(STORED).getTimezoneOffset()).toBeGreaterThan(0);
    expect(format(new Date(STORED), "yyyy-MM-dd")).toBe("2026-11-29");
  });

  it("isoDayOf and formatIsoDay give the stored UTC day", async () => {
    const { formatIsoDay, isoDayOf } = await import("./money");
    expect(isoDayOf(STORED)).toBe("2026-11-30");
    expect(formatIsoDay(isoDayOf(STORED))).toBe("Nov 30, 2026");
    expect(formatIsoDay("2026-11-30", "yyyy-MM-dd")).toBe("2026-11-30");
    expect(isoDayOf("2026-10-29T15:00:00.000Z")).toBe("2026-10-29");
  });

  it("round-trips an unchanged expiry through the server's toExpiryTimestamp", async () => {
    const { isoDayOf } = await import("./money");
    const { toExpiryTimestamp } = await import("@/lib/server/offers");
    expect(toExpiryTimestamp(isoDayOf(STORED))).toBe(STORED);
    expect(toExpiryTimestamp("2026-11-30")).toBe(STORED);
  });

  it("parseQuoteExpiry names the day the vendor wrote, in UTC", async () => {
    const { parseQuoteExpiry, isoDayOf } = await import("./money");
    const expiry = parseQuoteExpiry("good through 11/30", new Date("2026-10-22T15:00:00Z"));
    expect(expiry?.toISOString()).toBe(STORED);
    expect(isoDayOf(expiry!.toISOString())).toBe("2026-11-30");
  });
});

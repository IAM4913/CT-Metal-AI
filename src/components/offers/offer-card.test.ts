// The card's pure field readers. The expiry is a calendar day: it is committed
// as yyyy-MM-dd (parseDateOnlyInput) so the server stores it at 00:00 UTC and
// isoDayOf reads the same day back in every zone; the received date is an
// instant (parseDateInput, local noon).

process.env.TZ = "America/Chicago";

import { describe, expect, it } from "vitest";

describe("parseDateOnlyInput", () => {
  it("returns the typed day unchanged, null for blank, and an error for anything else", async () => {
    const { parseDateOnlyInput } = await import("./offer-card");
    expect(parseDateOnlyInput("2026-11-30")).toEqual({ value: "2026-11-30" });
    expect(parseDateOnlyInput("  2026-11-30 ")).toEqual({ value: "2026-11-30" });
    expect(parseDateOnlyInput("")).toEqual({ value: null });
    expect(parseDateOnlyInput("11/30/2026")).toHaveProperty("error");
    expect(parseDateOnlyInput("2026-02-30")).toEqual({ error: "That is not a real date." });
  });

  it("round-trips through the server's storage form and back to the same day under a US zone", async () => {
    const { parseDateOnlyInput } = await import("./offer-card");
    const { toExpiryTimestamp } = await import("@/lib/server/offers");
    const { isoDayOf } = await import("@/lib/parsing/money");
    const typed = parseDateOnlyInput("2026-11-30");
    if ("error" in typed) throw new Error(typed.error);
    const stored = toExpiryTimestamp(typed.value);
    expect(stored).toBe("2026-11-30T00:00:00.000Z");
    expect(isoDayOf(stored)).toBe("2026-11-30");
  });
});

describe("parseDateInput (an instant)", () => {
  it("keeps the typed day for a received date by storing local noon", async () => {
    const { parseDateInput } = await import("./offer-card");
    const parsed = parseDateInput("2026-10-23");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(new Date(parsed.value!).getDate()).toBe(23);
    expect(parseDateInput("")).toEqual({ value: null });
  });
});

describe("earlyPaySummary", () => {
  it("writes the known half and marks the unknown one", async () => {
    const { earlyPaySummary } = await import("./offer-card");
    expect(earlyPaySummary(1, 10)).toBe("1% net 10");
    expect(earlyPaySummary(1, null)).toBe("1% ? days");
    expect(earlyPaySummary(null, 10)).toBe("? % net 10");
    expect(earlyPaySummary(null, null)).toBeNull();
  });
});

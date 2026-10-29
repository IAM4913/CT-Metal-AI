import { describe, expect, it } from "vitest";
import {
  formatIsoDay,
  isoDayOf,
  parseDateMention,
  parseEarlyPay,
  parseMoney,
  parsePercent,
  parseQuoteExpiry,
  parseReadyDate,
  toIsoDate,
} from "./money";

// The reply fixtures were received on this instant (PLAN Step 6 recordings).
const RECEIVED = new Date("2026-10-22T15:00:00Z");

describe("parseMoney", () => {
  it("reads a price with a currency symbol and a basis fragment", () => {
    expect(parseMoney("$64.50/cwt")).toBe(64.5);
    expect(parseMoney("64.50/cwt")).toBe(64.5);
    expect(parseMoney("$0.98/ft")).toBe(0.98);
    expect(parseMoney("0.98/ft")).toBe(0.98);
    expect(parseMoney("$62.50 cwt")).toBe(62.5);
    expect(parseMoney("$71.00 cwt")).toBe(71);
    expect(parseMoney("$58.00")).toBe(58);
    expect(parseMoney("1,250 each")).toBe(1250);
    expect(parseMoney("$2.50/cwt freight")).toBe(2.5);
    expect(parseMoney("USD 64.5 per cwt")).toBe(64.5);
  });

  it("drops thousands separators and reads a bare fraction", () => {
    expect(parseMoney("$1,250")).toBe(1250);
    expect(parseMoney("$12,345.67")).toBe(12345.67);
    expect(parseMoney("1,250.00")).toBe(1250);
    expect(parseMoney(".98")).toBe(0.98);
    expect(parseMoney("$.98/ft")).toBe(0.98);
    expect(parseMoney("  $ 64.50  ")).toBe(64.5);
  });

  it("reads the amount from the currency marker, not a count or length ahead of it", () => {
    expect(parseMoney("8 pcs $62.50 cwt")).toBe(62.5);
    expect(parseMoney("40', $64.50/cwt")).toBe(64.5);
    expect(parseMoney("2 trucks $350")).toBe(350);
    expect(parseMoney("20 pcs @ $64.50/cwt")).toBe(64.5);
    expect(parseMoney("HSS8x8x1/2 $64.50 cwt")).toBe(64.5);
    expect(parseMoney("W12x26 x 50' 8 pcs $62.50 cwt stock")).toBe(62.5);
    expect(parseMoney("8 pcs US$62.50")).toBe(62.5);
    expect(parseMoney("8 pcs USD 62.50")).toBe(62.5);
    // No marker: the first number stands, as before.
    expect(parseMoney("64.50 cwt")).toBe(64.5);
  });

  it("is null for text with no amount, and never NaN", () => {
    for (const text of ["n/a", "", "   ", "included", "TBD", "call", "$", "free", "per cwt"]) {
      expect(parseMoney(text), JSON.stringify(text)).toBeNull();
    }
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
  });

  it("is null for a decimal comma or a malformed thousands group instead of a truncated number", () => {
    for (const text of ["64,50", "12,5", "1.250,00", "$1,2500", "EUR 64,50"]) {
      expect(parseMoney(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("never throws on odd input", () => {
    expect(() => parseMoney("$$$///")).not.toThrow();
    expect(parseMoney("$$$///")).toBeNull();
    expect(parseMoney("1.2.3")).toBeNull();
    expect(Number.isNaN(parseMoney("1.2.3") as number)).toBe(false);
  });

  it("reads zero as a stated amount and refuses a signed amount", () => {
    expect(parseMoney("$0.00")).toBe(0);
    expect(parseMoney("-5")).toBeNull();
    expect(parseMoney("-$150 credit")).toBeNull();
    expect(parseMoney("$-150")).toBeNull();
    expect(parseMoney("credit -150.00")).toBeNull();
    // A bulleted line and a range digit are not signs.
    expect(parseMoney("- $64.50/cwt")).toBe(64.5);
    expect(parseMoney("$100, 1-2 trucks")).toBe(100);
  });
});

describe("parsePercent", () => {
  it("reads percent signs and words", () => {
    expect(parsePercent("1%")).toBe(1);
    expect(parsePercent("1 %")).toBe(1);
    expect(parsePercent("1 percent")).toBe(1);
    expect(parsePercent("0.5%")).toBe(0.5);
    expect(parsePercent("2 pct")).toBe(2);
    expect(parsePercent("1% net 10")).toBe(1);
    expect(parsePercent("Net 30, 1% 10 days")).toBe(1);
  });

  it("is null without a percent word", () => {
    expect(parsePercent("net 30")).toBeNull();
    expect(parsePercent("30")).toBeNull();
    expect(parsePercent("")).toBeNull();
    expect(parsePercent(null)).toBeNull();
    expect(parsePercent(undefined)).toBeNull();
    expect(parsePercent("one percent")).toBeNull();
  });
});

describe("parseEarlyPay", () => {
  it("reads the percent and days forms", () => {
    expect(parseEarlyPay("1% net 10")).toEqual({ pct: 1, days: 10 });
    expect(parseEarlyPay("1% 10 days")).toEqual({ pct: 1, days: 10 });
    expect(parseEarlyPay("2% 10")).toEqual({ pct: 2, days: 10 });
    expect(parseEarlyPay("2% 10 net 30")).toEqual({ pct: 2, days: 10 });
    expect(parseEarlyPay("Net 30, 1% 10 days")).toEqual({ pct: 1, days: 10 });
    expect(parseEarlyPay("1% if paid in 10 days")).toEqual({ pct: 1, days: 10 });
    expect(parseEarlyPay("0.5% net 15")).toEqual({ pct: 0.5, days: 15 });
    expect(parseEarlyPay("1 percent 10 days")).toEqual({ pct: 1, days: 10 });
  });

  it("reads the slash form", () => {
    expect(parseEarlyPay("1/10 net 30")).toEqual({ pct: 1, days: 10 });
    expect(parseEarlyPay("2/10, n/30")).toEqual({ pct: 2, days: 10 });
    expect(parseEarlyPay("terms 2/10 net 30")).toEqual({ pct: 2, days: 10 });
    expect(parseEarlyPay("2/10")).toEqual({ pct: 2, days: 10 });
  });

  it("does not read a date as terms", () => {
    expect(parseEarlyPay("good through 10/17/2026")).toEqual({ pct: null, days: null });
  });

  it("with slashNeedsNet reads the slash form only beside a terms marker, so a month/day in the terms is nothing", () => {
    const terms = { slashNeedsNet: true };
    expect(parseEarlyPay("Net 30, due 11/30", terms)).toEqual({ pct: null, days: null });
    expect(parseEarlyPay("Net 30 from 10/22", terms)).toEqual({ pct: null, days: null });
    expect(parseEarlyPay("Net 30, 1/2 down", terms)).toEqual({ pct: null, days: null });
    expect(parseEarlyPay("good through 10/17", terms)).toEqual({ pct: null, days: null });
    expect(parseEarlyPay("2/10", terms)).toEqual({ pct: null, days: null });
    expect(parseEarlyPay("2/10, n/30", terms)).toEqual({ pct: 2, days: 10 });
    expect(parseEarlyPay("terms 2/10 net 30", terms)).toEqual({ pct: 2, days: 10 });
    expect(parseEarlyPay("Terms: 2/10", terms)).toEqual({ pct: 2, days: 10 });
    expect(parseEarlyPay("1/10 net 30", terms)).toEqual({ pct: 1, days: 10 });
    // The marked pair is found even after an unmarked one.
    expect(parseEarlyPay("due 11/30, 2/10 net 30", terms)).toEqual({ pct: 2, days: 10 });
    // The percent form never needs a marker.
    expect(parseEarlyPay("Net 30, 1% 10 days, due 11/30", terms)).toEqual({ pct: 1, days: 10 });
  });

  it("keeps days null when no window follows the discount", () => {
    expect(parseEarlyPay("1%")).toEqual({ pct: 1, days: null });
    expect(parseEarlyPay("1% early pay")).toEqual({ pct: 1, days: null });
  });

  it("is null for plain terms or nothing", () => {
    expect(parseEarlyPay("net 30")).toEqual({ pct: null, days: null });
    expect(parseEarlyPay("Net 30")).toEqual({ pct: null, days: null });
    expect(parseEarlyPay("COD")).toEqual({ pct: null, days: null });
    expect(parseEarlyPay("")).toEqual({ pct: null, days: null });
    expect(parseEarlyPay(null)).toEqual({ pct: null, days: null });
    expect(parseEarlyPay(undefined)).toEqual({ pct: null, days: null });
  });
});

describe("parseReadyDate", () => {
  it("reads a month and day in the reference year", () => {
    expect(parseReadyDate("week of Nov 17", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("11/17", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("Nov 17", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("November 17th", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("Nov. 17", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("17 Nov", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("rolling 11/17", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("ships the week of 12/1", RECEIVED)?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("reads an explicit year in every spelling", () => {
    expect(parseReadyDate("11/17/2026", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("11/17/26", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("Nov 17, 2026", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("Nov 17, 2027", RECEIVED)?.toISOString()).toBe("2027-11-17T00:00:00.000Z");
    expect(parseReadyDate("November 17 2027", RECEIVED)?.toISOString()).toBe("2027-11-17T00:00:00.000Z");
    expect(parseReadyDate("2026-11-17", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("1/5/2026", RECEIVED)?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  it("does not read a weight or a footage after the day as a year", () => {
    // 2000 looks like a year but is 26 years back: not a date the vendor means; the text stays beside the line.
    expect(parseReadyDate("Nov 17 2000 lbs", RECEIVED)).toBeNull();
    expect(parseReadyDate("week of Nov 17, 5000 lbs", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("Nov 17 1000 ft", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("Nov 17 2000lbs", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("Nov 17 20000 lbs", RECEIVED)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(parseReadyDate("17 Nov 2000 lbs", RECEIVED)).toBeNull();
  });

  it("refuses an explicit date more than a year before the reference", () => {
    expect(parseReadyDate("11/17/2024", RECEIVED)).toBeNull();
    expect(parseReadyDate("Nov 17, 2024", RECEIVED)).toBeNull();
    expect(parseReadyDate("2024-11-17", RECEIVED)).toBeNull();
    // Within a year back is kept (an explicit year never rolls).
    expect(parseReadyDate("Nov 17, 2025", RECEIVED)?.toISOString()).toBe("2025-11-17T00:00:00.000Z");
  });

  it("rolls to the next year only when the date is more than 60 days before the reference", () => {
    const december = new Date("2026-12-10T12:00:00Z");
    expect(parseReadyDate("week of Jan 5", december)?.toISOString()).toBe("2027-01-05T00:00:00.000Z");
    expect(parseReadyDate("1/5", december)?.toISOString()).toBe("2027-01-05T00:00:00.000Z");
    // Three weeks back: the date just passed, same year.
    expect(parseReadyDate("Oct 1", RECEIVED)?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // Sixty days back exactly stays; sixty-one rolls.
    expect(parseReadyDate("8/23", RECEIVED)?.toISOString()).toBe("2026-08-23T00:00:00.000Z");
    expect(parseReadyDate("8/22", RECEIVED)?.toISOString()).toBe("2027-08-22T00:00:00.000Z");
    // An explicit year never rolls.
    expect(parseReadyDate("Jan 5, 2026", december)?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  it("is null when no specific day is named", () => {
    for (const text of ["mid November", "ASAP", "stock", "December", "2 to 3 weeks", "next rolling", "", "TBD"]) {
      expect(parseReadyDate(text, RECEIVED), JSON.stringify(text)).toBeNull();
    }
    expect(parseReadyDate(null, RECEIVED)).toBeNull();
    expect(parseReadyDate(undefined, RECEIVED)).toBeNull();
  });

  it("refuses an impossible date and a bad reference", () => {
    expect(parseReadyDate("13/45", RECEIVED)).toBeNull();
    expect(parseReadyDate("Feb 30", RECEIVED)).toBeNull();
    expect(parseReadyDate("2026-02-30", RECEIVED)).toBeNull();
    expect(parseReadyDate("Nov 17", new Date("not a date"))).toBeNull();
  });

  it("never throws", () => {
    expect(() => parseReadyDate("///", RECEIVED)).not.toThrow();
    expect(() => parseDateMention("99/99/9999", RECEIVED)).not.toThrow();
  });
});

describe("parseQuoteExpiry", () => {
  it("adds a stated window to the reference instant", () => {
    expect(parseQuoteExpiry("valid 7 days", RECEIVED)?.toISOString()).toBe("2026-10-29T15:00:00.000Z");
    expect(parseQuoteExpiry("Quote valid 7 days", RECEIVED)?.toISOString()).toBe("2026-10-29T15:00:00.000Z");
    expect(parseQuoteExpiry("good for 10 days", RECEIVED)?.toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(parseQuoteExpiry("valid 30 days from quote date", RECEIVED)?.toISOString()).toBe("2026-11-21T15:00:00.000Z");
    expect(parseQuoteExpiry("firm for 2 weeks", RECEIVED)?.toISOString()).toBe("2026-11-05T15:00:00.000Z");
    expect(parseQuoteExpiry("1 day", RECEIVED)?.toISOString()).toBe("2026-10-23T15:00:00.000Z");
  });

  it("reads a named date, which wins over a window it is the end of", () => {
    expect(parseQuoteExpiry("good through 11/30", RECEIVED)?.toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(parseQuoteExpiry("expires Nov 30, 2026", RECEIVED)?.toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(parseQuoteExpiry("valid through 11/30/2026", RECEIVED)?.toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(parseQuoteExpiry("good until Dec 1 or 7 days", RECEIVED)?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("counts a window from the quote's own date when both are written", () => {
    expect(parseQuoteExpiry("valid 30 days from 10/22/2026", RECEIVED)?.toISOString()).toBe("2026-11-21T00:00:00.000Z");
    expect(parseQuoteExpiry("valid 30 days from 10/22/26", RECEIVED)?.toISOString()).toBe("2026-11-21T00:00:00.000Z");
    expect(parseQuoteExpiry("Prices valid 30 days from date of quote 10/22/26", RECEIVED)?.toISOString()).toBe("2026-11-21T00:00:00.000Z");
    expect(parseQuoteExpiry("Quote valid 30 days from Oct 22, 2026", RECEIVED)?.toISOString()).toBe("2026-11-21T00:00:00.000Z");
    // The quote was dated the day before it arrived: the window still counts from the quote date.
    expect(parseQuoteExpiry("valid 30 days from 10/21/2026", RECEIVED)?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    // "from" anchors a date after the reference too.
    expect(parseQuoteExpiry("valid 30 days from 10/23/2026", RECEIVED)?.toISOString()).toBe("2026-11-22T00:00:00.000Z");
    // A stale quote date is not a date at all, so only the window stands, from the reference.
    expect(parseQuoteExpiry("valid 30 days from 10/22/2024", RECEIVED)?.toISOString()).toBe("2026-11-21T15:00:00.000Z");
  });

  it("is null otherwise", () => {
    for (const text of ["subject to change", "until sold", "", "valid", "0 days", "prices firm"]) {
      expect(parseQuoteExpiry(text, RECEIVED), JSON.stringify(text)).toBeNull();
    }
    expect(parseQuoteExpiry(null, RECEIVED)).toBeNull();
    expect(parseQuoteExpiry(undefined, RECEIVED)).toBeNull();
    expect(parseQuoteExpiry("valid 7 days", new Date("x"))).toBeNull();
    expect(parseQuoteExpiry("good through Nov 30 2000 lbs", RECEIVED)).toBeNull();
  });
});

describe("toIsoDate, isoDayOf, formatIsoDay", () => {
  it("formats the UTC day", () => {
    expect(toIsoDate(new Date("2026-11-17T00:00:00.000Z"))).toBe("2026-11-17");
    expect(toIsoDate(new Date("2026-10-29T15:00:00.000Z"))).toBe("2026-10-29");
  });

  it("reads the UTC calendar day of a stored timestamp", () => {
    expect(isoDayOf("2026-11-30T00:00:00.000Z")).toBe("2026-11-30");
    expect(isoDayOf("2026-10-29T15:00:00.000Z")).toBe("2026-10-29");
    expect(isoDayOf("2026-10-29T23:59:59.000Z")).toBe("2026-10-29");
    expect(isoDayOf("not a date")).toBeNull();
    expect(isoDayOf(null)).toBeNull();
    expect(isoDayOf(undefined)).toBeNull();
  });

  it("formats a yyyy-MM-dd day from its components", () => {
    expect(formatIsoDay("2026-11-30")).toBe("Nov 30, 2026");
    expect(formatIsoDay("2026-10-29", "yyyy-MM-dd")).toBe("2026-10-29");
    expect(formatIsoDay("2026-13-40")).toBeNull();
    expect(formatIsoDay("11/30/2026")).toBeNull();
    expect(formatIsoDay(null)).toBeNull();
  });
});

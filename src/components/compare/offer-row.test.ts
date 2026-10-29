// The Compare tab's text rules and the select default (offer-row.tsx), the
// pure parts of the row. Rendering is not exercised here (no database, no
// browser in this session); each helper is the one the cells call. TZ is
// pinned to a US zone before any Date is built so the expiry day test is a
// real one: midnight UTC is the evening before in Chicago.

process.env.TZ = "America/Chicago";

import { describe, expect, it } from "vitest";
import {
  changedList,
  defaultSelectQty,
  earlyPayText,
  expiryText,
  extendedText,
  formatDay,
  formatQty,
  freightText,
  perFootText,
  requestedItemTitle,
  unfilledText,
  unitPriceText,
} from "./offer-row";

const EM_DASH = String.fromCharCode(0x2014);

describe("unfilledText", () => {
  const known = { available_qty: 25, unit: "pcs" as const, same_unit: true, unfilled: 15 };

  it("names the shortfall in the request's unit, or that the request is covered", () => {
    expect(unfilledText(known, 40, "pcs")).toBe("15 pcs short");
    expect(unfilledText({ ...known, available_qty: 60, unfilled: 0 }, 40, "pcs")).toBe("covers the request");
  });

  it("says the balance is unknown when the vendor named no quantity", () => {
    expect(unfilledText({ available_qty: null, unit: null, same_unit: true, unfilled: null }, 40, "pcs")).toBe("balance unknown");
  });

  it("says the requested quantity is unknown only when it is", () => {
    expect(unfilledText({ available_qty: 60, unit: "pcs", same_unit: true, unfilled: null }, null, "pcs")).toBe("requested qty unknown");
    expect(unfilledText({ available_qty: 60, unit: "pcs", same_unit: true, unfilled: null }, null, null)).toBe("requested qty unknown");
  });

  it("names both quantities when they are not in one unit instead of calling either unknown", () => {
    expect(unfilledText({ available_qty: 800, unit: "ft", same_unit: false, unfilled: null }, 8, "pcs")).toBe("not compared: 800 ft offered, 8 pcs requested");
    expect(unfilledText({ available_qty: 10, unit: null, same_unit: false, unfilled: null }, 8, "pcs")).toBe(
      "not compared: 10 (unit unknown) offered, 8 pcs requested",
    );
    expect(unfilledText({ available_qty: 400, unit: "ft", same_unit: false, unfilled: null }, 8, null)).toBe(
      "not compared: 400 ft offered, 8 (unit unknown) requested",
    );
  });
});

describe("defaultSelectQty", () => {
  it("is the smaller of requested and available when both are known in one unit", () => {
    expect(defaultSelectQty(40, 25, true)).toBe(25);
    expect(defaultSelectQty(40, 60, true)).toBe(40);
    expect(defaultSelectQty(20, 20, true)).toBe(20);
  });

  it("is the requested quantity when the vendor counts in another unit, never the vendor's number", () => {
    expect(defaultSelectQty(800, 40, false)).toBe(800);
    expect(defaultSelectQty(8, 800, false)).toBe(8);
    expect(defaultSelectQty(40, 12, false)).toBe(40);
    expect(defaultSelectQty(8, 5, false)).toBe(8);
  });

  it("is blank when the requested quantity is unknown, or the available one is unknown in the same unit", () => {
    expect(defaultSelectQty(null, 40, false)).toBeNull();
    expect(defaultSelectQty(null, 40, true)).toBeNull();
    expect(defaultSelectQty(40, null, true)).toBeNull();
    expect(defaultSelectQty(null, null, true)).toBeNull();
    expect(defaultSelectQty(0, 40, true)).toBeNull();
    expect(defaultSelectQty(40, 0, true)).toBeNull();
  });
});

describe("freightText", () => {
  it("shows an amount, 'included in price' for freight folded into the price, else unknown", () => {
    expect(freightText(350, "separate")).toBe("$350.00");
    expect(freightText(0, "separate")).toBe("$0.00");
    expect(freightText(null, "included")).toBe("included in price");
    expect(freightText(null, "separate")).toBe("unknown");
    expect(freightText(null, "unknown")).toBe("unknown");
  });
});

describe("requestedItemTitle (PRD section 8: canonical or raw)", () => {
  it("names a linked line by its designation, with the description beneath when it differs", () => {
    expect(requestedItemTitle({ designation: "W12x26", raw_text: "W12x26 x 50' qty 8", description: "W12x26" })).toEqual({ title: "W12x26", secondary: null });
    expect(requestedItemTitle({ designation: "HSS8x8x3/8", raw_text: '8" sq 3/8 x 40', description: "8 square tube 3/8" })).toEqual({
      title: "HSS8x8x3/8",
      secondary: "8 square tube 3/8",
    });
  });

  it("names an unlinked line by the customer's own words, not the parser's word", () => {
    expect(requestedItemTitle({ designation: null, raw_text: "some angle for clips", description: "angle" })).toEqual({
      title: "some angle for clips",
      secondary: "angle",
    });
    expect(requestedItemTitle({ designation: null, raw_text: "  3/8 plate 48x96 qty 10 A36  ", description: "3/8 plate" })).toEqual({
      title: "3/8 plate 48x96 qty 10 A36",
      secondary: "3/8 plate",
    });
  });

  it("falls back to the description, then a marker, when there is no raw text", () => {
    expect(requestedItemTitle({ designation: null, raw_text: "", description: "channel" })).toEqual({ title: "channel", secondary: null });
    expect(requestedItemTitle({ designation: null, raw_text: "  ", description: "  " })).toEqual({ title: "(no text)", secondary: null });
  });
});

describe("expiryText (the Expires column shows the stored UTC day, as the Offers tab does)", () => {
  it("renders a calendar-day expiry stored at 00:00 UTC on that day under a US zone", () => {
    expect(process.env.TZ).toBe("America/Chicago");
    expect(expiryText("2026-11-30T00:00:00.000Z")).toBe("Nov 30, 2026");
    expect(expiryText("2026-11-30T00:00:00+00:00")).toBe("Nov 30, 2026");
    expect(expiryText("2026-11-30")).toBe("Nov 30, 2026");
  });

  it("is unknown when there is no expiry", () => {
    expect(expiryText(null)).toBe("unknown");
  });

  it("leaves the date-only ready date on formatDay, which reads it as a local day", () => {
    expect(formatDay("2026-11-17")).toBe("Nov 17, 2026");
    expect(formatDay(null)).toBe("unknown");
  });
});

describe("the other text rules", () => {
  it("never write a zero for a missing value", () => {
    expect(formatQty(null, "pcs")).toBe("unknown");
    expect(formatQty(20, "pcs")).toBe("20 pcs");
    expect(formatQty(20, null)).toBe("20");
    expect(unitPriceText(null, "per_cwt")).toBe("unknown");
    expect(unitPriceText(64.5, "per_cwt")).toBe("$64.50/cwt");
    expect(unitPriceText(0.4325, "per_lb")).toBe("$0.4325/lb");
    expect(unitPriceText(12, null)).toBe("$12.00 (no basis)");
    expect(extendedText({ value: 6708 })).toBe("$6,708.00");
    expect(extendedText({ reason: "no price" })).toBe("cannot compute: no price");
    expect(perFootText({ value: 16.77 })).toBe("$16.77/ft");
    expect(perFootText({ reason: "no weight per foot" })).toBe("not comparable: no weight per foot");
  });

  it("keep early pay a scenario", () => {
    expect(earlyPayText({ pct: null, days: null, savings: { reason: "no early-pay terms" } })).toBe("n/a");
    expect(earlyPayText({ pct: 1, days: 10, savings: { value: 67.08 } })).toBe("if paid in 10 days: $67.08");
    expect(earlyPayText({ pct: 1, days: null, savings: { value: 67.08 } })).toBe("if paid early: $67.08");
    expect(earlyPayText({ pct: 1, days: 10, savings: { reason: "no price" } })).toBe("if paid in 10 days (1%): unknown, no price");
  });

  it("list what changed on an alternate, falling back to the type names and then a plain statement", () => {
    expect(changedList({ is_exact_match: true, changed: [], alternate_types: [] })).toEqual([]);
    expect(changedList({ is_exact_match: false, changed: ["wall 3/8 to 1/2"], alternate_types: ["wall"] })).toEqual(["wall 3/8 to 1/2"]);
    expect(changedList({ is_exact_match: false, changed: [], alternate_types: ["grade", "length"] })).toEqual(["grade differs", "length differs"]);
    expect(changedList({ is_exact_match: false, changed: [], alternate_types: [] })).toEqual(["differs from the request (the reply did not say how)"]);
    for (const text of changedList({ is_exact_match: false, changed: [], alternate_types: [] })) expect(text).not.toContain(EM_DASH);
  });
});

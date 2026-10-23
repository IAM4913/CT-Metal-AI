import { describe, expect, it } from "vitest";
import {
  formatRfqLength,
  formatRfqLine,
  formatSheetSize,
  rawTextCarriesGrade,
  rawTextCarriesLength,
  rawTextCarriesQty,
  rfqBody,
  rfqSubject,
  type RfqLineView,
} from "./templates";

const EM_DASH = String.fromCharCode(0x2014);

function line(overrides: Partial<RfqLineView> = {}): RfqLineView {
  return {
    designation: "W12x26",
    raw_text: "W12x26 x 50' A992 qty 8",
    description: "W12x26",
    qty: 8,
    unit: "pcs",
    length_ft: 50,
    length_text: "50'",
    grade_spec: "A992",
    note: null,
    delivery_notes: null,
    ...overrides,
  };
}

const DATE = new Date(2026, 9, 23, 14, 5); // Oct 23, 2026, local time

describe("rfqSubject (AC-7.2)", () => {
  it("uses the customer short name", () => {
    expect(rfqSubject({ customerShortName: "Lone Star", itemCount: 4, date: DATE })).toBe(
      "RFQ: Lone Star, 4 items, Oct 23, 2026",
    );
  });

  it("falls back to Material request when there is no customer or the short name is blank", () => {
    expect(rfqSubject({ customerShortName: null, itemCount: 2, date: DATE })).toBe(
      "RFQ: Material request, 2 items, Oct 23, 2026",
    );
    expect(rfqSubject({ customerShortName: "   ", itemCount: 2, date: DATE })).toBe(
      "RFQ: Material request, 2 items, Oct 23, 2026",
    );
  });

  it("writes the singular for one item", () => {
    expect(rfqSubject({ customerShortName: "Brazos", itemCount: 1, date: DATE })).toBe("RFQ: Brazos, 1 item, Oct 23, 2026");
    expect(rfqSubject({ customerShortName: null, itemCount: 0, date: DATE })).toBe(
      "RFQ: Material request, 0 items, Oct 23, 2026",
    );
  });

  it("formats the date as MMM d, yyyy", () => {
    expect(rfqSubject({ customerShortName: "X", itemCount: 1, date: new Date(2027, 0, 5) })).toBe("RFQ: X, 1 item, Jan 5, 2027");
  });
});

describe("formatRfqLine (AC-7.3)", () => {
  it("writes qty, unit, designation, length, grade for a linked beam", () => {
    expect(formatRfqLine(line())).toBe("8 pcs W12x26 x 50' A992");
  });

  it("writes an angle with no grade", () => {
    expect(
      formatRfqLine(line({ designation: "L2x2x1/4", qty: 40, length_ft: 20, length_text: "20'", grade_spec: null })),
    ).toBe("40 pcs L2x2x1/4 x 20'");
  });

  it("writes plate as the designation, the sheet size from dims, and the grade, with no length", () => {
    // The catalog designation names only the thickness; the sheet size is dims.w x dims.l
    // as the parser stores it for the mixed-list fixture ("3/8 plate 48x96 qty 10 A36").
    expect(
      formatRfqLine(
        line({
          designation: "PL3/8",
          raw_text: "3/8 plate 48x96 qty 10 A36",
          description: "PL3/8",
          qty: 10,
          length_ft: null,
          length_text: null,
          grade_spec: "A36",
          dims: { t: 0.375, w: 48, l: 96 },
        }),
      ),
    ).toBe("10 pcs PL3/8 48x96 A36");
    expect(
      formatRfqLine(
        line({ designation: "PL1/2", qty: 4, length_ft: null, length_text: null, grade_spec: "A36", dims: { t: 0.5, w: 60, l: 120 } }),
      ),
    ).toBe("4 pcs PL1/2 60x120 A36");
  });

  it("writes the sheet size for sheet, and a fractional width plainly", () => {
    expect(
      formatRfqLine(
        line({ designation: "SH10GA", qty: 6, length_ft: null, length_text: null, grade_spec: null, dims: { gauge: 10, w: 48.5, l: 120 } }),
      ),
    ).toBe("6 pcs SH10GA 48.5x120");
  });

  it("writes no sheet size for a section, a flat bar, a plate with no size, or a custom line", () => {
    expect(formatRfqLine(line({ dims: { d: 12, wt: 26 } }))).toBe("8 pcs W12x26 x 50' A992");
    expect(formatRfqLine(line({ designation: "FB1/4x2", length_ft: 20, length_text: "20'", grade_spec: null, dims: { t: 0.25, w: 2 } }))).toBe(
      "8 pcs FB1/4x2 x 20'",
    );
    expect(formatRfqLine(line({ designation: "PL3/8", length_ft: null, length_text: null, grade_spec: "A36", dims: { t: 0.375 } }))).toBe(
      "8 pcs PL3/8 A36",
    );
    expect(formatRfqLine(line({ designation: "PL3/8", length_ft: null, length_text: null, grade_spec: "A36", dims: null }))).toBe("8 pcs PL3/8 A36");
    // A custom line is its raw text, which already carries the size, the count ("qty 10"),
    // and the grade; none of them is appended again.
    expect(
      formatRfqLine(
        line({ designation: null, raw_text: "3/8 plate 48x96 qty 10 A36", qty: 10, length_ft: null, length_text: null, grade_spec: "A36", dims: { t: 0.375, w: 48, l: 96 } }),
      ),
    ).toBe("3/8 plate 48x96 qty 10 A36");
  });

  it("uses the raw text for a custom (unlinked) line, collapsed to one line, without repeating a count it opens with", () => {
    const bentPlates = line({
      designation: null,
      raw_text: "  2 bent plates\n 3/8 x 6 x 12 with 2 holes ",
      description: "bent plate",
      qty: 2,
      unit: "pcs",
      length_ft: null,
      length_text: null,
      grade_spec: null,
    });
    expect(formatRfqLine(bentPlates)).toBe("2 bent plates 3/8 x 6 x 12 with 2 holes");
    // A quantity the raw text does not state (the broker changed it on the Review tab) is still written.
    expect(formatRfqLine({ ...bentPlates, qty: 8 })).toBe("8 pcs 2 bent plates 3/8 x 6 x 12 with 2 holes");
  });

  it("writes a custom line's count, length, and grade once, whichever side carries them", () => {
    const custom = (raw_text: string, overrides: Partial<RfqLineView> = {}) =>
      formatRfqLine(line({ designation: null, raw_text, length_ft: null, length_text: null, grade_spec: null, ...overrides }));

    // The recorded fixtures, confirmed as custom: the customer's words already say it all.
    expect(custom("100 pcs 8x8x5/8 HSS, 40' lengths, A500 Gr B, delivered Fort Worth", { qty: 100, length_ft: 40, length_text: "40'", grade_spec: "A500 Gr B" })).toBe(
      "100 pcs 8x8x5/8 HSS, 40' lengths, A500 Gr B, delivered Fort Worth",
    );
    expect(custom("12 inch channel 30# or heavier, 6 pcs at 40 ft", { qty: 6, length_ft: 40, length_text: "40 ft" })).toBe(
      "12 inch channel 30# or heavier, 6 pcs at 40 ft",
    );
    expect(custom("8 square 3/8 x 40 - 20 pcs", { qty: 20, length_ft: 40, length_text: "x 40" })).toBe("8 square 3/8 x 40 - 20 pcs");
    expect(custom('(4) 1/2" x 6" x 12" plates A36, drilled per print', { qty: 4, grade_spec: "A36" })).toBe(
      '(4) 1/2" x 6" x 12" plates A36, drilled per print',
    );
    // A line typed on /requests/new (src/lib/parsing/manual.ts writes "<qty> <unit> <description> x <length> <grade>").
    expect(custom("2 pcs bent plate 3/8 x 6 x 12 x 20' A36", { qty: 2, length_ft: 20, length_text: "20'", grade_spec: "A36" })).toBe(
      "2 pcs bent plate 3/8 x 6 x 12 x 20' A36",
    );
    // A line added on the Review tab (raw text is the description alone): the typed fields are appended.
    expect(custom("bent plate 3/8 x 6 x 12", { qty: 2, length_ft: 20, length_text: "20'", grade_spec: "A36" })).toBe(
      "2 pcs bent plate 3/8 x 6 x 12 x 20' A36",
    );
    expect(custom("some angle for clips", { qty: 12, grade_spec: "A36" })).toBe("12 pcs some angle for clips A36");
    // Only the parts the raw text lacks are appended.
    expect(custom("W12x26 x 50' qty 8", { qty: 8, length_ft: 50, length_text: "50'", grade_spec: "A992" })).toBe("W12x26 x 50' qty 8 A992");
    expect(custom("6 pcs C12x30 A36", { qty: 6, length_ft: 40, length_text: "40'", grade_spec: "A36" })).toBe("6 pcs C12x30 A36 x 40'");
    // Different values are not the same value: a 20 piece order of a 2 inch size writes the 20.
    expect(custom("2 inch pipe sch 40", { qty: 20, unit: "pcs" })).toBe("20 pcs 2 inch pipe sch 40");
    // Curly quotes and case do not hide a match.
    expect(custom("8 Pcs angle 2x2x1/4 x 20\u2019 a36", { qty: 8, length_ft: 20, length_text: "20'", grade_spec: "A36" })).toBe(
      "8 Pcs angle 2x2x1/4 x 20\u2019 a36",
    );
  });

  it("rawTextCarriesQty reads a number as a count only in a count position", () => {
    expect(rawTextCarriesQty("3/8 plate 48x96 qty 10 A36", 10, "pcs")).toBe(true);
    expect(rawTextCarriesQty("Quantity: 10, 3/8 plate", 10, null)).toBe(true);
    expect(rawTextCarriesQty("(4) plates", 4, "pcs")).toBe(true);
    expect(rawTextCarriesQty("6pcs at 40 ft", 6, "pcs")).toBe(true);
    expect(rawTextCarriesQty("40 ft of angle", 40, "ft")).toBe(true);
    expect(rawTextCarriesQty("2 bent plates 3/8 x 6 x 12", 2, "pcs")).toBe(true);
    // Dimensions and sizes are not counts.
    expect(rawTextCarriesQty("3/8 x 6 x 12 plate", 6, "pcs")).toBe(false);
    expect(rawTextCarriesQty("3/8 x 6 x 12 plate", 12, "pcs")).toBe(false);
    expect(rawTextCarriesQty("8 square 3/8 x 40 - 20 pcs", 8, "pcs")).toBe(false);
    expect(rawTextCarriesQty("12 inch channel, 6 pcs", 12, "pcs")).toBe(false);
    expect(rawTextCarriesQty("10 ga sheet 48x96", 10, "pcs")).toBe(false);
    expect(rawTextCarriesQty("1/2 plate", 2, "pcs")).toBe(false);
    expect(rawTextCarriesQty("12 1/2' long bar", 12, "pcs")).toBe(false);
    expect(rawTextCarriesQty("W12x26 x 50'", 26, "pcs")).toBe(false);
    expect(rawTextCarriesQty("plates, qty 100", 10, "pcs")).toBe(false);
  });

  it("rawTextCarriesLength matches the length text or whole feet with a feet marker", () => {
    expect(rawTextCarriesLength("W12x26 x 50' qty 8", { length_ft: 50, length_text: "50'" })).toBe(true);
    expect(rawTextCarriesLength("6 pcs at 40 ft", { length_ft: 40, length_text: null })).toBe(true);
    expect(rawTextCarriesLength("40 feet long", { length_ft: 40, length_text: null })).toBe(true);
    expect(rawTextCarriesLength("8 square 3/8 x 40 - 20 pcs", { length_ft: 40, length_text: "x 40" })).toBe(true);
    expect(rawTextCarriesLength('angle 2x2x1/4 x 480"', { length_ft: 40, length_text: '480"' })).toBe(true);
    expect(rawTextCarriesLength("40'-0\" lengths", { length_ft: 40, length_text: "40'-0\"" })).toBe(true);
    expect(rawTextCarriesLength("40-0 long", { length_ft: 40, length_text: null })).toBe(true);
    // A bare number is not a length, and the sheet size is not a length.
    expect(rawTextCarriesLength("8 square 3/8 x 40 - 20 pcs", { length_ft: 40, length_text: null })).toBe(false);
    expect(rawTextCarriesLength("3/8 plate 48x96", { length_ft: 96, length_text: null })).toBe(false);
    expect(rawTextCarriesLength("W12x26 qty 8", { length_ft: 50, length_text: "50'" })).toBe(false);
    expect(rawTextCarriesLength("anything", { length_ft: null, length_text: null })).toBe(false);
  });

  it("rawTextCarriesGrade matches the grade as whole words, case-insensitive", () => {
    expect(rawTextCarriesGrade("3/8 plate 48x96 qty 10 A36", "A36")).toBe(true);
    expect(rawTextCarriesGrade("8x8x5/8 HSS, a500 gr b, delivered", "A500 Gr B")).toBe(true);
    expect(rawTextCarriesGrade("3/8 plate A36M", "A36")).toBe(false);
    expect(rawTextCarriesGrade("3/8 plate A365", "A36")).toBe(false);
    expect(rawTextCarriesGrade("3/8 plate", "A36")).toBe(false);
    expect(rawTextCarriesGrade("3/8 plate A36", null)).toBe(false);
    expect(rawTextCarriesGrade("3/8 plate A36", "  ")).toBe(false);
  });

  it("falls back to length_text when the length is not a whole number of feet", () => {
    expect(formatRfqLine(line({ length_ft: 20.5417, length_text: `20' 6 1/2"` }))).toBe(`8 pcs W12x26 x 20' 6 1/2" A992`);
    expect(formatRfqLine(line({ length_ft: 12.5, length_text: "12 1/2'" }))).toBe("8 pcs W12x26 x 12 1/2' A992");
  });

  it("strips a leading x from length_text so the x is not doubled", () => {
    expect(formatRfqLine(line({ length_ft: null, length_text: "x 40" }))).toBe("8 pcs W12x26 x 40 A992");
    expect(formatRfqLength({ length_ft: null, length_text: "X 24'" })).toBe("x 24'");
  });

  it("writes decimal feet when only a fractional length_ft is known", () => {
    expect(formatRfqLength({ length_ft: 12.5, length_text: null })).toBe("x 12.5'");
  });

  it("writes nothing for the length when neither half is known", () => {
    expect(formatRfqLength({ length_ft: null, length_text: null })).toBeNull();
    expect(formatRfqLine(line({ length_ft: null, length_text: null }))).toBe("8 pcs W12x26 A992");
  });

  it("writes the quantity without a unit when the unit is unknown, and no quantity when it is missing", () => {
    expect(formatRfqLine(line({ unit: null }))).toBe("8 W12x26 x 50' A992");
    expect(formatRfqLine(line({ qty: null }))).toBe("W12x26 x 50' A992");
    expect(formatRfqLine(line({ qty: null, unit: null }))).toBe("W12x26 x 50' A992");
  });

  it("writes fractional and whole quantities plainly", () => {
    expect(formatRfqLine(line({ qty: 12.5, unit: "tons", designation: "#4 rebar", length_ft: null, length_text: null, grade_spec: null }))).toBe(
      "12.5 tons #4 rebar",
    );
    expect(formatRfqLine(line({ qty: 1000, unit: "lbs" }))).toBe("1000 lbs W12x26 x 50' A992");
  });

  it("puts the note in parentheses, and joins the RFQ note with the customer's delivery note", () => {
    expect(formatRfqLine(line({ note: "cut to 20'" }))).toBe("8 pcs W12x26 x 50' A992 (cut to 20')");
    expect(formatRfqLine(line({ delivery_notes: "deliver to Waco" }))).toBe("8 pcs W12x26 x 50' A992 (deliver to Waco)");
    expect(formatRfqLine(line({ note: "cut to 20'", delivery_notes: "deliver to Waco" }))).toBe(
      "8 pcs W12x26 x 50' A992 (cut to 20'; deliver to Waco)",
    );
    expect(formatRfqLine(line({ note: "  ", delivery_notes: "" }))).toBe("8 pcs W12x26 x 50' A992");
  });
});

describe("formatSheetSize", () => {
  it("reads w and l as numbers or numeric strings, in inches", () => {
    expect(formatSheetSize({ t: 0.375, w: 48, l: 96 })).toBe("48x96");
    expect(formatSheetSize({ w: "60", l: "120" })).toBe("60x120");
    expect(formatSheetSize({ w: 48.5, l: 96 })).toBe("48.5x96");
  });

  it("is null when either side is missing, zero, negative, or not a number, or when dims is not an object", () => {
    expect(formatSheetSize({ w: 48 })).toBeNull();
    expect(formatSheetSize({ l: 96 })).toBeNull();
    expect(formatSheetSize({ w: 0, l: 96 })).toBeNull();
    expect(formatSheetSize({ w: -48, l: 96 })).toBeNull();
    expect(formatSheetSize({ w: "wide", l: 96 })).toBeNull();
    expect(formatSheetSize({ w: "", l: 96 })).toBeNull();
    expect(formatSheetSize({})).toBeNull();
    expect(formatSheetSize(null)).toBeNull();
    expect(formatSheetSize(undefined)).toBeNull();
    expect(formatSheetSize([48, 96] as unknown as { [key: string]: unknown })).toBeNull();
  });
});

describe("rfqBody (AC-7.2, AC-7.3)", () => {
  const lines = [
    line(),
    line({ designation: "L2x2x1/4", qty: 40, length_ft: 20, length_text: "20'", grade_spec: null }),
  ];

  it("writes the full shape with a first name, the customer, and delivery requirements", () => {
    const body = rfqBody({
      contactFirstName: "Marcus",
      lines,
      customerName: "Lone Star Fabrication",
      includeCustomerName: true,
      deliveryRequirements: "Job site in Waco, liftgate.",
      senderName: "Caleb",
    });
    expect(body).toBe(
      [
        "Hi Marcus,",
        "Need pricing and availability on the below, for Lone Star Fabrication.",
        "",
        "8 pcs W12x26 x 50' A992",
        "40 pcs L2x2x1/4 x 20'",
        "",
        "Delivery: Job site in Waco, liftgate.",
        "Let me know what you can do.",
        "",
        "Caleb",
      ].join("\n"),
    );
  });

  it("leaves the customer out unless the toggle is on", () => {
    const body = rfqBody({
      contactFirstName: "Marcus",
      lines,
      customerName: "Lone Star Fabrication",
      includeCustomerName: false,
      deliveryRequirements: null,
      senderName: "Caleb",
    });
    expect(body).toBe(
      [
        "Hi Marcus,",
        "Need pricing and availability on the below.",
        "",
        "8 pcs W12x26 x 50' A992",
        "40 pcs L2x2x1/4 x 20'",
        "",
        "Let me know what you can do.",
        "",
        "Caleb",
      ].join("\n"),
    );
    expect(body).not.toContain("Lone Star");
  });

  it("names no customer when the toggle is on but no customer is known", () => {
    const body = rfqBody({
      contactFirstName: null,
      lines: [line()],
      customerName: null,
      includeCustomerName: true,
      deliveryRequirements: "   ",
      senderName: "Caleb",
    });
    expect(body.split("\n")).toEqual([
      "Hi,",
      "Need pricing and availability on the below.",
      "",
      "8 pcs W12x26 x 50' A992",
      "",
      "Let me know what you can do.",
      "",
      "Caleb",
    ]);
  });

  it("greets without a name when the contact has none", () => {
    expect(
      rfqBody({
        contactFirstName: "  ",
        lines: [],
        customerName: null,
        includeCustomerName: false,
        deliveryRequirements: null,
        senderName: "Caleb",
      }).split("\n")[0],
    ).toBe("Hi,");
  });

  it("writes plain text with no em dash and no marketing", () => {
    const body = rfqBody({
      contactFirstName: "Marcus",
      lines,
      customerName: "Lone Star Fabrication",
      includeCustomerName: true,
      deliveryRequirements: "Deliver to Waco",
      senderName: "Caleb",
    });
    const subject = rfqSubject({ customerShortName: "Lone Star", itemCount: 2, date: DATE });
    for (const text of [body, subject, ...lines.map(formatRfqLine)]) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toMatch(/<[a-z]+>/i);
    }
    expect(body).not.toMatch(/hope this|I hope|excited|thrilled|pleased to/i);
  });
});

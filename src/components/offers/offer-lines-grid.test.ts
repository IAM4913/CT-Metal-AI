import { describe, expect, it } from "vitest";
import { parseIsoDate, parsePositiveNumber, readOfferLineAddInput, toggleAlternateType, type OfferRequestLine } from "./offer-lines-grid";

const LINE_1 = "11111111-1111-4111-8111-000000000001";
const LINE_2 = "11111111-1111-4111-8111-000000000002";

const REQUEST_LINES: OfferRequestLine[] = [
  { id: LINE_1, line_no: 1, description: "HSS8x8x3/8", qty: 20, unit: "pcs" },
  { id: LINE_2, line_no: 2, description: "C12x30", qty: 6, unit: "pcs" },
];

const BLANK = {
  requestLineId: LINE_1,
  offeredDesc: "8x8x1/2",
  availableQty: "",
  unit: "",
  availability: "",
  readyDate: "",
  deliveryEstimateText: "",
  unitPrice: "",
  priceBasis: "",
};

describe("readOfferLineAddInput", () => {
  it("builds a line from the typed fields, nulls for blanks, and no alternate types on an exact line", () => {
    expect(readOfferLineAddInput(BLANK, REQUEST_LINES, true, ["wall"])).toEqual({
      value: {
        requestLineId: LINE_1,
        offeredDesc: "8x8x1/2",
        isExactMatch: true,
        alternateTypes: [],
        availableQty: null,
        unit: null,
        availability: "unknown",
        readyDate: null,
        deliveryEstimateText: null,
        unitPrice: null,
        priceBasis: null,
      },
    });
  });

  it("reads every field and keeps the alternate types of an alternate line in enum order", () => {
    const result = readOfferLineAddInput(
      {
        requestLineId: LINE_2,
        offeredDesc: "  C12x30 40'  ",
        availableQty: "6",
        unit: "pcs",
        availability: "rolling",
        readyDate: "2026-11-17",
        deliveryEstimateText: " two trucks ",
        unitPrice: "$58.00",
        priceBasis: "per_cwt",
      },
      REQUEST_LINES,
      false,
      ["wall", "grade"],
    );
    expect(result).toEqual({
      value: {
        requestLineId: LINE_2,
        offeredDesc: "C12x30 40'",
        isExactMatch: false,
        alternateTypes: ["grade", "wall"],
        availableQty: 6,
        unit: "pcs",
        availability: "rolling",
        readyDate: "2026-11-17",
        deliveryEstimateText: "two trucks",
        unitPrice: 58,
        priceBasis: "per_cwt",
      },
    });
  });

  it("names the first problem instead of guessing", () => {
    expect(readOfferLineAddInput({ ...BLANK, requestLineId: "" }, REQUEST_LINES, true, [])).toEqual({ error: "Pick the request line this offer answers." });
    expect(readOfferLineAddInput({ ...BLANK, requestLineId: "99999999-9999-4999-8999-999999999999" }, REQUEST_LINES, true, [])).toHaveProperty("error");
    expect(readOfferLineAddInput({ ...BLANK, offeredDesc: "   " }, REQUEST_LINES, true, [])).toEqual({ error: "The offered item cannot be blank." });
    expect(readOfferLineAddInput({ ...BLANK, availableQty: "0" }, REQUEST_LINES, true, [])).toEqual({ error: "Available quantity: Enter a positive number, or leave blank." });
    expect(readOfferLineAddInput({ ...BLANK, unitPrice: "call" }, REQUEST_LINES, true, [])).toEqual({ error: "Unit price: Enter a positive number, or leave blank." });
    expect(readOfferLineAddInput({ ...BLANK, readyDate: "11/17" }, REQUEST_LINES, true, [])).toEqual({ error: "Ready date: Enter a date as yyyy-mm-dd, or leave blank." });
  });

  it("drops an unknown unit, basis, or availability word rather than failing", () => {
    const result = readOfferLineAddInput({ ...BLANK, unit: "bundles", priceBasis: "per_box", availability: "maybe" }, REQUEST_LINES, true, []);
    expect(result).toMatchObject({ value: { unit: null, priceBasis: null, availability: "unknown" } });
  });
});

describe("cell parsers", () => {
  it("parsePositiveNumber reads a price with a dollar sign and refuses zero or words", () => {
    expect(parsePositiveNumber("$1,250")).toEqual({ value: 1250 });
    expect(parsePositiveNumber("")).toEqual({ value: null });
    expect(parsePositiveNumber("0")).toHaveProperty("error");
    expect(parsePositiveNumber("tbd")).toHaveProperty("error");
  });

  it("parseIsoDate takes yyyy-MM-dd only", () => {
    expect(parseIsoDate("2026-11-17")).toEqual({ value: "2026-11-17" });
    expect(parseIsoDate(" ")).toEqual({ value: null });
    expect(parseIsoDate("Nov 17")).toHaveProperty("error");
  });

  it("toggleAlternateType keeps the enum order", () => {
    expect(toggleAlternateType([], "wall")).toEqual(["wall"]);
    expect(toggleAlternateType(["wall"], "grade")).toEqual(["grade", "wall"]);
    expect(toggleAlternateType(["grade", "wall"], "wall")).toEqual(["grade"]);
  });
});

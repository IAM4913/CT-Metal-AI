import { describe, expect, it } from "vitest";
import { parseLengthFt } from "./length";

describe("parseLengthFt: feet", () => {
  it.each([
    ["40'", 40],
    ["40 ft", 40],
    ["40ft", 40],
    ["40 ft.", 40],
    ["40 feet", 40],
    ["40 foot", 40],
    ["40 lf", 40],
    ["40 FT", 40],
    ["40’", 40],
    ["40 ′", 40],
  ])("%s -> %d", (text, expected) => {
    expect(parseLengthFt(text)).toBe(expected);
  });
});

describe("parseLengthFt: feet and inches", () => {
  it.each([
    ["40-0", 40],
    ["40'-0\"", 40],
    ["40' 0\"", 40],
    ["40'0", 40],
    ["20'6\"", 20.5],
    ["20'-6\"", 20.5],
    ["20' 6\"", 20.5],
    ["20 ft 6 in", 20.5],
    ["20-6", 20.5],
    ["20'-6''", 20.5],
    ["20'-6-1/2\"", 20.5417],
    ["20'-3\"", 20.25],
    ["20'-1⁄2\"", 20.0417],
    ["20'-.5\"", 20.0417],
  ])("%s -> %d", (text, expected) => {
    expect(parseLengthFt(text)).toBe(expected);
  });
});

describe("parseLengthFt: inches", () => {
  it.each([
    ['480"', 40],
    ["480 in", 40],
    ["480in", 40],
    ["480 in.", 40],
    ["480 inches", 40],
    ["240”", 20],
    ['6"', 0.5],
  ])("%s -> %d", (text, expected) => {
    expect(parseLengthFt(text)).toBe(expected);
  });
});

describe("parseLengthFt: bare numbers and fractions", () => {
  it.each([
    ["24", 24],
    ["24.5", 24.5],
    [" 24 ", 24],
    ["12-1/2'", 12.5],
    ["12-1/2", 12.5],
    ["12 1/2'", 12.5],
    ["12½'", 12.5],
    ["1/2'", 0.5],
    ["40.0'", 40],
    ["12 1⁄2'", 12.5],
    ["12-1⁄2'", 12.5],
    ["1⁄2'", 0.5],
    [".5'", 0.5],
    [".5", 0.5],
    ['6.5"', 0.5417],
  ])("%s -> %d", (text, expected) => {
    expect(parseLengthFt(text)).toBe(expected);
  });
});

describe("parseLengthFt: surrounding words", () => {
  it.each([
    ["x 40'", 40],
    ["X 50'", 50],
    ["@ 40'", 40],
    ["at 40 ft", 40],
    ["40' lengths", 40],
    ["40' length", 40],
    ["40 ft long", 40],
    ["40' ea", 40],
    ["40' each", 40],
  ])("%s -> %d", (text, expected) => {
    expect(parseLengthFt(text)).toBe(expected);
  });
});

describe("parseLengthFt: returns null instead of guessing", () => {
  it.each([
    [""],
    ["   "],
    ["random"],
    ["random lengths"],
    ["x"],
    ["stock"],
    ["TBD"],
    ["40' x 20'"],
    ["40' or 48'"],
    ["40 - 20"],
    ["40-14"],
    ["6 m"],
    ["12 mm"],
    ["3 yd"],
    ["40 ft and 6 m"],
    ["48x96"],
    ["0"],
    ["0'"],
    ["-40'"],
    ["40'-"],
    ["12.5-1/2'"],
    ["1/0'"],
    ["40 pcs"],
    ["40' 8 pcs"],
  ])("%s -> null", (text) => {
    expect(parseLengthFt(text)).toBeNull();
  });

  it("handles null and undefined", () => {
    expect(parseLengthFt(null)).toBeNull();
    expect(parseLengthFt(undefined)).toBeNull();
  });

  it("never throws on odd input", () => {
    for (const text of ["'", '"', "-", "''", "ft", "in", "' \"", "1'2'3", "½½"]) {
      expect(() => parseLengthFt(text)).not.toThrow();
    }
  });
});

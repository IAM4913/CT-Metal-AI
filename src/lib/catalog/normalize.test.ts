import { describe, expect, it } from "vitest";
import { formatFraction, normalizeAlias, parseFraction } from "./normalize";

describe("normalizeAlias", () => {
  it("handles every PRD AC-4.3 example", () => {
    expect(normalizeAlias("8 square 5/8")).toBe("8 sq 5/8");
    expect(normalizeAlias("8x8x5/8 tube")).toBe("8x8x5/8 hss");
    expect(normalizeAlias('8" sq tube 5/8 wall')).toBe("8 sq hss 5/8 wall");
    expect(normalizeAlias("12 inch channel 30#")).toBe("12 channel 30 lb");
    expect(normalizeAlias("2x2x1/4 angle")).toBe("2x2x1/4 angle");
    expect(normalizeAlias("3/8 plate")).toBe("3/8 plate");
  });

  it("lowercases and collapses whitespace", () => {
    expect(normalizeAlias("  HSS8x8x5/8  ")).toBe("hss8x8x5/8");
    expect(normalizeAlias("8   Square\t5/8")).toBe("8 sq 5/8");
    expect(normalizeAlias("")).toBe("");
    expect(normalizeAlias("   ")).toBe("");
  });

  it("collapses every multiplication form between numbers to a bare x", () => {
    expect(normalizeAlias("8 x 8 x 5/8")).toBe("8x8x5/8");
    expect(normalizeAlias("8X8X5/8")).toBe("8x8x5/8");
    expect(normalizeAlias("8 by 8 by 5/8")).toBe("8x8x5/8");
    expect(normalizeAlias("8×8×5/8")).toBe("8x8x5/8");
    expect(normalizeAlias("w12 x 26")).toBe("w12x26");
    expect(normalizeAlias("W12X26")).toBe("w12x26");
    expect(normalizeAlias("2 x .154 pipe")).toBe("2x.154 pipe");
    expect(normalizeAlias("plate 48 x 96")).toBe("plate 48x96");
  });

  it("does not treat x inside a word as multiplication", () => {
    expect(normalizeAlias("2 xs pipe")).toBe("2 xs pipe");
    expect(normalizeAlias("2 xxs pipe")).toBe("2 xxs pipe");
  });

  it("drops inch markers", () => {
    expect(normalizeAlias('8"x8"x5/8"')).toBe("8x8x5/8");
    expect(normalizeAlias("8”x8”x5/8”")).toBe("8x8x5/8");
    expect(normalizeAlias("8″ sq tube")).toBe("8 sq hss");
    expect(normalizeAlias("8 in x 8 in x 5/8 in")).toBe("8x8x5/8");
    expect(normalizeAlias("12 inch channel")).toBe("12 channel");
    expect(normalizeAlias("12 inches channel")).toBe("12 channel");
    expect(normalizeAlias("8 in. channel")).toBe("8 channel");
    expect(normalizeAlias('6" sq 3/8')).toBe("6 sq 3/8");
    expect(normalizeAlias('2" sch 40 pipe')).toBe("2 sch 40 pipe");
  });

  it("maps weight markers to a spaced lb", () => {
    expect(normalizeAlias("30#")).toBe("30 lb");
    expect(normalizeAlias("30 #")).toBe("30 lb");
    expect(normalizeAlias("30 lb")).toBe("30 lb");
    expect(normalizeAlias("30lb")).toBe("30 lb");
    expect(normalizeAlias("30lbs")).toBe("30 lb");
    expect(normalizeAlias("30 lbs")).toBe("30 lb");
    expect(normalizeAlias("30 pound")).toBe("30 lb");
    expect(normalizeAlias("30 pounds")).toBe("30 lb");
    expect(normalizeAlias("12 channel 30#")).toBe("12 channel 30 lb");
  });

  it("treats a # before a number as a bar number, not a weight", () => {
    expect(normalizeAlias("REBAR#4")).toBe("rebar 4");
    expect(normalizeAlias("#4 rebar")).toBe("4 rebar");
  });

  it("maps shape words to canonical tokens", () => {
    expect(normalizeAlias("8 sq 5/8")).toBe("8 sq 5/8");
    expect(normalizeAlias("8 square 5/8")).toBe("8 sq 5/8");
    expect(normalizeAlias("8x8x5/8 tubing")).toBe("8x8x5/8 hss");
    expect(normalizeAlias("8x8x5/8 HSS")).toBe("8x8x5/8 hss");
    expect(normalizeAlias("8x8 5/8 wl")).toBe("8x8 5/8 wall");
    expect(normalizeAlias("3/8 PL")).toBe("3/8 plate");
    expect(normalizeAlias("3/8 plt")).toBe("3/8 plate");
    expect(normalizeAlias("2x2x1/4 L")).toBe("2x2x1/4 angle");
    expect(normalizeAlias("2x2x1/4 ang")).toBe("2x2x1/4 angle");
    expect(normalizeAlias("12x30 C")).toBe("12x30 channel");
    expect(normalizeAlias("12x30 chan")).toBe("12x30 channel");
    expect(normalizeAlias("12x26 WF")).toBe("12x26 beam");
    expect(normalizeAlias("12x26 W")).toBe("12x26 beam");
    expect(normalizeAlias("1 round bar")).toBe("1 rd bar");
    expect(normalizeAlias("1 rnd bar")).toBe("1 rd bar");
    expect(normalizeAlias("16 gauge sheet")).toBe("16 ga sheet");
    expect(normalizeAlias("16 gage sheet")).toBe("16 ga sheet");
    expect(normalizeAlias("2 schedule 40 pipe")).toBe("2 sch 40 pipe");
  });

  it("leaves letters glued to digits alone so designations survive", () => {
    expect(normalizeAlias("L2x2x1/4")).toBe("l2x2x1/4");
    expect(normalizeAlias("C12x30")).toBe("c12x30");
    expect(normalizeAlias("MC12x31")).toBe("mc12x31");
    expect(normalizeAlias("W12x26")).toBe("w12x26");
    expect(normalizeAlias("PL3/8")).toBe("pl3/8");
    expect(normalizeAlias("HSS8x8x5/8")).toBe("hss8x8x5/8");
    expect(normalizeAlias("PIPE1-1/2STD")).toBe("pipe1-1/2std");
    expect(normalizeAlias("FB1/4x2")).toBe("fb1/4x2");
    expect(normalizeAlias("SH16GA")).toBe("sh16ga");
    expect(normalizeAlias("A500 Gr B")).toBe("a500 gr b");
  });

  it("strips punctuation except fraction, mixed number, and decimal characters", () => {
    expect(normalizeAlias("8x8x5/8, tube.")).toBe("8x8x5/8 hss");
    expect(normalizeAlias("1-1/2 pipe")).toBe("1-1/2 pipe");
    expect(normalizeAlias("S12x31.8")).toBe("s12x31.8");
    expect(normalizeAlias(".375 plate")).toBe(".375 plate");
    expect(normalizeAlias("0.375 plate")).toBe("0.375 plate");
    expect(normalizeAlias("40'")).toBe("40");
    expect(normalizeAlias("(8x8x5/8)")).toBe("8x8x5/8");
    expect(normalizeAlias("sch. 40")).toBe("sch 40");
    expect(normalizeAlias("8x8x5/8 - tube")).toBe("8x8x5/8 hss");
  });

  it("drops an abbreviation point before a digit but keeps a decimal point after x", () => {
    expect(normalizeAlias("No.4 rebar")).toBe("no 4 rebar");
    expect(normalizeAlias("no.4 rebar")).toBe("no 4 rebar");
    expect(normalizeAlias('2" sch.40 pipe')).toBe("2 sch 40 pipe");
    expect(normalizeAlias("Sch.80")).toBe("sch 80");
    // Decimals keep their point whether the previous character is a digit, a
    // space, nothing, or the times x.
    expect(normalizeAlias("8x8x.625")).toBe("8x8x.625");
    expect(normalizeAlias("hss6x.25")).toBe("hss6x.25");
    expect(normalizeAlias("2x.154 pipe")).toBe("2x.154 pipe");
    expect(normalizeAlias("1x.5 flat bar")).toBe("1x.5 flat bar");
    expect(normalizeAlias("S12x31.8")).toBe("s12x31.8");
    expect(normalizeAlias(".375 plate")).toBe(".375 plate");
    expect(normalizeAlias("0.375 plate")).toBe("0.375 plate");
  });

  it("expands Unicode vulgar fractions instead of dropping them", () => {
    // Outlook and Word AutoCorrect substitute these for 1/2, 1/4, 3/4 by default.
    expect(normalizeAlias("1½ pipe std")).toBe("1-1/2 pipe std");
    expect(normalizeAlias("1 ½ pipe std")).toBe("1-1/2 pipe std");
    expect(normalizeAlias("1-½ round bar")).toBe("1-1/2 rd bar");
    expect(normalizeAlias('1½" pipe std')).toBe("1-1/2 pipe std");
    expect(normalizeAlias("8x8x½ tube")).toBe("8x8x1/2 hss");
    expect(normalizeAlias("8x8x⅝ tube")).toBe("8x8x5/8 hss");
    expect(normalizeAlias("8x8 ½ wall")).toBe("8x8 1/2 wall");
    expect(normalizeAlias("⅜ plate")).toBe("3/8 plate");
    expect(normalizeAlias("¼ x 2 flat bar")).toBe("1/4x2 flat bar");
    expect(normalizeAlias("2½x2½x¼ angle")).toBe("2-1/2x2-1/2x1/4 angle");
    expect(normalizeAlias("⅛ ⅓ ⅔ ⅞")).toBe("1/8 1/3 2/3 7/8");
    // The fraction slash U+2044 is a plain slash.
    expect(normalizeAlias("5\u20448 plate")).toBe("5/8 plate");
  });

  it("canonicalizes a standalone spaced mixed number but not one inside an x chain", () => {
    expect(normalizeAlias("1 1/2 pipe std")).toBe("1-1/2 pipe std");
    expect(normalizeAlias("pipe 1 1/2 std")).toBe("pipe 1-1/2 std");
    expect(normalizeAlias("8x8 5/8 wall")).toBe("8x8 5/8 wall");
    expect(normalizeAlias("2 1/2 x 2 1/2 x 1/4 angle")).toBe("2 1/2x2 1/2x1/4 angle");
    expect(normalizeAlias("2-1/2 x 2-1/2 x 1/4 angle")).toBe("2-1/2x2-1/2x1/4 angle");
  });

  it("is idempotent", () => {
    const samples = [
      "8 square 5/8",
      '8" sq tube 5/8 wall',
      "12 inch channel 30#",
      "2 x 2 x 1/4 L",
      "1 1/2 pipe std",
      "30lbs",
      "W12 X 26",
      "REBAR#4",
      "2 x .154 pipe",
      "S12x31.8",
      "8 by 8 by 5/8 wall",
      "1½ pipe std",
      "8x8x⅝ tube",
      "2½x2½x¼ angle",
      "No.4 rebar",
      '2" sch.40 pipe',
    ];
    for (const s of samples) {
      const once = normalizeAlias(s);
      expect(normalizeAlias(once)).toBe(once);
    }
  });
});

describe("parseFraction", () => {
  it("parses fractions, mixed numbers, decimals, and whole numbers", () => {
    expect(parseFraction("5/8")).toBe(0.625);
    expect(parseFraction("1-1/2")).toBe(1.5);
    expect(parseFraction("1 1/2")).toBe(1.5);
    expect(parseFraction("1/2")).toBe(0.5);
    expect(parseFraction("0.25")).toBe(0.25);
    expect(parseFraction(".375")).toBe(0.375);
    expect(parseFraction("3")).toBe(3);
    expect(parseFraction("3.0")).toBe(3);
    expect(parseFraction("3/16")).toBe(0.1875);
    expect(parseFraction("2-1/2")).toBe(2.5);
    expect(parseFraction("10/16")).toBe(0.625);
  });

  it("tolerates surrounding whitespace and one trailing inch marker", () => {
    expect(parseFraction("  5/8  ")).toBe(0.625);
    expect(parseFraction('5/8"')).toBe(0.625);
    expect(parseFraction("5/8”")).toBe(0.625);
    expect(parseFraction("1-1/2 in")).toBe(1.5);
    expect(parseFraction("3 inch")).toBe(3);
    expect(parseFraction("3 inches")).toBe(3);
    expect(parseFraction("3 in.")).toBe(3);
    expect(parseFraction('1 1/2 "')).toBe(1.5);
  });

  it("accepts Unicode vulgar fractions in every position a fraction can take", () => {
    expect(parseFraction("½")).toBe(0.5);
    expect(parseFraction("1½")).toBe(1.5);
    expect(parseFraction("1 ½")).toBe(1.5);
    expect(parseFraction("1-½")).toBe(1.5);
    expect(parseFraction('⅝"')).toBe(0.625);
    expect(parseFraction("2¾ in")).toBe(2.75);
    expect(parseFraction("⅜")).toBe(0.375);
    expect(parseFraction("⅓")).toBeCloseTo(1 / 3, 12);
    expect(parseFraction("5\u20448")).toBe(0.625);
    // Two glyphs in a row are not a dimension.
    expect(parseFraction("½½")).toBeNull();
    expect(parseFraction("1½½")).toBeNull();
  });

  it("returns null for anything that is not an inch dimension", () => {
    expect(parseFraction("")).toBeNull();
    expect(parseFraction("   ")).toBeNull();
    expect(parseFraction("abc")).toBeNull();
    expect(parseFraction("1/0")).toBeNull();
    expect(parseFraction("1-1/0")).toBeNull();
    expect(parseFraction("-1/2")).toBeNull();
    expect(parseFraction("40'")).toBeNull();
    expect(parseFraction("40 ft")).toBeNull();
    expect(parseFraction("1/2/3")).toBeNull();
    expect(parseFraction("1-")).toBeNull();
    expect(parseFraction("5/8 wall")).toBeNull();
    expect(parseFraction("3/8 plate")).toBeNull();
    expect(parseFraction("1,000")).toBeNull();
    expect(parseFraction("+3")).toBeNull();
    expect(parseFraction("3 1/2 1/4")).toBeNull();
  });

  it("never throws on odd input", () => {
    // Callers pass strings, but a value that slipped through a boundary should
    // degrade to null rather than crash the parser.
    expect(parseFraction(undefined as unknown as string)).toBeNull();
    expect(parseFraction(null as unknown as string)).toBeNull();
    expect(parseFraction(5 as unknown as string)).toBeNull();
  });
});

describe("formatFraction", () => {
  it("formats the common sixteenths", () => {
    expect(formatFraction(0.625)).toBe("5/8");
    expect(formatFraction(1.5)).toBe("1-1/2");
    expect(formatFraction(0.375)).toBe("3/8");
    expect(formatFraction(0.0625)).toBe("1/16");
    expect(formatFraction(0.1875)).toBe("3/16");
    expect(formatFraction(0.25)).toBe("1/4");
    expect(formatFraction(0.3125)).toBe("5/16");
    expect(formatFraction(0.5)).toBe("1/2");
    expect(formatFraction(0.75)).toBe("3/4");
    expect(formatFraction(0.875)).toBe("7/8");
    expect(formatFraction(1.25)).toBe("1-1/4");
    expect(formatFraction(2.5)).toBe("2-1/2");
    expect(formatFraction(1.125)).toBe("1-1/8");
  });

  it("leaves whole numbers unchanged", () => {
    expect(formatFraction(8)).toBe("8");
    expect(formatFraction(1)).toBe("1");
    expect(formatFraction(0)).toBe("0");
    expect(formatFraction(12)).toBe("12");
  });

  it("falls back to a trimmed decimal", () => {
    expect(formatFraction(0.154)).toBe("0.154");
    expect(formatFraction(31.8)).toBe("31.8");
    expect(formatFraction(0.1345)).toBe("0.1345");
    expect(formatFraction(5.7)).toBe("5.7");
    expect(formatFraction(1.128)).toBe("1.128");
  });

  it("round-trips through parseFraction for every sixteenth up to 12 inches", () => {
    for (let k = 0; k <= 12 * 16; k++) {
      const n = k / 16;
      expect(parseFraction(formatFraction(n))).toBe(n);
    }
  });
});

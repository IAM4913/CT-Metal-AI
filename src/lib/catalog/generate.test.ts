import { describe, expect, it } from "vitest";
import { materialCategoryValues, type MaterialCategory } from "@/lib/db/enums";
import {
  angleWeight,
  buildAliasIndex,
  findAliasCollisions,
  findItemByAlias,
  flatBarWeight,
  generateCatalog,
  hssRectWeight,
  hssRoundWeight,
  pipeWeight,
  plateWeightPerSqft,
  roundBarWeight,
  squareBarWeight,
  type CatalogSeedItem,
} from "./generate";
import { formatFraction, normalizeAlias } from "./normalize";

const items = generateCatalog();
const EM_DASH = String.fromCharCode(0x2014);
const byDesignation = new Map(items.map((i) => [i.designation, i]));

function get(designation: string): CatalogSeedItem {
  const found = byDesignation.get(designation);
  if (!found) throw new Error(`catalog is missing ${designation}`);
  return found;
}

function expectWithinOnePercent(actual: number | null, published: number): void {
  expect(actual).not.toBeNull();
  const diff = Math.abs((actual as number) - published) / published;
  expect(diff).toBeLessThan(0.01);
}

describe("generateCatalog: shape", () => {
  it("produces a few hundred items across every AC-4.1 category", () => {
    expect(items.length).toBeGreaterThan(300);
    const categories = new Set(items.map((i) => i.category));
    for (const c of materialCategoryValues) expect(categories.has(c)).toBe(true);
  });

  it("uses only database categories", () => {
    const allowed = new Set<string>(materialCategoryValues);
    for (const it of items) expect(allowed.has(it.category)).toBe(true);
  });

  it("has unique designations", () => {
    expect(new Set(items.map((i) => i.designation)).size).toBe(items.length);
  });

  it("follows the canonical designation format per category", () => {
    const patterns: Record<MaterialCategory, RegExp> = {
      hss_square: /^HSS[\d/-]+x[\d/-]+x[\d/-]+$/,
      hss_rectangular: /^HSS[\d/-]+x[\d/-]+x[\d/-]+$/,
      hss_round: /^HSS\d+x[\d/-]+$/,
      pipe: /^PIPE[\d/-]+(STD|XS|XXS)$/,
      w_beam: /^W\d+x\d+$/,
      s_beam: /^S\d+x[\d.]+$/,
      channel: /^M?C\d+x[\d.]+$/,
      angle: /^L[\d/-]+x[\d/-]+x[\d/-]+$/,
      flat_bar: /^FB[\d/-]+x[\d/-]+$/,
      round_bar: /^RB[\d/-]+$/,
      square_bar: /^SQ[\d/-]+$/,
      plate: /^PL[\d/-]+$/,
      sheet: /^SH\d+GA$/,
      rebar: /^REBAR#\d+$/,
    };
    for (const it of items) {
      expect(it.designation, `${it.designation} (${it.category})`).toMatch(patterns[it.category]);
    }
  });

  it("writes mixed numbers with a hyphen and never an em dash", () => {
    expect(byDesignation.has("HSS2-1/2x2-1/2x1/4")).toBe(true);
    expect(byDesignation.has("PIPE1-1/2STD")).toBe(true);
    expect(byDesignation.has("RB1-1/2")).toBe(true);
    for (const it of items) {
      expect(it.designation).not.toContain(EM_DASH);
      for (const a of it.aliases) expect(a).not.toContain(EM_DASH);
    }
  });

  it("puts the longer leg or side first", () => {
    for (const it of items) {
      if (it.category === "angle" || it.category === "hss_rectangular") {
        expect(it.dims.a as number).toBeGreaterThanOrEqual(it.dims.b as number);
      }
      if (it.category === "flat_bar") {
        expect(it.dims.w as number).toBeGreaterThan(it.dims.t as number);
      }
    }
  });

  it("contains every item the fixtures name", () => {
    for (const d of [
      "HSS8x8x5/8",
      "HSS8x8x3/8",
      "HSS8x8x1/2",
      "HSS6x6x3/8",
      "HSS4x4x1/4",
      "C12x30",
      "W12x26",
      "W8x18",
      "L2x2x1/4",
      "L3x3x1/4",
      "PL3/8",
      "PL1/2",
      "PIPE2STD",
    ]) {
      expect(byDesignation.has(d), d).toBe(true);
    }
  });
});

describe("generateCatalog: aliases", () => {
  it("stores every alias already normalized (idempotent under normalizeAlias)", () => {
    for (const it of items) {
      for (const a of it.aliases) {
        expect(a).not.toBe("");
        expect(normalizeAlias(a)).toBe(a);
      }
    }
  });

  it("dedupes aliases within an item", () => {
    for (const it of items) {
      expect(new Set(it.aliases).size).toBe(it.aliases.length);
    }
  });

  it("always includes the lowercased designation as an alias", () => {
    for (const it of items) {
      expect(it.aliases).toContain(normalizeAlias(it.designation));
    }
  });

  it("never maps one normalized alias to two items", () => {
    expect(findAliasCollisions(items)).toEqual([]);
  });

  it("gives every item at least a handful of aliases", () => {
    for (const it of items) expect(it.aliases.length).toBeGreaterThanOrEqual(4);
  });

  it("buildAliasIndex covers every alias", () => {
    const index = buildAliasIndex(items);
    const total = items.reduce((n, i) => n + i.aliases.length, 0);
    expect(index.size).toBe(total);
  });
});

describe("findItemByAlias", () => {
  const expectResolves = (text: string, designation: string) => {
    expect(findItemByAlias(items, text)?.designation, text).toBe(designation);
  };

  it("resolves every PRD AC-4.3 example", () => {
    expectResolves("8 square 5/8", "HSS8x8x5/8");
    expectResolves("8x8x5/8 tube", "HSS8x8x5/8");
    expectResolves('8" sq tube 5/8 wall', "HSS8x8x5/8");
    expectResolves("12 inch channel 30#", "C12x30");
    expectResolves("2x2x1/4 angle", "L2x2x1/4");
    expectResolves("3/8 plate", "PL3/8");
  });

  it("resolves the PRD section 14 alias list for HSS8x8x5/8", () => {
    for (const text of ["8x8x5/8", "8 square 5/8", "8 sq 5/8", '8" sq tube 5/8', "8x8 5/8 wall", "8 square 5/8 wall"]) {
      expectResolves(text, "HSS8x8x5/8");
    }
    for (const text of ["hss8x8x5/8", "8x8x5/8 tube", "8x8x5/8 hss", "8 sq tube 5/8 wall", "8x8x.625", "8x8x0.625"]) {
      expectResolves(text, "HSS8x8x5/8");
    }
  });

  it("resolves the fixture phrases", () => {
    expectResolves('6" sq 3/8', "HSS6x6x3/8");
    expectResolves("8 square 3/8", "HSS8x8x3/8");
    expectResolves("8x8x1/2", "HSS8x8x1/2");
    expectResolves("W12x26", "W12x26");
    expectResolves("w12 x 26", "W12x26");
    expectResolves("3/8 plate", "PL3/8");
    expectResolves('2" sch 40 pipe', "PIPE2STD");
    expectResolves("4x4x1/4 square tube", "HSS4x4x1/4");
    expectResolves("L3x3x1/4", "L3x3x1/4");
    expectResolves("PL1/2", "PL1/2");
    expectResolves("1/2 plate", "PL1/2");
    expectResolves("W8x18", "W8x18");
    expectResolves("L2x2x1/4", "L2x2x1/4");
    expectResolves("HSS6x6x3/8", "HSS6x6x3/8");
    expectResolves("C12x30", "C12x30");
    expectResolves("PIPE2STD", "PIPE2STD");
    expectResolves("HSS8x8x5/8", "HSS8x8x5/8");
  });

  it("resolves the task alias lists for channel, angle, plate, W, and pipe", () => {
    for (const text of ["c12x30", "12x30 channel", "12 inch channel 30#", "12 channel 30 lb", '12" channel 30 lb', "12 channel 30"]) {
      expectResolves(text, "C12x30");
    }
    for (const text of ["l2x2x1/4", "2x2x1/4 angle", "angle 2x2x1/4", "2x2x1/4 l", "2 x 2 x 1/4 angle", "2x2x1/4"]) {
      expectResolves(text, "L2x2x1/4");
    }
    for (const text of ["pl3/8", "3/8 plate", "plate 3/8", "3/8 pl", "3/8 plt", ".375 plate"]) {
      expectResolves(text, "PL3/8");
    }
    for (const text of ["w12x26", "12x26 beam", "12x26 wf", "w 12x26", "12 wf 26"]) {
      expectResolves(text, "W12x26");
    }
    for (const text of ["2 pipe std", '2" sch 40 pipe', "2 inch pipe sch 40", "2 sch 40", '2" std pipe', "pipe 2 std", "2x.154 pipe"]) {
      expectResolves(text, "PIPE2STD");
    }
    for (const text of ["2 pipe xs", "2 sch 80 pipe", "2 xh pipe", "2x.218 pipe"]) {
      expectResolves(text, "PIPE2XS");
    }
  });

  it("gives bare AxBxT to the angle and the tube forms to the HSS", () => {
    expectResolves("2x2x1/4", "L2x2x1/4");
    expectResolves("2x2x1/4 hss", "HSS2x2x1/4");
    expectResolves("2x2x1/4 tube", "HSS2x2x1/4");
    expectResolves("4x4x1/4", "L4x4x1/4");
    expectResolves("4x4x1/4 square tube", "HSS4x4x1/4");
    expectResolves("6x6x3/8", "L6x6x3/8");
    expectResolves('6" sq 3/8', "HSS6x6x3/8");
    expectResolves("4x3x1/4", "L4x3x1/4");
    expectResolves("4x3x1/4 tube", "HSS4x3x1/4");
    // No angle has these dims, so the bare form belongs to the HSS.
    expectResolves("8x8x5/8", "HSS8x8x5/8");
    expectResolves("8x8x1/2", "HSS8x8x1/2");
    expectResolves("10x6x3/8", "HSS10x6x3/8");
    expectResolves("3x3x1/8", "HSS3x3x1/8");
  });

  it("resolves mixed numbers in both spellings", () => {
    expectResolves("1 1/2 pipe std", "PIPE1-1/2STD");
    expectResolves("1-1/2 pipe std", "PIPE1-1/2STD");
    expectResolves("1-1/2 sch 40 pipe", "PIPE1-1/2STD");
    expectResolves("2 1/2 x 2 1/2 x 1/4 angle", "L2-1/2x2-1/2x1/4");
    expectResolves("2-1/2x2-1/2x1/4", "L2-1/2x2-1/2x1/4");
    expectResolves("1 1/2 round bar", "RB1-1/2");
    expectResolves("1-1/4 plate", "PL1-1/4");
  });

  it("resolves the 8 inch round HSS by nominal size and by true OD", () => {
    expectResolves("8 round tube 1/4 wall", "HSS8x1/4");
    expectResolves("8 od x 1/4 wall tube", "HSS8x1/4");
    expectResolves("8.625 od x .250 wall round tube", "HSS8x1/4");
    expectResolves("8.625x.250 round tube", "HSS8x1/4");
    expectResolves("hss8.625x.250", "HSS8x1/4");
    expectResolves("8 5/8 round tube 1/4 wall", "HSS8x1/4");
    expectResolves("8-5/8 round tube 1/4 wall", "HSS8x1/4");
    expectResolves("8 round tube 3/8 wall", "HSS8x3/8");
    expectResolves("8.625x.375 round tube", "HSS8x3/8");
    // Same OD and wall as PIPE8XS, but tube and pipe stay separate items.
    expectResolves("8.625x.500 tube", "HSS8x1/2");
    expectResolves("8.625x.500 pipe", "PIPE8XS");
  });

  it("resolves a # glued to the weight in the designation shape", () => {
    expectResolves("W12x26#", "W12x26");
    expectResolves("W12 x 26#", "W12x26");
    expectResolves("12 x 26# WF", "W12x26");
    expectResolves("C12x30#", "C12x30");
    expectResolves("C12 x 30# channel", "C12x30");
    expectResolves("12x30# channel", "C12x30");
    expectResolves("MC12x31#", "MC12x31");
    expectResolves("S12x31.8#", "S12x31.8");
    // Bare depth x weight with # is ambiguous (W12x30 and C12x30 both exist).
    expect(findItemByAlias(items, "12x30#")).toBeNull();
    expect(findItemByAlias(items, "12x30 lb")).toBeNull();
  });

  it("resolves Unicode vulgar fractions to the mixed-number item, never the whole-number one", () => {
    expectResolves("1½ pipe std", "PIPE1-1/2STD");
    expectResolves("1 ½ pipe std", "PIPE1-1/2STD");
    expectResolves('1½" pipe std', "PIPE1-1/2STD");
    expectResolves("1-½ round bar", "RB1-1/2");
    expectResolves("8x8x½ tube", "HSS8x8x1/2");
    expectResolves("8x8x⅝ tube", "HSS8x8x5/8");
    expectResolves("⅜ plate", "PL3/8");
    expectResolves("2½x2½x¼ angle", "L2-1/2x2-1/2x1/4");
  });

  it("resolves abbreviation points written without a space", () => {
    expectResolves("No.4 rebar", "REBAR#4");
    expectResolves("No. 4 rebar", "REBAR#4");
    expectResolves('2" sch.40 pipe', "PIPE2STD");
    expectResolves("2 sch.80 pipe", "PIPE2XS");
    expectResolves("hss6x.25", "HSS6x1/4");
  });

  it("resolves the remaining categories", () => {
    expectResolves("6 round tube 1/4 wall", "HSS6x1/4");
    expectResolves("HSS6x1/4", "HSS6x1/4");
    expectResolves("S12x31.8", "S12x31.8");
    expectResolves("12x31.8 i beam", "S12x31.8");
    expectResolves("MC12x31", "MC12x31");
    expectResolves("12x31 mc", "MC12x31");
    expectResolves("1/4 x 2 flat bar", "FB1/4x2");
    expectResolves("2 x 1/4 flat", "FB1/4x2");
    expectResolves("1 round bar", "RB1");
    expectResolves('1" rd', "RB1");
    expectResolves("1 square bar", "SQ1");
    expectResolves("16 ga sheet", "SH16GA");
    expectResolves("16 gauge", "SH16GA");
    expectResolves("#4 rebar", "REBAR#4");
    expectResolves("REBAR#4", "REBAR#4");
    expectResolves("1/2 rebar", "REBAR#4");
  });

  it("keeps C and MC apart where the numbers coincide", () => {
    expectResolves("10x25 channel", "C10x25");
    expectResolves("10x25 mc", "MC10x25");
  });

  it("returns null for unknown or empty text", () => {
    expect(findItemByAlias(items, "unobtainium")).toBeNull();
    expect(findItemByAlias(items, "")).toBeNull();
    expect(findItemByAlias(items, "   ")).toBeNull();
    expect(findItemByAlias(items, "8x8x5/8 x 40 ft")).toBeNull();
    expect(findItemByAlias(items, "2 pipe")).toBeNull();
  });
});

describe("weights", () => {
  it("HSS square and rectangular match AISC within 1 percent", () => {
    expectWithinOnePercent(get("HSS8x8x5/8").weight_per_ft, 59.32);
    expectWithinOnePercent(get("HSS6x6x1/4").weight_per_ft, 19.02);
    expectWithinOnePercent(get("HSS8x8x1/2").weight_per_ft, 48.85);
    expectWithinOnePercent(get("HSS8x4x1/4").weight_per_ft, 19.02);
    expectWithinOnePercent(get("HSS4x4x1/4").weight_per_ft, 12.21);
    expectWithinOnePercent(hssRectWeight(8, 8, 0.625), 59.32);
  });

  it("HSS round matches AISC within 1 percent", () => {
    expectWithinOnePercent(get("HSS6x1/4").weight_per_ft, 15.37);
    expectWithinOnePercent(hssRoundWeight(6, 0.25), 15.37);
    expectWithinOnePercent(get("HSS10x3/8").weight_per_ft, 38.58);
    // The 8 inch round is rolled only at the pipe diameter: AISC HSS8.625x0.250,
    // x0.375, x0.500. The designation keeps the nominal 8, the weight does not.
    expectWithinOnePercent(get("HSS8x1/4").weight_per_ft, 22.38);
    expectWithinOnePercent(get("HSS8x3/8").weight_per_ft, 33.07);
    expectWithinOnePercent(get("HSS8x1/2").weight_per_ft, 43.43);
    expectWithinOnePercent(hssRoundWeight(8.625, 0.375), 33.07);
  });

  it("HSS round dims carry the true OD and the nominal size", () => {
    expect(get("HSS8x3/8").dims).toEqual({ od: 8.625, nominal: 8, t: 0.375 });
    expect(get("HSS6x1/4").dims).toEqual({ od: 6, nominal: 6, t: 0.25 });
    expect(get("HSS10x1/2").dims).toEqual({ od: 10, nominal: 10, t: 0.5 });
    for (const it of items) {
      if (it.category !== "hss_round") continue;
      expect(it.dims.od as number).toBeGreaterThanOrEqual(it.dims.nominal as number);
      expect(it.designation).toBe(`HSS${it.dims.nominal}x${formatFraction(it.dims.t as number)}`);
    }
  });

  it("pipe matches AISC within 1 percent", () => {
    expectWithinOnePercent(get("PIPE2STD").weight_per_ft, 3.66);
    expectWithinOnePercent(get("PIPE4STD").weight_per_ft, 10.8);
    expectWithinOnePercent(get("PIPE2XS").weight_per_ft, 5.03);
    expectWithinOnePercent(pipeWeight(2.375, 0.154), 3.66);
    expect(get("PIPE2STD").dims).toEqual({ nps: 2, od: 2.375, t: 0.154, schedule: "STD", sch: 40 });
    expect(get("PIPE12STD").dims.sch).toBeUndefined();
    expect(get("PIPE10XS").dims.sch).toBeUndefined();
  });

  it("W, S, C, and MC carry the weight in the designation", () => {
    expect(get("W12x26").weight_per_ft).toBe(26);
    expect(get("W8x18").weight_per_ft).toBe(18);
    expect(get("S12x31.8").weight_per_ft).toBe(31.8);
    expect(get("C12x30").weight_per_ft).toBe(30);
    expect(get("MC12x31").weight_per_ft).toBe(31);
  });

  it("angles match AISC within 1 percent", () => {
    expectWithinOnePercent(get("L2x2x1/4").weight_per_ft, 3.19);
    expectWithinOnePercent(get("L4x4x1/2").weight_per_ft, 12.8);
    expectWithinOnePercent(get("L3x3x1/4").weight_per_ft, 4.9);
    expectWithinOnePercent(get("L6x4x1/2").weight_per_ft, 16.2);
    expectWithinOnePercent(angleWeight(2, 2, 0.25), 3.19);
  });

  it("bars match the published tables within 1 percent", () => {
    expectWithinOnePercent(get("FB1/4x2").weight_per_ft, 1.7);
    expectWithinOnePercent(get("RB1").weight_per_ft, 2.67);
    expectWithinOnePercent(get("SQ1").weight_per_ft, 3.4);
    expectWithinOnePercent(flatBarWeight(0.25, 2), 1.7);
    expectWithinOnePercent(roundBarWeight(1), 2.67);
    expectWithinOnePercent(squareBarWeight(1), 3.4);
  });

  it("rebar carries the ASTM table weight rounded to two decimals", () => {
    const published: Record<string, number> = {
      "REBAR#3": 0.376,
      "REBAR#4": 0.668,
      "REBAR#5": 1.043,
      "REBAR#6": 1.502,
      "REBAR#7": 2.044,
      "REBAR#8": 2.67,
      "REBAR#9": 3.4,
      "REBAR#10": 4.303,
      "REBAR#11": 5.313,
    };
    for (const [designation, lbPerFt] of Object.entries(published)) {
      expect(get(designation).weight_per_ft, designation).toBe(Math.round(lbPerFt * 100) / 100);
    }
  });

  it("plate and sheet have null weight_per_ft and carry weight_per_sqft in dims", () => {
    expect(get("PL3/8").weight_per_ft).toBeNull();
    expectWithinOnePercent(get("PL3/8").dims.weight_per_sqft as number, 15.31);
    expectWithinOnePercent(plateWeightPerSqft(0.375), 15.31);
    expect(get("PL3/8").dims.t).toBe(0.375);
    expect(get("SH16GA").weight_per_ft).toBeNull();
    expect(get("SH16GA").dims).toEqual({ gauge: 16, t: 0.0598, weight_per_sqft: 2.5 });
    for (const it of items) {
      if (it.category === "plate" || it.category === "sheet") {
        expect(it.weight_per_ft).toBeNull();
        expect(typeof it.dims.weight_per_sqft).toBe("number");
      } else {
        expect(it.weight_per_ft, it.designation).not.toBeNull();
        expect(it.weight_per_ft as number).toBeGreaterThan(0);
      }
    }
  });

  it("rounds stored weights to two decimals", () => {
    for (const it of items) {
      if (it.weight_per_ft === null) continue;
      expect(Math.round(it.weight_per_ft * 100) / 100).toBe(it.weight_per_ft);
    }
  });
});

describe("default grades", () => {
  it("are reference data per category, null where the grade depends on the order", () => {
    expect(get("HSS8x8x5/8").default_grade).toBe("A500 Gr B");
    expect(get("PIPE2STD").default_grade).toBe("A53 Gr B");
    expect(get("W12x26").default_grade).toBe("A992");
    expect(get("C12x30").default_grade).toBe("A36");
    expect(get("L2x2x1/4").default_grade).toBe("A36");
    expect(get("PL3/8").default_grade).toBe("A36");
    expect(get("REBAR#4").default_grade).toBe("A615 Gr 60");
    expect(get("SH16GA").default_grade).toBeNull();
  });
});

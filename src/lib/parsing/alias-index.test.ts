import { describe, expect, it } from "vitest";
import { generateCatalog } from "@/lib/catalog/generate";
import { aliasIndexFromCatalog, createAliasIndex, designationKey, lookupItem, type AliasIndexRow } from "./alias-index";

const index = aliasIndexFromCatalog(generateCatalog());

describe("lookupItem through the seed catalog", () => {
  it("resolves shop language through aliases", () => {
    const cases: Array<[string, string]> = [
      ["8 square 5/8", "HSS8x8x5/8"],
      ["8x8x5/8 tube", "HSS8x8x5/8"],
      ['8" sq tube 5/8 wall', "HSS8x8x5/8"],
      ["12 inch channel 30#", "C12x30"],
      ["2x2x1/4 angle", "L2x2x1/4"],
      ["3/8 plate", "PL3/8"],
      ['6" sq 3/8', "HSS6x6x3/8"],
      ['2" sch 40 pipe', "PIPE2STD"],
      ["4x4x1/4 square tube", "HSS4x4x1/4"],
    ];
    for (const [text, designation] of cases) {
      expect(lookupItem(index, [text])?.designation, text).toBe(designation);
    }
  });

  it("resolves designations in any case or spacing through the designation map", () => {
    expect(lookupItem(index, ["hss 8X8X5/8"])?.designation).toBe("HSS8x8x5/8");
    expect(lookupItem(index, ["w12X26"])?.designation).toBe("W12x26");
    expect(lookupItem(index, ["pipe2std"])?.designation).toBe("PIPE2STD");
    expect(lookupItem(index, ["L 2x2x1/4"])?.designation).toBe("L2x2x1/4");
    expect(lookupItem(index, ["PL 3/8"])?.designation).toBe("PL3/8");
  });

  it("tries candidates in order and skips blanks", () => {
    expect(lookupItem(index, ["", "   ", "no such thing", "C12x30"])?.designation).toBe("C12x30");
    expect(lookupItem(index, ["W12x26", "C12x30"])?.designation).toBe("W12x26");
  });

  it("returns null when nothing matches", () => {
    expect(lookupItem(index, [])).toBeNull();
    expect(lookupItem(index, ["wide flange", "some angle for clips", ""])).toBeNull();
  });

  it("entries carry the item's data with the designation as the id", () => {
    const entry = lookupItem(index, ["8 square 5/8"]);
    expect(entry).toMatchObject({
      catalog_item_id: "HSS8x8x5/8",
      designation: "HSS8x8x5/8",
      category: "hss_square",
      dims: { a: 8, b: 8, t: 0.625 },
    });
    expect(entry?.weight_per_ft).toBeGreaterThan(50);
    expect(lookupItem(index, ["3/8 plate"])).toMatchObject({ category: "plate", weight_per_ft: null });
  });
});

describe("createAliasIndex", () => {
  const rows: AliasIndexRow[] = [
    { alias: "8 SQUARE 5/8", catalog_item_id: "id-a", designation: "HSS8x8x5/8", category: "hss_square", weight_per_ft: 59.32, dims: {} },
    { alias: "8 square 5/8", catalog_item_id: "id-b", designation: "OTHER", category: "hss_square", weight_per_ft: null, dims: {} },
    { alias: "", catalog_item_id: "id-c", designation: "C12x30", category: "channel", weight_per_ft: 30, dims: {} },
  ];
  const small = createAliasIndex(rows);

  it("keys aliases through normalizeAlias so spelling variants collide", () => {
    expect(small.byAlias.get("8 sq 5/8")?.catalog_item_id).toBe("id-a");
    expect(small.byAlias.has("8 SQUARE 5/8")).toBe(false);
  });

  it("lets the first row keep an alias", () => {
    expect(lookupItem(small, ["8x8 5/8 wall"])).toBeNull();
    expect(lookupItem(small, ["8 square 5/8"])?.catalog_item_id).toBe("id-a");
  });

  it("keys designations uppercased without spaces and ignores blank aliases", () => {
    expect(designationKey("hss 8x8x5/8")).toBe("HSS8X8X5/8");
    expect(small.byDesignation.get("C12X30")?.catalog_item_id).toBe("id-c");
    expect(small.byAlias.has("")).toBe(false);
    expect(lookupItem(small, ["c12x30"])?.catalog_item_id).toBe("id-c");
  });
});

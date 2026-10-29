// Pure parts of the item admin: the form schemas (dims JSON text in
// particular), the error code mapping the actions use, the dims display
// string, the search merge, alias grouping, and collision annotation. The
// database paths are type-checked only.

import { describe, expect, it } from "vitest";
import type { ZodError } from "zod";
import {
  AliasEmptyError,
  AliasExistsError,
  aliasFormSchema,
  annotateCollisions,
  compareDesignations,
  DesignationTakenError,
  dimsTextSchema,
  dimsToText,
  groupAliases,
  isUniqueViolation,
  itemFormErrorCode,
  itemFormSchema,
  mergeItemRows,
  type AliasEntry,
  type ItemListRow,
} from "./items";

const FULL_FORM = {
  category: "hss_square",
  designation: "HSS8x8x5/8",
  dims: '{"a": 8, "b": 8, "t": 0.625}',
  weight_per_ft: "59.32",
  default_grade: "A500 Gr B",
};

describe("itemFormSchema", () => {
  it("accepts a filled form and types every field", () => {
    const parsed = itemFormSchema.parse(FULL_FORM);
    expect(parsed).toEqual({
      category: "hss_square",
      designation: "HSS8x8x5/8",
      dims: { a: 8, b: 8, t: 0.625 },
      weight_per_ft: 59.32,
      default_grade: "A500 Gr B",
    });
  });

  it("removes whitespace from the designation so C12 x 30 is stored as C12x30", () => {
    const parsed = itemFormSchema.parse({ ...FULL_FORM, designation: "  C12 x 30 " });
    expect(parsed.designation).toBe("C12x30");
  });

  it("rejects a blank designation", () => {
    const result = itemFormSchema.safeParse({ ...FULL_FORM, designation: "   " });
    expect(result.success).toBe(false);
    if (!result.success) expect(itemFormErrorCode(result.error)).toBe("designation_invalid");
  });

  it("rejects a missing or unknown category", () => {
    const missing = itemFormSchema.safeParse({ ...FULL_FORM, category: null });
    const unknown = itemFormSchema.safeParse({ ...FULL_FORM, category: "tube" });
    expect(missing.success).toBe(false);
    expect(unknown.success).toBe(false);
    if (!unknown.success) expect(itemFormErrorCode(unknown.error)).toBe("category_invalid");
  });

  it("stores a blank weight and grade as null, never as a default", () => {
    const parsed = itemFormSchema.parse({ ...FULL_FORM, weight_per_ft: "", default_grade: "  " });
    expect(parsed.weight_per_ft).toBeNull();
    expect(parsed.default_grade).toBeNull();
  });

  it("treats a missing weight field as null", () => {
    const parsed = itemFormSchema.parse({ ...FULL_FORM, weight_per_ft: null });
    expect(parsed.weight_per_ft).toBeNull();
  });

  it("rejects a weight that is not a positive number", () => {
    for (const weight of ["abc", "0", "-3", "Infinity"]) {
      const result = itemFormSchema.safeParse({ ...FULL_FORM, weight_per_ft: weight });
      expect(result.success, weight).toBe(false);
      if (!result.success) expect(itemFormErrorCode(result.error)).toBe("weight_invalid");
    }
  });

  it("rejects an over-long grade", () => {
    const result = itemFormSchema.safeParse({ ...FULL_FORM, default_grade: "x".repeat(61) });
    expect(result.success).toBe(false);
    if (!result.success) expect(itemFormErrorCode(result.error)).toBe("grade_invalid");
  });
});

describe("dimsTextSchema", () => {
  it("parses a flat object of numbers and strings", () => {
    expect(dimsTextSchema.parse('{"nps": 2, "od": 2.375, "t": 0.154, "schedule": "STD"}')).toEqual({
      nps: 2,
      od: 2.375,
      t: 0.154,
      schedule: "STD",
    });
  });

  it("reads a blank or missing textarea as no dims", () => {
    expect(dimsTextSchema.parse("")).toEqual({});
    expect(dimsTextSchema.parse("   \n")).toEqual({});
    expect(dimsTextSchema.parse(null)).toEqual({});
  });

  it("names invalid JSON", () => {
    const result = dimsTextSchema.safeParse("{a: 8}");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Dims is not valid JSON.");
      expect(codeOf(result.error)).toBe("dims_not_json");
    }
  });

  it("names a value that is not an object", () => {
    for (const text of ["[8, 8]", "8", '"8x8"', "null", "true"]) {
      const result = dimsTextSchema.safeParse(text);
      expect(result.success, text).toBe(false);
      if (!result.success) expect(codeOf(result.error)).toBe("dims_not_object");
    }
  });

  it("names the key whose value is not a number or a string", () => {
    const result = dimsTextSchema.safeParse('{"a": 8, "walls": [0.25, 0.375]}');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(codeOf(result.error)).toBe("dims_bad_values");
      expect(result.error.issues[0]?.message).toContain('"walls"');
    }
    for (const text of ['{"a": null}', '{"a": true}', '{"a": {"b": 1}}']) {
      const nested = dimsTextSchema.safeParse(text);
      expect(nested.success, text).toBe(false);
      if (!nested.success) expect(codeOf(nested.error)).toBe("dims_bad_values");
    }
  });

  it("carries the dims code through itemFormErrorCode", () => {
    const result = itemFormSchema.safeParse({ ...FULL_FORM, dims: "not json" });
    expect(result.success).toBe(false);
    if (!result.success) expect(itemFormErrorCode(result.error)).toBe("dims_not_json");
  });
});

describe("aliasFormSchema", () => {
  it("trims the alias", () => {
    expect(aliasFormSchema.parse({ alias: "  8 square 5/8  " })).toEqual({ alias: "8 square 5/8" });
  });

  it("rejects a blank or missing alias", () => {
    expect(aliasFormSchema.safeParse({ alias: "   " }).success).toBe(false);
    expect(aliasFormSchema.safeParse({ alias: null }).success).toBe(false);
    expect(aliasFormSchema.safeParse({}).success).toBe(false);
  });
});

describe("dimsToText", () => {
  it("writes a one-line JSON object with a space after each colon", () => {
    expect(dimsToText({ a: 8, b: 8, t: 0.625 })).toBe('{"a": 8, "b": 8, "t": 0.625}');
    expect(dimsToText({ schedule: "STD", nps: 2 })).toBe('{"schedule": "STD", "nps": 2}');
  });

  it("reads anything that is not an object as {}", () => {
    expect(dimsToText({})).toBe("{}");
    expect(dimsToText(null)).toBe("{}");
    expect(dimsToText([1, 2])).toBe("{}");
    expect(dimsToText("8x8")).toBe("{}");
  });

  it("round-trips through the form schema", () => {
    const dims = { a: 2, b: 2, t: 0.25 };
    expect(dimsTextSchema.parse(dimsToText(dims))).toEqual(dims);
  });
});

describe("compareDesignations", () => {
  it("orders numerically inside a designation and ignores case", () => {
    const sorted = ["HSS10x10x1/2", "hss8x8x5/8", "C12x30", "C6x8.2", "W12x26", "W10x12"].sort(compareDesignations);
    expect(sorted).toEqual(["C6x8.2", "C12x30", "hss8x8x5/8", "HSS10x10x1/2", "W10x12", "W12x26"]);
  });
});

describe("mergeItemRows", () => {
  const row = (id: string, designation: string): ItemListRow => ({
    id,
    category: "channel",
    designation,
    dims: {},
    weight_per_ft: null,
    default_grade: null,
    alias_count: 0,
  });

  it("keeps designation matches, adds alias matches once, and sorts", () => {
    const merged = mergeItemRows(
      [row("1", "C12x30"), row("2", "C12x20.7")],
      [row("2", "C12x20.7"), row("3", "C10x30"), row("3", "C10x30")],
    );
    expect(merged.map((item) => item.id)).toEqual(["3", "2", "1"]);
  });

  it("cuts to the limit", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(String(i), `C${i + 1}x10`));
    expect(mergeItemRows(rows, [], 3).map((item) => item.designation)).toEqual(["C1x10", "C2x10", "C3x10"]);
  });
});

describe("groupAliases", () => {
  const entry = (alias: string, source: AliasEntry["source"], broker: string | null): AliasEntry => ({
    id: `${alias}-${source}`,
    alias,
    source,
    broker_id: broker,
    created_at: "2026-10-01T00:00:00Z",
    also_on: [],
  });

  it("splits seed rows from learned rows and sorts each list", () => {
    const grouped = groupAliases([
      entry("8x8x5/8", "seed", null),
      entry("8 sq hss 5/8 wall", "learned", "b1"),
      entry("8 sq 5/8", "seed", null),
      entry("8 heavy tube", "learned", "b1"),
    ]);
    expect(grouped.seed.map((row) => row.alias)).toEqual(["8 sq 5/8", "8x8x5/8"]);
    expect(grouped.learned.map((row) => row.alias)).toEqual(["8 heavy tube", "8 sq hss 5/8 wall"]);
  });

  it("returns empty lists for an item with no aliases", () => {
    expect(groupAliases([])).toEqual({ seed: [], learned: [] });
  });
});

describe("annotateCollisions", () => {
  const base = { id: "a1", source: "learned" as const, broker_id: "b1", created_at: "2026-10-01T00:00:00Z" };

  it("lists the other designations sharing an alias, deduplicated and sorted", () => {
    const annotated = annotateCollisions(
      [
        { ...base, alias: "12x30 lb" },
        { ...base, id: "a2", alias: "12 channel 30 lb" },
      ],
      [
        { alias: "12x30 lb", designation: "W12x30" },
        { alias: "12x30 lb", designation: "W12x30" },
        { alias: "12x30 lb", designation: "MC12x30" },
        { alias: "12x30 lb", designation: null },
      ],
    );
    expect(annotated[0]?.also_on).toEqual(["MC12x30", "W12x30"]);
    expect(annotated[1]?.also_on).toEqual([]);
  });
});

describe("isUniqueViolation", () => {
  it("recognizes the Postgres code and nothing else", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ code: null })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe("errors", () => {
  it("say what the page shows", () => {
    expect(new DesignationTakenError().message).toBe("An item with that designation already exists");
    expect(new AliasEmptyError('""').message).toContain("nothing left after normalization");
    const exists = new AliasExistsError("8 sq 5/8");
    expect(exists.alias).toBe("8 sq 5/8");
    expect(exists.message).toContain("8 sq 5/8");
  });
});

/** The params.code the dims transform attaches to its issue. */
function codeOf(error: ZodError): unknown {
  const params = (error.issues[0] as { params?: unknown } | undefined)?.params;
  return params && typeof params === "object" ? (params as { code?: unknown }).code : undefined;
}

import { describe, expect, it } from "vitest";
import type { Tables } from "@/lib/db/client";
import {
  affectsDrafts,
  aliasCarriesSize,
  aliasToLearn,
  canConfirm,
  diffLine,
  mergeLineValues,
  recomputeFlags,
  remapSourceSpan,
  revisionAttachmentRows,
  revisionLineRows,
  type ConfirmableLine,
  type LineRow,
  type MergeSource,
} from "./review";

const ITEM = "33333333-3333-4333-8333-333333333333";

function line(overrides: Partial<ConfirmableLine> = {}): ConfirmableLine {
  return { line_no: 1, qty: 8, unit: "pcs", catalog_item_id: ITEM, status: "parsed", ...overrides };
}

describe("canConfirm (AC-3.3)", () => {
  it("passes when every line has qty, unit, and a catalog link", () => {
    expect(canConfirm([line(), line({ line_no: 2, status: "confirmed" })])).toEqual({ ok: true, problems: [] });
  });

  it("accepts a custom line without a catalog link", () => {
    expect(canConfirm([line({ catalog_item_id: null, status: "custom" })]).ok).toBe(true);
  });

  it("rejects a missing quantity, naming the line", () => {
    const result = canConfirm([line(), line({ line_no: 2, qty: null })]);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["Line 2 needs a quantity."]);
  });

  it("rejects a missing unit", () => {
    expect(canConfirm([line({ unit: null })]).problems).toEqual(["Line 1 needs a unit."]);
  });

  it("rejects an unlinked line that is not marked custom", () => {
    expect(canConfirm([line({ catalog_item_id: null })]).problems).toEqual([
      "Line 1 needs a catalog link or the custom item status.",
    ]);
  });

  it("lists every missing piece of one line in one sentence", () => {
    expect(canConfirm([line({ line_no: 3, qty: null, unit: null, catalog_item_id: null })]).problems).toEqual([
      "Line 3 needs a quantity, a unit and a catalog link or the custom item status.",
    ]);
  });

  it("reports every incomplete line", () => {
    const result = canConfirm([line({ qty: null }), line({ line_no: 2 }), line({ line_no: 3, unit: null })]);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toMatch(/^Line 1/);
    expect(result.problems[1]).toMatch(/^Line 3/);
  });

  it("ignores removed lines", () => {
    expect(canConfirm([line(), line({ line_no: 2, qty: null, unit: null, catalog_item_id: null, status: "removed" })]).ok).toBe(
      true,
    );
  });

  it("does not let a request with no live lines through", () => {
    expect(canConfirm([])).toEqual({ ok: false, problems: ["There are no lines to confirm."] });
    expect(canConfirm([line({ status: "removed" })]).ok).toBe(false);
  });

  it("does not require a grade", () => {
    expect(canConfirm([line()]).ok).toBe(true);
  });
});

describe("recomputeFlags", () => {
  const complete = {
    qty: 8,
    unit: "pcs" as const,
    length_ft: 50,
    length_text: "50'",
    grade_spec: "A992",
    catalog_item_id: ITEM,
    category: "w_beam" as const,
    flags: [] as string[],
  };

  it("derives the missing_* flags from the current values", () => {
    expect(recomputeFlags(complete)).toEqual([]);
    expect(recomputeFlags({ ...complete, qty: null, grade_spec: null })).toEqual(["missing_grade", "missing_qty"]);
    expect(recomputeFlags({ ...complete, catalog_item_id: null })).toEqual(["unmatched_item"]);
  });

  it("carries the model's judgment flags and drops unknown strings", () => {
    expect(recomputeFlags({ ...complete, flags: ["alternate_mentioned", "possible_duplicate", "ambiguous_size", "bogus"] })).toEqual([
      "ambiguous_size",
      "possible_duplicate",
      "alternate_mentioned",
    ]);
  });

  it("keeps ambiguous_unit only while the unit is blank", () => {
    expect(recomputeFlags({ ...complete, unit: null, flags: ["ambiguous_unit"] })).toEqual(["ambiguous_unit"]);
    expect(recomputeFlags({ ...complete, unit: null, qty: 8, flags: [] })).toEqual(["ambiguous_unit"]);
    expect(recomputeFlags({ ...complete, unit: "pcs", flags: ["ambiguous_unit"] })).toEqual([]);
    expect(recomputeFlags({ ...complete, unit: null, qty: null, flags: [] })).toEqual(["missing_qty"]);
  });
});

describe("aliasToLearn (AC-3.5)", () => {
  const item = { designation: "HSS8x8x5/8" };

  it("learns the normalized description of an unmatched line", () => {
    expect(aliasToLearn({ catalog_item_id: null, description: '8" sq tube 5/8 wall' }, item)).toBe("8 sq hss 5/8 wall");
  });

  it("learns nothing when the line was already linked (re-linking must not alias one designation to another item)", () => {
    expect(aliasToLearn({ catalog_item_id: ITEM, description: "HSS8x8x1/2" }, item)).toBeNull();
  });

  it("learns nothing from a blank description or from the item's own designation", () => {
    expect(aliasToLearn({ catalog_item_id: null, description: "   " }, item)).toBeNull();
    expect(aliasToLearn({ catalog_item_id: null, description: "hss8x8x5/8" }, item)).toBeNull();
  });

  it("learns nothing from a description with no size in it (a bare shape word would match every later line of that shape)", () => {
    const angle = { designation: "L2x2x1/4" };
    expect(aliasToLearn({ catalog_item_id: null, description: "angle" }, angle)).toBeNull();
    expect(aliasToLearn({ catalog_item_id: null, description: "plate" }, { designation: "PL3/8" })).toBeNull();
    expect(aliasToLearn({ catalog_item_id: null, description: "some channel for clips" }, { designation: "C12x30" })).toBeNull();
    expect(aliasToLearn({ catalog_item_id: null, description: "clip angle" }, angle)).toBeNull();
    // A vulgar fraction is a size: normalizeAlias turns it into digits first.
    expect(aliasToLearn({ catalog_item_id: null, description: "½ plate" }, { designation: "PL1/2" })).toBe("1/2 plate");
    expect(aliasToLearn({ catalog_item_id: null, description: "2x2 clip angle 1/4" }, angle)).toBe("2x2 clip angle 1/4");
  });

  it("aliasCarriesSize is the digit test", () => {
    expect(aliasCarriesSize("angle")).toBe(false);
    expect(aliasCarriesSize("8 sq hss 5/8 wall")).toBe(true);
    expect(aliasCarriesSize("")).toBe(false);
  });
});

describe("mergeLineValues", () => {
  const base: MergeSource = {
    raw_text: "W12x26 x 50' qty 8",
    description: "W12x26",
    unit: "pcs",
    grade_spec: null,
    length_text: null,
    length_ft: null,
    delivery_notes: null,
    category: "w_beam",
    catalog_item_id: ITEM,
    dims: { d: 12, wt: 26 },
    cut_to_length: false,
    flags: ["missing_grade", "possible_duplicate"],
  };

  it("joins the texts, fills blanks from the dropped line, and drops possible_duplicate", () => {
    const keep: MergeSource = { ...base, catalog_item_id: null, category: null, dims: {} };
    const drop: MergeSource = {
      ...base,
      raw_text: "8 pcs W12x26 A992 deliver to Waco",
      description: "W12x26 A992",
      grade_spec: "A992",
      delivery_notes: "deliver to Waco",
      length_text: "50'",
      length_ft: 50,
      cut_to_length: true,
      flags: ["alternate_mentioned", "possible_duplicate"],
    };
    expect(mergeLineValues(keep, drop)).toEqual({
      raw_text: "W12x26 x 50' qty 8 / 8 pcs W12x26 A992 deliver to Waco",
      description: "W12x26 / W12x26 A992",
      unit: "pcs",
      grade_spec: "A992",
      length_text: "50'",
      length_ft: 50,
      delivery_notes: "deliver to Waco",
      category: "w_beam",
      catalog_item_id: ITEM,
      dims: { d: 12, wt: 26 },
      cut_to_length: true,
      flags: ["missing_grade", "alternate_mentioned"],
    });
  });

  it("takes the length pair from one line, so length_ft always belongs to length_text", () => {
    // A kept "40' or 48'" does not parse (length_ft null, see parseLengthFt); the
    // dropped line's 50 must not be paired with it.
    const keep: MergeSource = { ...base, length_text: "40' or 48'", length_ft: null };
    const drop: MergeSource = { ...base, length_text: "50'", length_ft: 50 };
    expect(mergeLineValues(keep, drop)).toMatchObject({ length_text: "40' or 48'", length_ft: null });
    // A kept number without text (the model gave length_ft alone) keeps its pair too.
    expect(mergeLineValues({ ...base, length_ft: 40 }, drop)).toMatchObject({ length_text: null, length_ft: 40 });
    // Only a kept line with neither half takes the dropped line's pair.
    expect(mergeLineValues(base, drop)).toMatchObject({ length_text: "50'", length_ft: 50 });
    expect(mergeLineValues(base, base)).toMatchObject({ length_text: null, length_ft: null });
  });

  it("keeps the kept line's values when both are set", () => {
    const keep: MergeSource = { ...base, grade_spec: "A36", unit: "ft", category: "channel", dims: { d: 12, wt: 30 } };
    const drop: MergeSource = { ...base, grade_spec: "A992", unit: "pcs" };
    expect(mergeLineValues(keep, drop)).toMatchObject({ grade_spec: "A36", unit: "ft", category: "channel", dims: { d: 12, wt: 30 } });
  });
});

describe("revisionLineRows (AC-8.4)", () => {
  const BROKER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OLD_REQUEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const NEW_REQUEST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  function row(overrides: Partial<LineRow> & { id: string }): LineRow {
    return {
      broker_id: BROKER,
      request_id: OLD_REQUEST,
      line_no: 1,
      raw_text: "W12x26 x 50' qty 8",
      catalog_item_id: ITEM,
      category: "w_beam",
      description: "W12x26",
      dims: { d: 12, wt: 26 },
      grade_spec: "A992",
      qty: 8,
      unit: "pcs",
      length_ft: 50,
      length_text: "50'",
      cut_to_length: false,
      delivery_notes: null,
      flags: [],
      confidence: 0.9,
      source_span: { kind: "text", start: 10, end: 30 },
      status: "confirmed",
      created_at: "2026-10-23T10:00:00Z",
      updated_at: "2026-10-23T10:05:00Z",
      ...overrides,
    };
  }

  it("copies every live line with a new id, keeps its status, and maps old ids to new ones", () => {
    let n = 0;
    const newId = () => `new-${++n}`;
    const lines = [
      row({ id: "old-1", status: "confirmed" }),
      row({ id: "old-2", line_no: 2, status: "parsed", catalog_item_id: null, flags: ["unmatched_item"] }),
      row({ id: "old-3", line_no: 3, status: "custom", catalog_item_id: null }),
      row({ id: "old-4", line_no: 4, status: "removed" }),
    ];
    const { rows, lineIdMap } = revisionLineRows(lines, BROKER, NEW_REQUEST, newId);

    expect(rows.map((r) => r.id)).toEqual(["new-1", "new-2", "new-3"]);
    expect(Array.from(lineIdMap.entries())).toEqual([
      ["old-1", "new-1"],
      ["old-2", "new-2"],
      ["old-3", "new-3"],
    ]);
    expect(rows.map((r) => r.status)).toEqual(["confirmed", "parsed", "custom"]);
    expect(rows.every((r) => r.request_id === NEW_REQUEST && r.broker_id === BROKER)).toBe(true);
    // Field values travel unchanged; timestamps are left to the database.
    expect(rows[0]).toMatchObject({
      line_no: 1,
      raw_text: "W12x26 x 50' qty 8",
      catalog_item_id: ITEM,
      category: "w_beam",
      description: "W12x26",
      dims: { d: 12, wt: 26 },
      grade_spec: "A992",
      qty: 8,
      unit: "pcs",
      length_ft: 50,
      length_text: "50'",
      confidence: 0.9,
      source_span: { kind: "text", start: 10, end: 30 },
    });
    expect(rows[0]).not.toHaveProperty("created_at");
    expect(rows[0]).not.toHaveProperty("updated_at");
    expect(rows[1].flags).toEqual(["unmatched_item"]);
  });

  it("produces nothing for a request with only removed lines", () => {
    const { rows, lineIdMap } = revisionLineRows([row({ id: "old-1", status: "removed" })], BROKER, NEW_REQUEST, () => "x");
    expect(rows).toEqual([]);
    expect(lineIdMap.size).toBe(0);
  });

  it("points a PDF line's source_span at the copied attachment and leaves text spans alone", () => {
    const attachmentIdMap = new Map([["att-old", "att-new"]]);
    const lines = [
      row({ id: "old-1", source_span: { kind: "attachment", attachment_id: "att-old", page: 1, start: 40, end: 72 } }),
      row({ id: "old-2", line_no: 2, source_span: { kind: "text", start: 10, end: 30 } }),
      row({ id: "old-3", line_no: 3, source_span: {} }),
    ];
    const { rows } = revisionLineRows(lines, BROKER, NEW_REQUEST, () => "n", attachmentIdMap);
    expect(rows[0].source_span).toEqual({ kind: "attachment", attachment_id: "att-new", page: 1, start: 40, end: 72 });
    expect(rows[1].source_span).toEqual({ kind: "text", start: 10, end: 30 });
    expect(rows[2].source_span).toEqual({});
  });
});

describe("revisionAttachmentRows and remapSourceSpan (AC-1.4 on a new revision)", () => {
  const BROKER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OLD_REQUEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const NEW_REQUEST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  const attachment: Tables<"attachments"> = {
    id: "att-old",
    broker_id: BROKER,
    owner_type: "request",
    owner_id: OLD_REQUEST,
    storage_path: `${BROKER}/request/${OLD_REQUEST}/abc123-list.pdf`,
    filename: "list.pdf",
    mime: "application/pdf",
    size_bytes: 20480,
    sha256: "abc123",
    created_at: "2026-10-23T10:00:00Z",
    updated_at: "2026-10-23T10:00:00Z",
  };

  it("copies every file to the new owner with a fresh id over the same Storage object", () => {
    const { rows, attachmentIdMap } = revisionAttachmentRows(
      [attachment, { ...attachment, id: "att-eml", filename: "original.eml", mime: "message/rfc822" }],
      BROKER,
      NEW_REQUEST,
      (() => {
        let n = 0;
        return () => `new-${++n}`;
      })(),
    );
    expect(rows).toEqual([
      {
        id: "new-1",
        broker_id: BROKER,
        owner_type: "request",
        owner_id: NEW_REQUEST,
        storage_path: attachment.storage_path,
        filename: "list.pdf",
        mime: "application/pdf",
        size_bytes: 20480,
        sha256: "abc123",
      },
      {
        id: "new-2",
        broker_id: BROKER,
        owner_type: "request",
        owner_id: NEW_REQUEST,
        storage_path: attachment.storage_path,
        filename: "original.eml",
        mime: "message/rfc822",
        size_bytes: 20480,
        sha256: "abc123",
      },
    ]);
    expect(Array.from(attachmentIdMap.entries())).toEqual([
      ["att-old", "new-1"],
      ["att-eml", "new-2"],
    ]);
    expect(rows[0]).not.toHaveProperty("created_at");
  });

  it("produces nothing for a request without files", () => {
    const { rows, attachmentIdMap } = revisionAttachmentRows([], BROKER, NEW_REQUEST, () => "x");
    expect(rows).toEqual([]);
    expect(attachmentIdMap.size).toBe(0);
  });

  it("remapSourceSpan rewrites only an attachment span whose id is in the map", () => {
    const map = new Map([["att-old", "att-new"]]);
    expect(remapSourceSpan({ kind: "attachment", attachment_id: "att-old", page: 2, start: 0, end: 5 }, map)).toEqual({
      kind: "attachment",
      attachment_id: "att-new",
      page: 2,
      start: 0,
      end: 5,
    });
    const unknown = { kind: "attachment", attachment_id: "elsewhere", page: 1, start: 0, end: 5 };
    expect(remapSourceSpan(unknown, map)).toBe(unknown);
    const text = { kind: "text", start: 0, end: 5 };
    expect(remapSourceSpan(text, map)).toBe(text);
    expect(remapSourceSpan({}, map)).toEqual({});
    expect(remapSourceSpan("odd", map)).toBe("odd");
    expect(remapSourceSpan([1, 2], map)).toEqual([1, 2]);
  });
});

describe("affectsDrafts (which line edits reach the RFQ drafts)", () => {
  const BROKER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const base: LineRow = {
    id: "l1",
    broker_id: BROKER,
    request_id: "r1",
    line_no: 1,
    raw_text: "W12x26 x 50' qty 8",
    catalog_item_id: ITEM,
    category: "w_beam",
    description: "W12x26",
    dims: { d: 12, wt: 26 },
    grade_spec: "A992",
    qty: 8,
    unit: "pcs",
    length_ft: 50,
    length_text: "50'",
    cut_to_length: false,
    delivery_notes: null,
    flags: ["missing_grade"],
    confidence: 0.9,
    source_span: { kind: "text", start: 0, end: 10 },
    status: "confirmed",
    created_at: "2026-10-23T10:00:00Z",
    updated_at: "2026-10-23T10:00:00Z",
  };
  const changed = (after: Partial<LineRow>) => affectsDrafts(diffLine(base, { ...base, ...after }), base, { ...base, ...after });

  it("is true for every field the body is written from", () => {
    expect(changed({ qty: 12 })).toBe(true);
    expect(changed({ unit: "ft" })).toBe(true);
    expect(changed({ length_text: "40'", length_ft: 40 })).toBe(true);
    expect(changed({ grade_spec: null })).toBe(true);
    expect(changed({ description: "W12x30" })).toBe(true);
    expect(changed({ raw_text: "W12x26 x 50' qty 8 / W12x26 A992" })).toBe(true);
    expect(changed({ catalog_item_id: null })).toBe(true);
    expect(changed({ dims: { t: 0.375, w: 48, l: 96 } })).toBe(true);
    expect(changed({ delivery_notes: "deliver to Waco" })).toBe(true);
  });

  it("is true when the line is removed", () => {
    expect(changed({ status: "removed" })).toBe(true);
    expect(affectsDrafts(diffLine({ ...base, status: "removed" }, base), { ...base, status: "removed" }, base)).toBe(true);
  });

  it("is false for flags, confidence, category, cut to length, and a parsed/confirmed/custom status change", () => {
    expect(changed({ flags: [] })).toBe(false);
    expect(changed({ confidence: 1 })).toBe(false);
    expect(changed({ category: "channel" })).toBe(false);
    expect(changed({ cut_to_length: true })).toBe(false);
    expect(changed({ status: "custom" })).toBe(false);
    expect(changed({})).toBe(false);
  });
});

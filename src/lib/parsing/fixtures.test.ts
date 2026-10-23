// Fixture-driven parser tests (PLAN Step 4, PRD section 15 requests 1 to 5).
//
// Each test loads the recorded model output under fixtures/recorded/requests/,
// rebuilds the extraction document from the fixture exactly as parseRequest
// would (src/lib/parsing/fixture-documents.ts), checks that the recording was
// made from that very document (sha256), validates the output with the Zod
// schema, runs the deterministic pass against the seed catalog, and asserts
// the line counts, links, values, flags, and spans the step contract names.
// No network, no database: a stale recording fails here, and npm run
// record-fixtures refreshes it against the live model.

import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { generateCatalog } from "@/lib/catalog/generate";
import { readFixture, REQUEST_FIXTURES, type RequestFixtureName } from "@/lib/fixtures";
import { aliasIndexFromCatalog } from "./alias-index";
import { SOURCE_TEXT_HEADER, type ExtractionDocument } from "./document";
import {
  buildFixtureDocument,
  fixtureAttachmentId,
  fixtureBaseName,
  fixtureEntityId,
  parseRecording,
  recordingPath,
  recordingSchema,
  sha256Hex,
  type Recording,
} from "./fixture-documents";
import { normalizeExtractedLines, type NormalizedLine } from "./normalize";
import { extractMaterialLinesOutputSchema } from "./schema";

const EM_DASH = String.fromCharCode(0x2014); // built from the code point so this file holds none
const index = aliasIndexFromCatalog(generateCatalog());

type Loaded = {
  raw: string;
  recording: Recording;
  doc: ExtractionDocument;
  sha256: string;
  lines: NormalizedLine[];
};

const cache = new Map<string, Promise<Loaded>>();

function load(name: RequestFixtureName): Promise<Loaded> {
  let pending = cache.get(name);
  if (!pending) {
    pending = (async () => {
      const raw = readFileSync(recordingPath(name), "utf8");
      const recording = parseRecording(raw);
      const { doc, sha256 } = await buildFixtureDocument(name);
      const output = extractMaterialLinesOutputSchema.parse(recording.output);
      const lines = normalizeExtractedLines(output, doc, index);
      return { raw, recording, doc, sha256, lines };
    })();
    cache.set(name, pending);
  }
  return pending;
}

/** The text of the segment a source_span points at, as the review screen would read it. */
function segmentText(doc: ExtractionDocument, line: NormalizedLine): string {
  const span = line.source_span;
  const segment = doc.segments.find((s) =>
    span.kind === "text"
      ? s.kind === "text"
      : s.kind === "attachment" && s.attachmentId === span.attachment_id && s.page === span.page,
  );
  if (!segment) throw new Error(`No segment for span ${JSON.stringify(span)}`);
  return segment.text.slice(span.start, span.end);
}

function byLineNo(lines: NormalizedLine[], n: number): NormalizedLine {
  const line = lines.find((l) => l.line_no === n);
  if (!line) throw new Error(`No line ${n}`);
  return line;
}

// ---------------------------------------------------------------------------
// The fixture-to-document helper
// ---------------------------------------------------------------------------

describe("buildFixtureDocument", () => {
  it("reads a .txt fixture as one text segment holding the file verbatim", async () => {
    const { doc, sha256 } = await buildFixtureDocument("single-hss.txt");
    const file = readFixture("requests/single-hss.txt").toString("utf8");
    expect(doc.segments).toHaveLength(1);
    expect(doc.segments[0]).toMatchObject({ kind: "text", text: file, start: SOURCE_TEXT_HEADER.length });
    expect(doc.text).toBe(SOURCE_TEXT_HEADER + file);
    expect(sha256).toBe(sha256Hex(doc.text));
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads an .eml without PDFs as the mail text alone", async () => {
    const { doc } = await buildFixtureDocument("mixed-list.eml");
    expect(doc.segments).toHaveLength(1);
    expect(doc.segments[0].kind).toBe("text");
    expect(doc.text).toContain("W12x26 x 50' qty 8");
    expect(doc.text).toContain("> Dale, the 6 pcs of C8x11.5");
    expect(doc.text).not.toContain("Content-Type");
  });

  it("adds one attachment segment per PDF page with the numbered fixture attachment id", async () => {
    const { doc } = await buildFixtureDocument("pdf-list.eml");
    expect(doc.segments).toHaveLength(2);
    expect(doc.segments[0].kind).toBe("text");
    expect(doc.segments[1]).toMatchObject({
      kind: "attachment",
      attachmentId: fixtureAttachmentId(1),
      filename: "bryan-shop-list.pdf",
      page: 1,
    });
    expect(doc.text).toContain("=== ATTACHMENT: bryan-shop-list.pdf (page 1) ===\n");
    expect(doc.segments[1].text).toContain("PIPE2STD");
  });

  it("is deterministic", async () => {
    const a = await buildFixtureDocument("pdf-list.eml");
    const b = await buildFixtureDocument("pdf-list.eml");
    expect(a.sha256).toBe(b.sha256);
    expect(a.doc.text).toBe(b.doc.text);
  });

  it("refuses a name that is neither .txt nor .eml", async () => {
    await expect(buildFixtureDocument("pdf-list.pdf")).rejects.toThrow(/neither \.txt nor \.eml/);
  });

  it("names recordings after the fixture without its extension", () => {
    expect(fixtureBaseName("single-hss.txt")).toBe("single-hss");
    expect(fixtureBaseName("pdf-list.eml")).toBe("pdf-list");
    expect(recordingPath("mixed-list.eml")).toMatch(/fixtures[\\/]recorded[\\/]requests[\\/]mixed-list\.json$/);
    expect(fixtureAttachmentId(2)).toBe("fixture-attachment-2");
  });

  it("gives every fixture a stable, well-formed uuid for the llm_call activity row", () => {
    const ids = REQUEST_FIXTURES.map(fixtureEntityId);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(REQUEST_FIXTURES.length);
    expect(fixtureEntityId("single-hss.txt")).toBe(fixtureEntityId("single-hss.txt"));
  });
});

// ---------------------------------------------------------------------------
// Every recording
// ---------------------------------------------------------------------------

describe.each(REQUEST_FIXTURES)("recording for %s", (name) => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load(name);
  });

  it("exists, matches the recording shape, and names this fixture", () => {
    expect(existsSync(recordingPath(name))).toBe(true);
    expect(() => recordingSchema.parse(JSON.parse(f.raw))).not.toThrow();
    expect(f.recording.fixture).toBe(name);
    expect(["hand-authored", "recorded"]).toContain(f.recording.source);
    expect(f.recording.model).not.toBe("");
    expect(Number.isNaN(Date.parse(f.recording.recorded_at))).toBe(false);
  });

  it("was made from the document the fixture builds today (sha256)", () => {
    expect(f.recording.document_sha256).toBe(f.sha256);
  });

  it("holds output that passes the extraction schema, with no em dash anywhere", () => {
    expect(() => extractMaterialLinesOutputSchema.parse(f.recording.output)).not.toThrow();
    expect(f.raw).not.toContain(EM_DASH);
    expect(f.raw.endsWith("\n")).toBe(true);
  });

  it("keeps the model to strings, nulls, and the four judgment flags", () => {
    for (const line of f.recording.output.lines) {
      for (const pair of line.dims) {
        expect(typeof pair.value).toBe("string");
      }
      for (const flag of line.flags) {
        expect(["ambiguous_size", "ambiguous_unit", "possible_duplicate", "alternate_mentioned"]).toContain(flag);
      }
      expect(line.confidence).toBeGreaterThanOrEqual(0);
      expect(line.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("verifies every span and points each at the text it was read from", () => {
    expect(f.lines.length).toBe(f.recording.output.lines.length);
    for (const line of f.lines) {
      expect(line.span_verified, `line ${line.line_no}: ${line.raw_text}`).toBe(true);
      expect(segmentText(f.doc, line)).toBe(line.raw_text);
      expect(line.source_span.start).toBeLessThan(line.source_span.end);
    }
  });

  it("numbers lines from 1 in order and clamps confidence", () => {
    expect(f.lines.map((l) => l.line_no)).toEqual(f.lines.map((_, i) => i + 1));
    for (const line of f.lines) {
      expect(line.confidence).toBeGreaterThanOrEqual(0);
      expect(line.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("has exact offsets when hand-authored (they were computed from the document)", () => {
    if (f.recording.source !== "hand-authored") return;
    for (const line of f.recording.output.lines) {
      expect(f.doc.text.slice(line.span.start, line.span.end)).toBe(line.raw_text);
    }
  });
});

// ---------------------------------------------------------------------------
// Expected results per fixture (step contract 13)
// ---------------------------------------------------------------------------

describe("single-hss.txt", () => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load("single-hss.txt");
  });

  it("yields one line linked to HSS8x8x5/8 with every value read from the text", () => {
    expect(f.lines).toHaveLength(1);
    const line = f.lines[0];
    expect(line.catalog_item_id).toBe("HSS8x8x5/8");
    expect(line.description).toBe("HSS8x8x5/8");
    expect(line.category).toBe("hss_square");
    expect(line.dims).toEqual({ a: 8, b: 8, t: 0.625 });
    expect(line.qty).toBe(100);
    expect(line.unit).toBe("pcs");
    expect(line.length_ft).toBe(40);
    expect(line.grade_spec).toContain("A500");
    expect(line.cut_to_length).toBe(false);
    expect(line.delivery_notes).toContain("Fort Worth");
    expect(line.alternates_mentioned.length).toBeGreaterThan(0);
  });

  it("carries alternate_mentioned and none of the missing or unmatched flags", () => {
    const { flags } = f.lines[0];
    expect(flags).toContain("alternate_mentioned");
    for (const absent of ["missing_grade", "missing_qty", "missing_length", "unmatched_item"]) {
      expect(flags).not.toContain(absent);
    }
  });

  it("has a verified text span inside the source text", () => {
    const line = f.lines[0];
    expect(line.span_verified).toBe(true);
    expect(line.source_span.kind).toBe("text");
    const source = readFixture("requests/single-hss.txt").toString("utf8");
    expect(source.slice(line.source_span.start, line.source_span.end)).toBe(line.raw_text);
  });
});

describe("channel-heavier.txt", () => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load("channel-heavier.txt");
  });

  it("yields one line linked to C12x30, 6 pcs at 40 ft, no grade", () => {
    expect(f.lines).toHaveLength(1);
    const line = f.lines[0];
    expect(line.catalog_item_id).toBe("C12x30");
    expect(line.category).toBe("channel");
    expect(line.qty).toBe(6);
    expect(line.unit).toBe("pcs");
    expect(line.length_ft).toBe(40);
    expect(line.grade_spec).toBeNull();
    expect(line.cut_to_length).toBe(false);
  });

  it("flags the alternate and the missing grade, nothing else missing", () => {
    const { flags } = f.lines[0];
    expect(flags).toContain("alternate_mentioned");
    expect(flags).toContain("missing_grade");
    expect(flags).not.toContain("missing_qty");
    expect(flags).not.toContain("missing_length");
    expect(flags).not.toContain("unmatched_item");
  });
});

describe("mixed-list.eml", () => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load("mixed-list.eml");
  });

  it("yields four lines linked in list order", () => {
    expect(f.lines).toHaveLength(4);
    expect(f.lines.map((l) => l.catalog_item_id)).toEqual(["W12x26", "L2x2x1/4", "PL3/8", "HSS6x6x3/8"]);
    expect(f.lines.map((l) => l.category)).toEqual(["w_beam", "angle", "plate", "hss_square"]);
  });

  it("reads quantities and lengths from each line", () => {
    const [beam, angle, plate, tube] = f.lines;
    expect([beam.qty, beam.unit, beam.length_ft]).toEqual([8, "pcs", 50]);
    expect([angle.qty, angle.unit, angle.length_ft]).toEqual([40, "pcs", 20]);
    expect([plate.qty, plate.unit, plate.length_ft]).toEqual([10, "pcs", null]);
    expect([tube.qty, tube.unit, tube.length_ft]).toEqual([20, "pcs", 24]);
  });

  it("parses the plate dims and grade and needs no length for plate", () => {
    const plate = byLineNo(f.lines, 3);
    expect(plate.dims).toEqual({ t: 0.375, w: 48, l: 96 });
    expect(plate.grade_spec).toBe("A36");
    expect(plate.flags).not.toContain("missing_length");
    expect(plate.flags).not.toContain("missing_grade");
    expect(plate.flags).not.toContain("unmatched_item");
  });

  it("flags missing_grade on the three lines that state none", () => {
    for (const n of [1, 2, 4]) {
      const line = byLineNo(f.lines, n);
      expect(line.grade_spec).toBeNull();
      expect(line.flags, `line ${n}`).toContain("missing_grade");
      expect(line.flags, `line ${n}`).not.toContain("missing_length");
      expect(line.flags, `line ${n}`).not.toContain("missing_qty");
    }
  });

  it("places every span, verified, inside the source text", () => {
    const source = f.doc.segments[0];
    expect(source.kind).toBe("text");
    for (const line of f.lines) {
      expect(line.span_verified).toBe(true);
      expect(line.source_span.kind).toBe("text");
      expect(source.text.slice(line.source_span.start, line.source_span.end)).toBe(line.raw_text);
    }
  });

  it("takes nothing from the quoted thread or the signature", () => {
    for (const line of f.lines) {
      expect(line.raw_text).not.toMatch(/^>/);
      expect(line.raw_text).not.toContain("C8x11.5");
      expect(line.raw_text).not.toContain("wrote:");
      expect(line.raw_text).not.toContain("Lone Star");
      expect(line.raw_text).not.toContain("555-0142");
    }
  });
});

describe("ambiguous.txt", () => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load("ambiguous.txt");
  });

  it("yields two lines", () => {
    expect(f.lines).toHaveLength(2);
  });

  it("links the tube to HSS8x8x3/8 with 20 pcs at 40 and flags the alternate and the missing grade", () => {
    const tube = byLineNo(f.lines, 1);
    expect(tube.catalog_item_id).toBe("HSS8x8x3/8");
    expect(tube.category).toBe("hss_square");
    expect(tube.qty).toBe(20);
    expect(tube.unit).toBe("pcs");
    expect(tube.length_ft).toBe(40);
    expect(tube.grade_spec).toBeNull();
    expect(tube.flags).toContain("missing_grade");
    expect(tube.flags).toContain("alternate_mentioned");
    expect(tube.flags).not.toContain("unmatched_item");
    expect(tube.flags).not.toContain("missing_qty");
  });

  it("keeps the clips angle as an unmatched line with nulls and the ambiguous_size flag", () => {
    const angle = byLineNo(f.lines, 2);
    expect([null, "angle"]).toContain(angle.category);
    expect(angle.catalog_item_id).toBeNull();
    expect(angle.qty).toBeNull();
    expect(angle.length_ft).toBeNull();
    expect(angle.grade_spec).toBeNull();
    expect(angle.flags).toContain("ambiguous_size");
    expect(angle.flags).toContain("missing_qty");
    expect(angle.flags).toContain("unmatched_item");
  });
});

describe("pdf-list.eml", () => {
  let f: Loaded;
  beforeAll(async () => {
    f = await load("pdf-list.eml");
  });

  it("yields five lines linked in table order", () => {
    expect(f.lines).toHaveLength(5);
    expect(f.lines.map((l) => l.catalog_item_id)).toEqual(["HSS4x4x1/4", "W8x18", "L3x3x1/4", "PL1/2", "PIPE2STD"]);
  });

  it("reads quantity, length, and grade from each row", () => {
    const [tube, beam, angle, plate, pipe] = f.lines;
    expect([tube.qty, tube.unit, tube.length_ft]).toEqual([30, "pcs", 24]);
    expect(tube.grade_spec).toContain("A500");
    expect([beam.qty, beam.unit, beam.length_ft, beam.grade_spec]).toEqual([6, "pcs", 40, "A992"]);
    expect([angle.qty, angle.unit, angle.length_ft, angle.grade_spec]).toEqual([24, "pcs", 20, "A36"]);
    expect([plate.qty, plate.unit, plate.length_ft, plate.grade_spec]).toEqual([4, "pcs", null, "A36"]);
    expect([pipe.qty, pipe.unit, pipe.length_ft]).toEqual([12, "pcs", 21]);
    expect(pipe.grade_spec).toContain("A53");
  });

  it("parses the plate sheet size and needs no length for it", () => {
    const plate = byLineNo(f.lines, 4);
    expect(plate.dims).toMatchObject({ t: 0.5, w: 60, l: 120 });
    expect(plate.flags).not.toContain("missing_length");
  });

  it("flags nothing missing or unmatched on a complete table", () => {
    for (const line of f.lines) {
      for (const absent of ["missing_grade", "missing_qty", "missing_length", "unmatched_item"]) {
        expect(line.flags, `line ${line.line_no}`).not.toContain(absent);
      }
    }
  });

  it("gives every line an attachment span on page 1 of the first fixture attachment", () => {
    const page = f.doc.segments.find((s) => s.kind === "attachment");
    expect(page).toBeDefined();
    for (const line of f.lines) {
      expect(line.span_verified).toBe(true);
      expect(line.source_span.kind).toBe("attachment");
      if (line.source_span.kind !== "attachment") continue;
      expect(line.source_span.attachment_id).toBe(fixtureAttachmentId(1));
      expect(line.source_span.page).toBe(1);
      expect(page!.text.slice(line.source_span.start, line.source_span.end)).toBe(line.raw_text);
    }
  });
});

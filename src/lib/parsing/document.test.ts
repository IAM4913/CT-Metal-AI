import { describe, expect, it } from "vitest";
import { attachmentHeader, buildExtractionDocument, locateSpan, SOURCE_TEXT_HEADER, toSourceSpan } from "./document";

const TEXT = "W12x26 x 50' qty 8\nL2x2x1/4 x 20' qty 40";
const PAGE = "Item Qty\nHSS4x4x1/4 30 pcs";

const doc = buildExtractionDocument([
  { kind: "text", text: TEXT },
  { kind: "attachment", attachmentId: "att-1", filename: "list.pdf", page: 1, text: PAGE },
]);

describe("buildExtractionDocument", () => {
  it("uses the exact header strings", () => {
    expect(SOURCE_TEXT_HEADER).toBe("=== SOURCE TEXT ===\n");
    expect(attachmentHeader("list.pdf", 1)).toBe("\n\n=== ATTACHMENT: list.pdf (page 1) ===\n");
    expect(attachmentHeader("bryan-shop-list.pdf", 2)).toBe("\n\n=== ATTACHMENT: bryan-shop-list.pdf (page 2) ===\n");
  });

  it("joins the segments with their headers", () => {
    expect(doc.text).toBe(`${SOURCE_TEXT_HEADER}${TEXT}${attachmentHeader("list.pdf", 1)}${PAGE}`);
  });

  it("records each segment's text offsets, not its header", () => {
    const [source, page] = doc.segments;
    expect(source.start).toBe(SOURCE_TEXT_HEADER.length);
    expect(source.end).toBe(SOURCE_TEXT_HEADER.length + TEXT.length);
    expect(doc.text.slice(source.start, source.end)).toBe(TEXT);
    expect(page.start).toBe(source.end + attachmentHeader("list.pdf", 1).length);
    expect(page.end).toBe(doc.text.length);
    expect(doc.text.slice(page.start, page.end)).toBe(PAGE);
    expect(page.kind).toBe("attachment");
  });

  it("keeps the segment metadata", () => {
    const page = doc.segments[1];
    expect(page).toMatchObject({ kind: "attachment", attachmentId: "att-1", filename: "list.pdf", page: 1 });
  });

  it("gives an empty document for no segments and a header-only one for empty text", () => {
    expect(buildExtractionDocument([])).toEqual({ text: "", segments: [] });
    const empty = buildExtractionDocument([{ kind: "text", text: "" }]);
    expect(empty.text).toBe(SOURCE_TEXT_HEADER);
    expect(empty.segments[0]).toMatchObject({ start: SOURCE_TEXT_HEADER.length, end: SOURCE_TEXT_HEADER.length });
  });
});

describe("locateSpan", () => {
  const raw = "L2x2x1/4 x 20' qty 40";
  const start = doc.text.indexOf(raw);
  const end = start + raw.length;

  it("verifies a hint that slices to the raw text", () => {
    expect(locateSpan(doc, raw, { start, end })).toEqual({ start, end, verified: true });
  });

  it("corrects a hint that is off by a few characters", () => {
    expect(locateSpan(doc, raw, { start: start + 3, end: end + 3 })).toEqual({ start, end, verified: true });
    expect(locateSpan(doc, raw, { start: start - 2, end: end - 5 })).toEqual({ start, end, verified: true });
  });

  it("picks the occurrence nearest the hint when the text repeats", () => {
    const twice = buildExtractionDocument([{ kind: "text", text: "8 pcs W12x26\n8 pcs C12x30\n8 pcs L2x2x1/4" }]);
    const first = twice.text.indexOf("8 pcs");
    const second = twice.text.indexOf("8 pcs", first + 1);
    const third = twice.text.indexOf("8 pcs", second + 1);
    expect(locateSpan(twice, "8 pcs", { start: second + 1, end: second + 6 })).toEqual({
      start: second,
      end: second + 5,
      verified: true,
    });
    expect(locateSpan(twice, "8 pcs", { start: third + 2, end: third + 7 }).start).toBe(third);
    expect(locateSpan(twice, "8 pcs", { start: 0, end: 5 }).start).toBe(first);
  });

  it("finds text whose whitespace differs from the document", () => {
    const found = locateSpan(doc, "  L2x2x1/4   x 20'\tqty 40 ", { start: 0, end: 0 });
    expect(found).toEqual({ start, end, verified: true });
  });

  it("returns the hint unverified when the text is not in the document", () => {
    expect(locateSpan(doc, "C12x30 x 40' qty 6", { start: 5, end: 23 })).toEqual({ start: 5, end: 23, verified: false });
  });

  it("never verifies blank raw text", () => {
    expect(locateSpan(doc, "", { start: 3, end: 3 })).toEqual({ start: 3, end: 3, verified: false });
    expect(locateSpan(doc, "   ", { start: 3, end: 6 })).toEqual({ start: 3, end: 6, verified: false });
  });

  it("escapes regex characters in the loose search", () => {
    const tricky = buildExtractionDocument([{ kind: "text", text: "plate (48 x 96) $12.50 [A36]" }]);
    const found = locateSpan(tricky, "plate  (48 x 96)   $12.50 [A36]", { start: 0, end: 0 });
    expect(found.verified).toBe(true);
    expect(tricky.text.slice(found.start, found.end)).toBe("plate (48 x 96) $12.50 [A36]");
  });
});

describe("toSourceSpan", () => {
  it("maps a span in the source text to offsets into source_text", () => {
    const raw = "L2x2x1/4 x 20' qty 40";
    const start = doc.text.indexOf(raw);
    const span = toSourceSpan(doc, { start, end: start + raw.length });
    expect(span).toEqual({ kind: "text", start: TEXT.indexOf(raw), end: TEXT.indexOf(raw) + raw.length });
    if (span.kind === "text") expect(TEXT.slice(span.start, span.end)).toBe(raw);
  });

  it("maps a span in an attachment page to attachment id, page, and page offsets", () => {
    const raw = "HSS4x4x1/4 30 pcs";
    const start = doc.text.indexOf(raw);
    const span = toSourceSpan(doc, { start, end: start + raw.length });
    expect(span).toEqual({
      kind: "attachment",
      attachment_id: "att-1",
      page: 1,
      start: PAGE.indexOf(raw),
      end: PAGE.indexOf(raw) + raw.length,
    });
    if (span.kind === "attachment") expect(PAGE.slice(span.start, span.end)).toBe(raw);
  });

  it("clamps a span that runs past its segment", () => {
    const source = doc.segments[0];
    const span = toSourceSpan(doc, { start: source.end - 5, end: source.end + 40 });
    expect(span).toEqual({ kind: "text", start: TEXT.length - 5, end: TEXT.length });
  });

  it("assigns a start inside a header to the segment that follows it", () => {
    const page = doc.segments[1];
    const span = toSourceSpan(doc, { start: page.start - 10, end: page.start + 4 });
    expect(span).toEqual({ kind: "attachment", attachment_id: "att-1", page: 1, start: 0, end: 4 });
  });

  it("assigns a start past the end to the last segment, clamped", () => {
    const span = toSourceSpan(doc, { start: doc.text.length + 50, end: doc.text.length + 60 });
    expect(span).toEqual({ kind: "attachment", attachment_id: "att-1", page: 1, start: PAGE.length, end: PAGE.length });
  });

  it("never puts end before start", () => {
    const source = doc.segments[0];
    const span = toSourceSpan(doc, { start: source.start + 10, end: source.start + 2 });
    expect(span).toEqual({ kind: "text", start: 10, end: 10 });
  });

  it("falls back to an empty text span when the document has no segments", () => {
    expect(toSourceSpan({ text: "", segments: [] }, { start: 0, end: 4 })).toEqual({ kind: "text", start: 0, end: 0 });
  });
});

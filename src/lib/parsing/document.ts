// The extraction document: the request text and every attachment page joined
// into one string the model reads, plus the bookkeeping that maps a character
// offset in that string back to the segment it came from.
//
// Layout of document.text (headers are exact; tests and recordings depend on them):
//
//   === SOURCE TEXT ===\n<source text>
//   \n\n=== ATTACHMENT: <filename> (page <n>) ===\n<page text>
//   ...
//
// Each segment records the absolute start and end offsets of its own text
// (never its header) inside document.text, so a span the model returns can be
// verified against the text (locateSpan) and then expressed relative to the
// segment it falls in (toSourceSpan), which is the source_span shape stored on
// request_lines: character offsets into requests.source_text, or an attachment
// id plus page plus offsets into that page's text.

export type DocumentSegment =
  | { kind: "text"; text: string }
  | { kind: "attachment"; attachmentId: string; filename: string; page: number; text: string };

export type PositionedSegment = DocumentSegment & { start: number; end: number };

export type ExtractionDocument = {
  text: string;
  segments: PositionedSegment[];
};

/** request_lines.source_span, PRD section 7. */
export type SourceSpan =
  | { kind: "text"; start: number; end: number }
  | { kind: "attachment"; attachment_id: string; page: number; start: number; end: number };

export type LocatedSpan = { start: number; end: number; verified: boolean };

export const SOURCE_TEXT_HEADER = "=== SOURCE TEXT ===\n";

export function attachmentHeader(filename: string, page: number): string {
  return `\n\n=== ATTACHMENT: ${filename} (page ${page}) ===\n`;
}

/**
 * Join the segments into one document. The header goes before each segment;
 * the recorded start and end are those of the segment's text alone.
 */
export function buildExtractionDocument(segments: DocumentSegment[]): ExtractionDocument {
  let text = "";
  const positioned: PositionedSegment[] = [];
  for (const segment of segments) {
    text += segment.kind === "text" ? SOURCE_TEXT_HEADER : attachmentHeader(segment.filename, segment.page);
    const start = text.length;
    text += segment.text;
    positioned.push({ ...segment, start, end: text.length });
  }
  return { text, segments: positioned };
}

/**
 * Check the model's span against the document and repair it when it is off.
 *
 *   1. doc.text.slice(hint.start, hint.end) === rawText: the hint, verified.
 *   2. rawText occurs verbatim somewhere: the occurrence nearest hint.start, verified.
 *   3. rawText occurs with different whitespace (runs of whitespace treated as
 *      equal, leading and trailing whitespace ignored): that occurrence, verified.
 *   4. otherwise the hint as given, verified false. toSourceSpan still clamps it.
 *
 * An empty or whitespace-only rawText can match anywhere, so it is never verified.
 */
export function locateSpan(doc: ExtractionDocument, rawText: string, hint: { start: number; end: number }): LocatedSpan {
  const unverified: LocatedSpan = { start: hint.start, end: hint.end, verified: false };
  if (rawText.trim() === "") return unverified;

  if (doc.text.slice(hint.start, hint.end) === rawText) {
    return { start: hint.start, end: hint.end, verified: true };
  }

  const exact = nearestOccurrence(doc.text, rawText, hint.start);
  if (exact !== null) return { start: exact, end: exact + rawText.length, verified: true };

  const loose = nearestLooseOccurrence(doc.text, rawText, hint.start);
  if (loose !== null) return { ...loose, verified: true };

  return unverified;
}

/** The start offset of the occurrence of needle in haystack closest to near, or null. */
function nearestOccurrence(haystack: string, needle: string, near: number): number | null {
  let best: number | null = null;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    if (best === null || Math.abs(at - near) < Math.abs(best - near)) best = at;
    from = at + 1;
  }
  return best;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whitespace-insensitive search: every run of whitespace in the needle matches
 * any run of whitespace in the haystack; leading and trailing whitespace of
 * the needle is dropped. Returns the match nearest to near.
 */
function nearestLooseOccurrence(haystack: string, needle: string, near: number): { start: number; end: number } | null {
  const parts = needle.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) return null;
  const pattern = new RegExp(parts.map(escapeRegExp).join("\\s+"), "g");
  let best: { start: number; end: number } | null = null;
  for (const match of haystack.matchAll(pattern)) {
    const start = match.index;
    if (best === null || Math.abs(start - near) < Math.abs(best.start - near)) {
      best = { start, end: start + match[0].length };
    }
  }
  return best;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Express an absolute document span relative to the segment that contains
 * span.start. A start that falls in a header (or before the first segment)
 * belongs to the segment that follows it; a start past the end belongs to the
 * last segment. Offsets are clamped to the segment's text, and end is never
 * before start.
 */
export function toSourceSpan(doc: ExtractionDocument, span: { start: number; end: number }): SourceSpan {
  const segment = segmentFor(doc, span.start);
  if (!segment) return { kind: "text", start: 0, end: 0 };

  const length = segment.end - segment.start;
  const start = clamp(span.start - segment.start, 0, length);
  const end = clamp(span.end - segment.start, start, length);

  if (segment.kind === "text") return { kind: "text", start, end };
  return { kind: "attachment", attachment_id: segment.attachmentId, page: segment.page, start, end };
}

function segmentFor(doc: ExtractionDocument, offset: number): PositionedSegment | null {
  const { segments } = doc;
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (offset >= segment.start && offset <= segment.end) return segment;
  }
  const following = segments.find((segment) => segment.start > offset);
  return following ?? segments[segments.length - 1];
}

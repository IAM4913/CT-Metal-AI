// .eml parsing for intake and reply ingestion.
//
// parseEml() wraps mailparser's simpleParser and returns one flat, typed shape
// (ParsedEml) so the rest of the app never touches mailparser's loose types.
// Rules:
//   text         the text/plain part when it has content, otherwise our own
//                htmlToText(html). mailparser's built-in html-to-text pass is
//                turned off so the fallback is deterministic and dependency free.
//   html         the text/html part as sent (cid: links kept as-is, not inflated
//                into base64 data URIs), or null when there is none.
//   attachments  every MIME attachment except inline/related images, which are
//                signature logos and tracking pixels; they are kept only when
//                they are the only attachments. Each carries its bytes, size,
//                and a sha256 hex digest (node:crypto).
//   addresses    flattened to bare address strings (groups expanded); the From
//                header keeps its display name.
//   references   always an array (mailparser gives a string for a single id).
//
// parsedEmlHeadersSchema validates the header fields before intake writes a
// messages row. ParsedEml has more fields than the schema; z.object strips the
// extras, so parsedEmlHeadersSchema.parse(parsed) yields just the headers.

import { createHash } from "node:crypto";
import { simpleParser, type AddressObject, type Attachment } from "mailparser";
import { z } from "zod";

export type ParsedEmlAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
  sha256: string;
};

export type ParsedEml = {
  from: { name: string | null; address: string } | null;
  to: string[];
  cc: string[];
  subject: string | null;
  date: Date | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string;
  html: string | null;
  attachments: ParsedEmlAttachment[];
};

// Loose on purpose: real mail carries addresses that strict RFC validators
// reject (bare host names, odd local parts). One "@" with something on each
// side and no whitespace is enough to store and match on.
const emailAddressSchema = z.string().trim().min(3).regex(/^[^\s@]+@[^\s@]+$/, "Not an email address");

export const parsedEmlHeadersSchema = z.object({
  from: z.object({ name: z.string().nullable(), address: emailAddressSchema }).nullable(),
  to: z.array(emailAddressSchema),
  cc: z.array(emailAddressSchema),
  subject: z.string().nullable(),
  date: z.date().nullable(),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
});

export type ParsedEmlHeaders = z.infer<typeof parsedEmlHeadersSchema>;

const FALLBACK_ATTACHMENT_NAME = "attachment";

export async function parseEml(raw: Buffer | string): Promise<ParsedEml> {
  const mail = await simpleParser(raw, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    keepCidLinks: true,
  });

  const html = typeof mail.html === "string" && mail.html.trim() !== "" ? mail.html : null;
  const plain = typeof mail.text === "string" ? mail.text : "";
  const text = plain.trim() !== "" ? plain : html ? htmlToText(html) : "";

  return {
    from: fromAddress(mail.from),
    to: flattenAddresses(mail.to),
    cc: flattenAddresses(mail.cc),
    subject: nonBlank(mail.subject),
    date: mail.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
    messageId: nonBlank(mail.messageId),
    inReplyTo: nonBlank(mail.inReplyTo),
    references: toList(mail.references),
    text,
    html,
    attachments: selectAttachments(mail.attachments).map(toParsedAttachment),
  };
}

function nonBlank(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((s) => s.trim()).filter((s) => s !== "");
}

function fromAddress(from: AddressObject | undefined): ParsedEml["from"] {
  const first = flattenAddressObjects(from ? [from] : [])[0];
  if (!first) return null;
  return first;
}

function flattenAddresses(value: AddressObject | AddressObject[] | undefined): string[] {
  const objects = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return flattenAddressObjects(objects).map((a) => a.address);
}

// Walks address groups ("Team: a@x, b@x;") so every real address is listed once.
function flattenAddressObjects(objects: AddressObject[]): { name: string | null; address: string }[] {
  const out: { name: string | null; address: string }[] = [];
  const seen = new Set<string>();
  const visit = (entries: AddressObject["value"]) => {
    for (const entry of entries) {
      if (entry.group) visit(entry.group);
      const address = entry.address?.trim();
      if (!address || seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      out.push({ name: nonBlank(entry.name), address });
    }
  };
  for (const obj of objects) visit(obj.value);
  return out;
}

function isInlineImage(a: Attachment): boolean {
  const isImage = a.contentType.toLowerCase().startsWith("image/");
  const inline = a.related === true || (a.contentDisposition ?? "").toLowerCase() === "inline";
  return isImage && inline;
}

function selectAttachments(all: Attachment[]): Attachment[] {
  const real = all.filter((a) => !isInlineImage(a));
  return real.length > 0 ? real : all;
}

function toParsedAttachment(a: Attachment): ParsedEmlAttachment {
  const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? []);
  return {
    filename: nonBlank(a.filename) ?? FALLBACK_ATTACHMENT_NAME,
    contentType: a.contentType,
    content,
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------

// Block boundaries are marked with two private sentinels while tags are being
// replaced, then resolved to line breaks in one pass:
//   LINE_BREAK  (div, li, tr, table, ...): the next text starts on a new line
//   PARA_BREAK  (p, blockquote, headings, lists, pre, hr): a blank line between
// A run of sentinels and br newlines collapses to one or two newlines, so
// Gmail's one-div-per-line markup stays single spaced while paragraphs keep
// their blank line, and nothing ever produces more than one blank line.
const LINE_BREAK = "\u0001";
const PARA_BREAK = "\u0002";
const PARA_TAG = /<\/?(?:p|blockquote|h[1-6]|ul|ol|dl|pre|hr)\b[^>]*>/gi;
const LINE_TAG =
  /<\/?(?:div|li|tr|table|thead|tbody|tfoot|dt|dd|section|article|header|footer|address|nav|aside|main|form|fieldset)\b[^>]*>/gi;
const CELL_END = /<\/(?:td|th)\s*>/gi;
const BR = /<br\s*\/?>/gi;
const PRE_BLOCK = /<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi;
const DROP_BLOCKS = [
  /<!--[\s\S]*?-->/g,
  /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
  /<head\b[^>]*>[\s\S]*?<\/head\s*>/gi,
];
const ANY_TAG = /<\/?[a-zA-Z][^>]*>|<![^>]*>/g;
const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;
const BREAK_RUN = /[ \t]*[\u0001\u0002\n](?:[ \t]*[\u0001\u0002\n])*[ \t]*/g;

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["ndash", "–"],
  ["mdash", String.fromCharCode(0x2014)], // built from the code point so this file holds no em dash
  ["hellip", "…"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bull", "•"],
  ["middot", "·"],
  ["deg", "°"],
  ["times", "×"],
  ["frac14", "¼"],
  ["frac12", "½"],
  ["frac34", "¾"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["euro", "€"],
  ["pound", "£"],
  ["cent", "¢"],
]);

function decodeEntity(match: string, body: string): string {
  if (body[0] === "#") {
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  }
  return NAMED_ENTITIES.get(body.toLowerCase()) ?? match;
}

// One run of sentinels and br newlines becomes one or two newlines: br alone
// counts each br (capped at two); a block boundary adds a line to any br count
// (an empty div holding a br is a blank line); a paragraph boundary is at
// least a blank line.
function resolveBreaks(run: string): string {
  let brs = 0;
  let line = false;
  let para = false;
  for (const ch of run) {
    if (ch === "\n") brs++;
    else if (ch === LINE_BREAK) line = true;
    else if (ch === PARA_BREAK) para = true;
  }
  let count = brs;
  if (line || para) count = Math.max(brs + 1, para ? 2 : 1);
  return "\n".repeat(Math.min(count, 2));
}

/**
 * Deterministic HTML to plain text with no dependency. Drops script, style,
 * head, and comments; collapses source whitespace the way a browser does,
 * except that line breaks inside pre are kept (as a browser keeps them);
 * turns br and block tags into line breaks (p and other paragraph-level tags
 * into a blank line, div, li, tr and the like into a single break) and table
 * cell ends into spaces; strips every other tag; decodes the common named and
 * all numeric entities in one pass (so "&amp;lt;" becomes "&lt;", not "<");
 * trims each line; never leaves more than one blank line in a row.
 */
export function htmlToText(html: string): string {
  let s = html.replace(/\r\n?/g, "\n").replace(/[\u0001\u0002]/g, "");
  for (const re of DROP_BLOCKS) s = s.replace(re, " ");
  // Inside pre the newlines are content (a monospace material list,
  // Thunderbird's quoted text): each one becomes a br before the collapse
  // below would turn it into a space. Runs of spaces still collapse.
  s = s.replace(PRE_BLOCK, (block) => block.replace(/\n/g, "<br>"));
  s = s.replace(/\s+/g, " ");
  s = s.replace(BR, "\n");
  s = s.replace(PARA_TAG, PARA_BREAK);
  s = s.replace(LINE_TAG, LINE_BREAK);
  s = s.replace(CELL_END, " ");
  s = s.replace(ANY_TAG, "");
  s = s.replace(ENTITY, decodeEntity);
  s = s.replace(BREAK_RUN, resolveBreaks);
  const lines = s.split("\n").map((line) => line.replace(/[ \t ]+/g, " ").trim());
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

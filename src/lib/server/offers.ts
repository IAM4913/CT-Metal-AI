// Vendor replies and offers, server side (PRD FR-9, PLAN Step 6).
//
// Every business row (messages, vendor_offers, offer_lines, activity_log, the
// rfqs and requests status flips) is written through session.supabase, the RLS
// client, filtered on session.brokerId as well, and carries broker_id. Files go
// through storeAttachment() and the download in extractOffer() uses the admin
// Storage client, the one place the secret key touches this module (the
// attachments bucket has no user policies, see src/lib/server/attachments.ts).
//
// Ingestion (ingestReply):
//   paste  the text becomes an inbound messages row (from_email "" because the
//          reply names no sender; the RFQ says which vendor) and an offer with
//          source "email". The broker must name the RFQ.
//   eml    parseEml(); the RFQ is matched from In-Reply-To and References against
//          this request's outbound messages (matchReplyToRfq, matched_by
//          "thread"), else the broker's choice (matched_by "manual"), else
//          NeedsRfqChoiceError so the UI can offer the open RFQs. The raw .eml and
//          every attachment are stored under the message (owner_type "message",
//          owner_id the messages row id; the .eml is message.raw_attachment_id)
//          and the first PDF attachment becomes vendor_offers.attachment_id. One
//          owner for every file of one reply keeps the lookup simple and the raw
//          email viewable beside the offer.
//   pdf    no email exists, so no messages row: the offer (source "pdf") is
//          created first and the PDF stored under it (owner_type "vendor_offer",
//          owner_id the offer id), then linked as attachment_id.
// A reply can only be attached to an RFQ that went out (sent, responded,
// declined, or closed). Everything written for one reply is removed again when
// a later step fails (Cleanup), so a half-ingested reply never sits on the tab.
//
// Extraction (extractOffer): the document is the message body (text segment)
// followed by one segment per PDF page (the message's PDFs, then the offer's
// own attachment when it is not among them), the context is the RFQ's lines
// joined to request_lines, the call goes through callExtractionTool() with
// entity_type "vendor_offer", and the deterministic pass
// (src/lib/parsing/offers-normalize.ts) produces the rows. A reviewed offer
// goes back to "parsed" as soon as the model has answered and before its lines
// are touched, so a failure in the swap can never leave a green Reviewed badge
// over lines nobody reviewed. offer_lines are then replaced insert-first,
// delete-second, as parseRequest does for request lines.
// offer_lines.request_line_id is not null, so a line the model could not tie
// to an RFQ line is not stored as a row: its text goes into the offer's notes
// and the offer.extracted payload for the reviewer, never onto a guessed line
// (the broker adds it with addOfferLine once the request line is known). A
// declined reply sets the offer and its RFQ to "declined"; otherwise the RFQ
// becomes "responded". The request moves to "collecting" on the first offer
// and to "comparing" once every sent RFQ of the revision has answered
// (nextRequestStatus is the pure rule). When the model call fails the offer row
// is kept (the reply did arrive) and the RFQ and request statuses are settled
// from it right away, so an offer never sits under an RFQ still marked "sent".
//
// Manual quotes (createManualOffer) carry confidence 1 and an empty source_span;
// their flags come from the same computeOfferFlags() as extracted lines.
// Edits (updateOfferLine, addOfferLine, removeOfferLine, updateOffer,
// setOfferDeclined, markOfferReviewed) recompute flags where the inputs changed
// and log before/after. possible_duplicate is settled across the offer's lines
// whenever a line's request line or offered item changes, is added, or is
// removed (resettleOfferDuplicates): the pairs the change broke lose the flag,
// the pairs it made gain it, and a judgment flag on an untouched pair stays.

import { z } from "zod";
import { normalizeAlias } from "@/lib/catalog/normalize";
import { createAdminClient, type Tables, type TablesInsert, type TablesUpdate } from "@/lib/db/client";
import type { Json } from "@/lib/db/types";
import {
  alternateTypeSchema,
  availabilitySchema,
  freightBasisSchema,
  lineUnitSchema,
  priceBasisSchema,
  type MatchedBy,
  type OfferStatus,
  type RequestStatus,
  type RfqStatus,
} from "@/lib/db/enums";
import { parseEml, parsedEmlHeadersSchema, type ParsedEml } from "@/lib/mail/eml";
import { extractPdfPages } from "@/lib/mail/pdf-text";
import { matchReplyToRfq } from "@/lib/mail/thread-match";
import { buildExtractionDocument, type DocumentSegment } from "@/lib/parsing/document";
import { callExtractionTool } from "@/lib/parsing/extract";
import {
  carriedOfferFlags,
  computeOfferFlags,
  markOfferDuplicates,
  normalizeOfferOutput,
  offerConfidence,
  offerDuplicateKey,
  offeredItemCandidates,
  orderOfferFlags,
  type NormalizedOfferLine,
} from "@/lib/parsing/offers-normalize";
import { buildOfferUserMessage, OFFER_SYSTEM_PROMPT, type OfferContextLine } from "@/lib/parsing/offers-prompt";
import { EXTRACT_OFFER_LINES, extractOfferLinesOutputSchema, offerFlagValues, type OfferFlag } from "@/lib/parsing/offers-schema";
import { ATTACHMENTS_BUCKET, removeAttachmentObjects, storeAttachment } from "@/lib/server/attachments";
import { loadAliasIndex } from "@/lib/server/parse-request";
import { loadRfq, loadRfqs, SENT_RFQ_STATUSES } from "@/lib/server/routing";
import type { BrokerSession } from "@/lib/server/session";

const PDF_MIME = "application/pdf";
const EML_MIME = "message/rfc822";

export type OfferRow = Tables<"vendor_offers">;
export type OfferLineRow = Tables<"offer_lines">;
type MessageRow = Tables<"messages">;
type AttachmentRow = Tables<"attachments">;
type RequestLineRow = Tables<"request_lines">;
type RfqRow = Tables<"rfqs">;

// ---------------------------------------------------------------------------
// Types and errors
// ---------------------------------------------------------------------------

export type IngestMode = "paste" | "eml" | "pdf";

export type IngestInput = {
  requestId: string;
  rfqId: string | null;
  mode: IngestMode;
  text?: string;
  file?: { name: string; mime: string; bytes: Uint8Array };
};

export type IngestResult = { offerId: string; rfqId: string; matchedBy: MatchedBy; needsRfqChoice: boolean };

/** What the headers of an unmatched reply said, for the RFQ picker. */
export type ReplySummary = {
  from: string | null;
  subject: string | null;
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  attachmentCount: number;
};

/**
 * The reply could not be tied to an RFQ from its headers and the broker named
 * none. Nothing was written. The action answers with the open RFQs to pick from.
 */
export class NeedsRfqChoiceError extends Error {
  readonly summary: ReplySummary;

  constructor(summary: ReplySummary) {
    super("Could not match this reply to an RFQ from its headers. Pick the RFQ it answers.");
    this.name = "NeedsRfqChoiceError";
    this.summary = summary;
  }
}

/** The uploaded file could not be read as an email or a PDF. Thrown before anything is written. */
export class ReplyFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReplyFileError";
  }
}

/**
 * The reply was saved as an offer but the model call or the normalization
 * failed. The offer stays (the reply did arrive) with no lines, so the broker
 * can re-extract or enter it by hand; the llm_call activity row has the detail.
 */
export class OfferExtractionError extends Error {
  readonly offerId: string;
  readonly rfqId: string;

  constructor(offerId: string, rfqId: string, cause: unknown) {
    super(`The reply was saved as an offer but its lines could not be extracted: ${errorMessage(cause)}`, { cause });
    this.name = "OfferExtractionError";
    this.offerId = offerId;
    this.rfqId = rfqId;
  }
}

// ---------------------------------------------------------------------------
// Schemas (shared with the server actions)
// ---------------------------------------------------------------------------

/** A date-only value from a date input, or a full ISO timestamp. */
const isoDateOrDateTime = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

/** quote_expires_at as stored: a date-only input becomes that day at 00:00 UTC. */
export function toExpiryTimestamp(value: string | null): string | null {
  if (value === null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : new Date(value).toISOString();
}

export const manualOfferLineSchema = z.object({
  requestLineId: z.uuid(),
  offeredDesc: z.string().trim().min(1, "Offered item is required"),
  isExactMatch: z.boolean(),
  alternateTypes: z.array(alternateTypeSchema),
  availableQty: z.number().positive().nullable(),
  unit: lineUnitSchema.nullable(),
  availability: availabilitySchema,
  readyDate: z.iso.date().nullable(),
  deliveryEstimateText: z.string().nullable(),
  unitPrice: z.number().nonnegative().nullable(),
  priceBasis: priceBasisSchema.nullable(),
});

export const manualOfferInputSchema = z.object({
  rfqId: z.uuid(),
  source: z.enum(["phone", "text"]),
  receivedAt: z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), "Received date is not a date"),
  paymentTerms: z.string().nullable(),
  earlyPayPct: z.number().min(0).max(100).nullable(),
  earlyPayDays: z.number().int().positive().nullable(),
  freightAmount: z.number().nonnegative().nullable(),
  freightBasis: freightBasisSchema,
  quoteExpiresAt: isoDateOrDateTime.nullable(),
  notes: z.string().nullable(),
  declined: z.boolean(),
  lines: z.array(manualOfferLineSchema).max(200),
});
export type ManualOfferInput = z.infer<typeof manualOfferInputSchema>;
export type ManualOfferLineInput = z.infer<typeof manualOfferLineSchema>;

/** The offer-line fields the grid may edit. Every key optional; null clears a nullable field. */
export const offerLinePatchSchema = z
  .object({
    request_line_id: z.uuid().optional(),
    offered_desc: z.string().trim().min(1, "Offered item is required").optional(),
    is_exact_match: z.boolean().optional(),
    alternate_types: z.array(alternateTypeSchema).optional(),
    available_qty: z.number().positive().nullable().optional(),
    unit: lineUnitSchema.nullable().optional(),
    availability: availabilitySchema.optional(),
    ready_date: z.iso.date().nullable().optional(),
    delivery_estimate_text: z.string().nullable().optional(),
    unit_price: z.number().nonnegative().nullable().optional(),
    price_basis: priceBasisSchema.nullable().optional(),
  })
  .strict();
export type OfferLinePatch = z.infer<typeof offerLinePatchSchema>;

/** The offer-level fields the card may edit. */
export const offerPatchSchema = z
  .object({
    payment_terms: z.string().nullable().optional(),
    early_pay_pct: z.number().min(0).max(100).nullable().optional(),
    early_pay_days: z.number().int().positive().nullable().optional(),
    freight_amount: z.number().nonnegative().nullable().optional(),
    freight_basis: freightBasisSchema.optional(),
    quote_expires_at: isoDateOrDateTime.nullable().optional(),
    received_at: isoDateOrDateTime.optional(),
    notes: z.string().optional(),
  })
  .strict();
export type OfferPatch = z.infer<typeof offerPatchSchema>;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** RFQ statuses that count as answered for the request's status. */
const ANSWERED_RFQ_STATUSES: readonly RfqStatus[] = ["responded", "declined", "closed"];

/**
 * Where the request goes after an offer changed: "collecting" on the first
 * offer against a request whose RFQs went out, "comparing" once every sent RFQ
 * of the revision has responded or declined. Null means no change: a request
 * before its RFQs went out (nothing to collect), one already comparing or
 * past it (never moved backwards), or a revision with no sent RFQ.
 */
export function nextRequestStatus(current: RequestStatus, rfqStatuses: readonly RfqStatus[]): RequestStatus | null {
  const sent = rfqStatuses.filter((status) => SENT_RFQ_STATUSES.includes(status));
  if (sent.length === 0) return null;
  const allAnswered = sent.every((status) => ANSWERED_RFQ_STATUSES.includes(status));
  switch (current) {
    case "rfqs_drafted":
    case "rfqs_sent":
      return allAnswered ? "comparing" : "collecting";
    case "collecting":
      return allAnswered ? "comparing" : null;
    default:
      return null;
  }
}

/**
 * An RFQ's status from the statuses of its offers: "responded" when any offer
 * stands (parsed or reviewed), "declined" when every offer is a decline, and
 * back to "sent" when it has none left.
 */
export function rfqStatusFromOffers(offerStatuses: readonly OfferStatus[]): RfqStatus {
  if (offerStatuses.length === 0) return "sent";
  return offerStatuses.some((status) => status !== "declined") ? "responded" : "declined";
}

export type PdfPages = { attachmentId: string; filename: string; pages: string[] };

/**
 * The extraction document's segments: the reply text first (only when there is
 * some), then one segment per PDF page in attachment order. A PDF upload with
 * no email has no text segment.
 */
export function buildOfferSegments(bodyText: string | null, pdfs: PdfPages[]): DocumentSegment[] {
  const segments: DocumentSegment[] = [];
  if (bodyText !== null && bodyText.trim() !== "") segments.push({ kind: "text", text: bodyText });
  for (const pdf of pdfs) {
    pdf.pages.forEach((text, i) => {
      segments.push({ kind: "attachment", attachmentId: pdf.attachmentId, filename: pdf.filename, page: i + 1, text });
    });
  }
  return segments;
}

function jsonObject(value: Json): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** One request line as the model's context (src/lib/parsing/offers-prompt.ts). */
export function toContextLine(
  line: Pick<
    RequestLineRow,
    "id" | "line_no" | "description" | "qty" | "unit" | "length_ft" | "length_text" | "grade_spec" | "category" | "dims"
  >,
  designation: string | null,
): OfferContextLine {
  return {
    request_line_id: line.id,
    line_no: line.line_no,
    designation,
    description: line.description,
    qty: line.qty,
    unit: line.unit,
    length_ft: line.length_ft,
    length_text: line.length_text,
    grade_spec: line.grade_spec,
    category: line.category,
    dims: jsonObject(line.dims),
  };
}

/**
 * The note kept on an offer for the lines the model could not tie to an RFQ
 * line (offer_lines.request_line_id is not null, so they are not rows). Null
 * when every line was tied.
 */
export function untiedLinesNote(lines: ReadonlyArray<Pick<NormalizedOfferLine, "offered_desc" | "raw_text" | "unit_price" | "price_basis">>): string | null {
  if (lines.length === 0) return null;
  const items = lines.map((line) => {
    const price = line.unit_price === null ? "" : ` at ${line.unit_price}${line.price_basis ? ` ${line.price_basis}` : ""}`;
    return `  - ${line.offered_desc}${price}: "${line.raw_text.trim()}"`;
  });
  return `${lines.length} line${lines.length === 1 ? "" : "s"} could not be tied to a request line and ${lines.length === 1 ? "was" : "were"} not stored:\n${items.join("\n")}`;
}

/** Join the non-blank parts with a blank line between, or "" (vendor_offers.notes is not null). */
export function joinOfferNotes(...parts: Array<string | null | undefined>): string {
  return parts.map(clean).filter((p): p is string => p !== null).join("\n\n");
}

/**
 * is_exact_match and alternate_types agree after an edit: exact means no
 * alternate types, and naming an alternate type makes the line an alternate.
 * The field the broker just set wins.
 */
export function reconcileExactness(
  patch: Pick<OfferLinePatch, "is_exact_match" | "alternate_types">,
  current: { is_exact_match: boolean; alternate_types: OfferLineRow["alternate_types"] },
): { is_exact_match: boolean; alternate_types: OfferLineRow["alternate_types"] } {
  if (patch.alternate_types !== undefined) {
    const types = Array.from(new Set(patch.alternate_types));
    return { is_exact_match: types.length === 0 ? (patch.is_exact_match ?? current.is_exact_match) : false, alternate_types: types };
  }
  if (patch.is_exact_match !== undefined) {
    return { is_exact_match: patch.is_exact_match, alternate_types: patch.is_exact_match ? [] : current.alternate_types };
  }
  return { is_exact_match: current.is_exact_match, alternate_types: current.alternate_types };
}

/** Flags of a stored offer line from its values, the judgment flags it carries, and whether its offer is declined. */
export function recomputeOfferLineFlags(
  line: Pick<OfferLineRow, "request_line_id" | "unit_price" | "available_qty" | "availability" | "flags">,
  declined: boolean,
): OfferFlag[] {
  return computeOfferFlags({
    request_line_id: line.request_line_id,
    unit_price: line.unit_price,
    available_qty: line.available_qty,
    availability: line.availability,
    declined,
    judgment: carriedOfferFlags(line.flags),
  });
}

/** The app's flags among a stored row's flags (unknown strings dropped). */
export function rowOfferFlags(flags: readonly string[]): OfferFlag[] {
  return flags.filter((flag): flag is OfferFlag => (offerFlagValues as readonly string[]).includes(flag));
}

/**
 * Offer lines in display order: by the request line they answer (line_no),
 * then created_at, then id. Every line of one extraction is inserted in one
 * statement, so they all carry the same created_at (Postgres now() is the
 * transaction time) and created_at alone left the order to the random ids.
 * A line whose request line is not in the map sorts last.
 */
export function sortOfferLines<T extends Pick<OfferLineRow, "request_line_id" | "created_at" | "id">>(
  lines: readonly T[],
  lineNoById: ReadonlyMap<string, number>,
): T[] {
  const rank = (line: T): number => lineNoById.get(line.request_line_id) ?? Number.POSITIVE_INFINITY;
  return [...lines].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The keys whose values differ between two rows, with before and after values of those keys only. */
export function diffRows<T extends object, K extends keyof T>(
  before: T,
  after: T,
  keys: readonly K[],
): { changed: K[]; before: Partial<Pick<T, K>>; after: Partial<Pick<T, K>> } {
  const changed: K[] = [];
  const b: Partial<Pick<T, K>> = {};
  const a: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (sameJson(before[key], after[key])) continue;
    changed.push(key);
    b[key] = before[key];
    a[key] = after[key];
  }
  return { changed, before: b, after: a };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Turn a pasted reply, an uploaded .eml, or an uploaded PDF into a messages row
 * (paste and eml), a vendor_offers row, and its extracted offer_lines. See the
 * module header for what each mode writes and where files are stored.
 *
 * Throws NeedsRfqChoiceError (nothing written) when the RFQ is unknown,
 * ReplyFileError (nothing written) when the file cannot be read, and
 * OfferExtractionError (the offer is kept) when the model call fails.
 */
export async function ingestReply(session: BrokerSession, input: IngestInput): Promise<IngestResult> {
  const request = await loadRequest(session, input.requestId);
  switch (input.mode) {
    case "paste":
      return ingestPaste(session, request, input);
    case "eml":
      return ingestEml(session, request, input);
    case "pdf":
      return ingestPdf(session, request, input);
  }
}

async function ingestPaste(session: BrokerSession, request: Tables<"requests">, input: IngestInput): Promise<IngestResult> {
  const text = input.text ?? "";
  if (text.trim() === "") {
    throw new Error("Paste the reply text first.");
  }
  if (input.rfqId === null) {
    throw new NeedsRfqChoiceError(emptySummary());
  }
  const rfq = await loadSentRfq(session, request, input.rfqId);
  const receivedAt = new Date();
  const cleanup = new Cleanup(session);

  const offerId = await cleanup.guard(async () => {
    const messageId = await insertInboundMessage(session, {
      broker_id: session.brokerId,
      direction: "in",
      rfq_id: rfq.id,
      request_id: request.id,
      // The pasted text names no sender; the RFQ says which vendor replied.
      from_email: "",
      to_emails: [],
      cc_emails: [],
      subject: "",
      body_text: text,
      body_html: null,
      received_at: receivedAt.toISOString(),
      provider_message_id: null,
      in_reply_to: null,
      references: [],
      matched_by: "manual",
      raw_attachment_id: null,
    });
    cleanup.message(messageId);

    const id = await insertOffer(session, {
      broker_id: session.brokerId,
      rfq_id: rfq.id,
      branch_id: rfq.branch_id,
      message_id: messageId,
      attachment_id: null,
      source: "email",
      status: "parsed",
      received_at: receivedAt.toISOString(),
      confidence: 0,
      notes: "",
    });
    cleanup.offer(id);
    await logActivity(session, "vendor_offer", id, "offer.ingested", {
      mode: "paste",
      rfq_id: rfq.id,
      matched_by: "manual",
      message_id: messageId,
      attachment_id: null,
    });
    return id;
  });

  await runExtraction(session, offerId, rfq.id);
  return { offerId, rfqId: rfq.id, matchedBy: "manual", needsRfqChoice: false };
}

async function ingestEml(session: BrokerSession, request: Tables<"requests">, input: IngestInput): Promise<IngestResult> {
  const file = requireFile(input, "eml");
  const parsed = await parseReplyEml(file.bytes);

  let matchedBy: MatchedBy;
  let rfq: RfqRow;
  if (input.rfqId !== null) {
    rfq = await loadSentRfq(session, request, input.rfqId);
    matchedBy = "manual";
  } else {
    const outbound = await loadOutboundRefs(session, request.id);
    const match = matchReplyToRfq({ inReplyTo: parsed.inReplyTo, references: parsed.references }, outbound);
    if (!match) throw new NeedsRfqChoiceError(summarize(parsed));
    rfq = await loadSentRfq(session, request, match.rfqId);
    matchedBy = match.matchedBy;
  }

  const receivedAt = validDate(parsed.date) ?? new Date();
  const cleanup = new Cleanup(session);

  const offerId = await cleanup.guard(async () => {
    const messageId = await insertInboundMessage(session, {
      broker_id: session.brokerId,
      direction: "in",
      rfq_id: rfq.id,
      request_id: request.id,
      from_email: parsed.from?.address ?? "",
      to_emails: parsed.to,
      cc_emails: parsed.cc,
      subject: parsed.subject ?? "",
      body_text: parsed.text,
      body_html: parsed.html,
      received_at: receivedAt.toISOString(),
      provider_message_id: parsed.messageId,
      in_reply_to: parsed.inReplyTo,
      references: parsed.references,
      matched_by: matchedBy,
      raw_attachment_id: null,
    });
    cleanup.message(messageId);

    const rawEml = await storeAttachment({
      brokerId: session.brokerId,
      ownerType: "message",
      ownerId: messageId,
      filename: file.name,
      mime: EML_MIME,
      bytes: file.bytes,
    });
    cleanup.attachment(rawEml);
    await setMessageRawAttachment(session, messageId, rawEml.id);

    let firstPdf: AttachmentRow | null = null;
    for (const attachment of parsed.attachments) {
      const stored = await storeAttachment({
        brokerId: session.brokerId,
        ownerType: "message",
        ownerId: messageId,
        filename: attachment.filename,
        mime: attachment.contentType,
        bytes: attachment.content,
      });
      cleanup.attachment(stored);
      if (firstPdf === null && isPdf(stored)) firstPdf = stored;
    }

    const id = await insertOffer(session, {
      broker_id: session.brokerId,
      rfq_id: rfq.id,
      branch_id: rfq.branch_id,
      message_id: messageId,
      attachment_id: firstPdf?.id ?? null,
      source: "email",
      status: "parsed",
      received_at: receivedAt.toISOString(),
      confidence: 0,
      notes: "",
    });
    cleanup.offer(id);
    await logActivity(session, "vendor_offer", id, "offer.ingested", {
      mode: "eml",
      rfq_id: rfq.id,
      matched_by: matchedBy,
      message_id: messageId,
      attachment_id: firstPdf?.id ?? null,
      attachment_count: parsed.attachments.length,
      in_reply_to: parsed.inReplyTo,
    });
    return id;
  });

  await runExtraction(session, offerId, rfq.id);
  return { offerId, rfqId: rfq.id, matchedBy, needsRfqChoice: false };
}

async function ingestPdf(session: BrokerSession, request: Tables<"requests">, input: IngestInput): Promise<IngestResult> {
  const file = requireFile(input, "pdf");
  // Read it once now so a file that is not a PDF is refused before anything is written.
  try {
    await extractPdfPages(file.bytes);
  } catch (error) {
    throw new ReplyFileError(`Could not read the PDF: ${errorMessage(error)}`, { cause: error });
  }
  if (input.rfqId === null) {
    throw new NeedsRfqChoiceError(emptySummary());
  }
  const rfq = await loadSentRfq(session, request, input.rfqId);
  const receivedAt = new Date();
  const cleanup = new Cleanup(session);

  const offerId = await cleanup.guard(async () => {
    const id = await insertOffer(session, {
      broker_id: session.brokerId,
      rfq_id: rfq.id,
      branch_id: rfq.branch_id,
      message_id: null,
      attachment_id: null,
      source: "pdf",
      status: "parsed",
      received_at: receivedAt.toISOString(),
      confidence: 0,
      notes: "",
    });
    cleanup.offer(id);

    const stored = await storeAttachment({
      brokerId: session.brokerId,
      ownerType: "vendor_offer",
      ownerId: id,
      filename: file.name,
      mime: PDF_MIME,
      bytes: file.bytes,
    });
    cleanup.attachment(stored);
    await updateOfferRow(session, id, { attachment_id: stored.id });
    await logActivity(session, "vendor_offer", id, "offer.ingested", {
      mode: "pdf",
      rfq_id: rfq.id,
      matched_by: "manual",
      message_id: null,
      attachment_id: stored.id,
    });
    return id;
  });

  await runExtraction(session, offerId, rfq.id);
  return { offerId, rfqId: rfq.id, matchedBy: "manual", needsRfqChoice: false };
}

/**
 * extractOffer with its failure wrapped so the caller learns the offer id that
 * was kept. The offer row stands whatever the model did, so the RFQ and request
 * statuses are settled from it before the error surfaces: an offer under an RFQ
 * still marked "sent" would hide it from the awaiting list and the work queue.
 */
async function runExtraction(session: BrokerSession, offerId: string, rfqId: string): Promise<void> {
  try {
    await extractOffer(session, offerId);
  } catch (error) {
    await settleAfterFailedExtraction(session, rfqId);
    throw new OfferExtractionError(offerId, rfqId, error);
  }
}

/** Settle the RFQ and request statuses for a kept offer; a failure here is logged, not raised, so the extraction error is the one that surfaces. */
async function settleAfterFailedExtraction(session: BrokerSession, rfqId: string): Promise<void> {
  try {
    await settleRfqStatus(session, rfqId);
    const rfq = await loadRfq(session, rfqId);
    await settleRequestStatus(session, rfq.request_id);
  } catch (settleError) {
    console.error("[offers] could not settle statuses after a failed extraction", settleError);
  }
}

function requireFile(input: IngestInput, mode: "eml" | "pdf"): NonNullable<IngestInput["file"]> {
  const file = input.file;
  if (!file || file.bytes.byteLength === 0) {
    throw new ReplyFileError(mode === "eml" ? "Choose an .eml file to upload." : "Choose a PDF file to upload.");
  }
  return file;
}

async function parseReplyEml(bytes: Uint8Array): Promise<ParsedEml> {
  try {
    const parsed = await parseEml(toBuffer(bytes));
    parsedEmlHeadersSchema.parse(parsed);
    return parsed;
  } catch (error) {
    throw new ReplyFileError(`Could not read the .eml file: ${errorMessage(error)}`, { cause: error });
  }
}

function summarize(parsed: ParsedEml): ReplySummary {
  return {
    from: parsed.from?.address ?? null,
    subject: parsed.subject,
    date: validDate(parsed.date)?.toISOString() ?? null,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    attachmentCount: parsed.attachments.length,
  };
}

function emptySummary(): ReplySummary {
  return { from: null, subject: null, date: null, messageId: null, inReplyTo: null, references: [], attachmentCount: 0 };
}

function isPdf(attachment: Pick<AttachmentRow, "mime" | "filename">): boolean {
  return attachment.mime.toLowerCase() === PDF_MIME || /\.pdf$/i.test(attachment.filename);
}

function validDate(date: Date | null): Date | null {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Undo the rows and objects one reply wrote when a later step fails: the offer
 * (its lines cascade), the message, the attachments rows, then the Storage
 * objects once no row points at them. Errors here are swallowed so the error
 * that triggered the cleanup is the one that surfaces.
 */
class Cleanup {
  private offerIds: string[] = [];
  private messageIds: string[] = [];
  private attachments: AttachmentRow[] = [];

  constructor(private readonly session: BrokerSession) {}

  offer(id: string): void {
    this.offerIds.push(id);
  }

  message(id: string): void {
    this.messageIds.push(id);
  }

  attachment(row: AttachmentRow): void {
    this.attachments.push(row);
  }

  async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      await this.run();
      throw error;
    }
  }

  private async run(): Promise<void> {
    const { supabase, brokerId } = this.session;
    try {
      if (this.offerIds.length > 0) {
        await supabase.from("vendor_offers").delete().eq("broker_id", brokerId).in("id", this.offerIds);
      }
      if (this.messageIds.length > 0) {
        await supabase.from("messages").update({ raw_attachment_id: null }).eq("broker_id", brokerId).in("id", this.messageIds);
        await supabase.from("messages").delete().eq("broker_id", brokerId).in("id", this.messageIds);
      }
      if (this.attachments.length > 0) {
        const admin = createAdminClient();
        await admin
          .from("attachments")
          .delete()
          .eq("broker_id", brokerId)
          .in(
            "id",
            this.attachments.map((a) => a.id),
          );
        await removeAttachmentObjects(this.attachments.map((a) => a.storage_path));
      }
    } catch {
      // Reported through the error that triggered the cleanup.
    }
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract (or re-extract) an offer's lines from its message text and PDFs.
 * Replaces the offer's lines, updates the offer's terms, confidence, and
 * status, and settles the RFQ and request statuses. See the module header.
 */
export async function extractOffer(session: BrokerSession, offerId: string): Promise<{ lineCount: number; declined: boolean }> {
  const offer = await loadOffer(session, offerId);
  const rfq = await loadRfq(session, offer.rfq_id);
  const existing = await loadOfferLines(session, offerId);
  await assertNoSelections(
    session,
    existing.map((line) => line.id),
  );

  const message = offer.message_id === null ? null : await loadMessage(session, offer.message_id);
  const pdfs = await loadOfferPdfs(session, offer);
  const pages: PdfPages[] = [];
  for (const pdf of pdfs) {
    const bytes = await downloadAttachment(pdf.storage_path);
    pages.push({ attachmentId: pdf.id, filename: pdf.filename, pages: await extractPdfPages(bytes) });
  }
  const segments = buildOfferSegments(message?.body_text ?? null, pages);
  if (segments.length === 0) {
    throw new Error("This offer has no reply text and no PDF page to read.");
  }
  const doc = buildExtractionDocument(segments);
  const context = await loadOfferContext(session, rfq);
  const index = await loadAliasIndex(session.supabase);

  const call = await callExtractionTool({
    supabase: session.supabase,
    brokerId: session.brokerId,
    actorUserId: session.userId,
    entityType: "vendor_offer",
    entityId: offerId,
    toolName: EXTRACT_OFFER_LINES,
    system: OFFER_SYSTEM_PROMPT,
    userContent: buildOfferUserMessage(doc, context),
    schema: extractOfferLinesOutputSchema,
  });

  const { meta, lines } = normalizeOfferOutput(call.output, doc, context, index, new Date(offer.received_at));
  const tied = lines.filter((line) => line.request_line_id !== null);
  const untied = lines.filter((line) => line.request_line_id === null);

  // The lines are about to change, so a reviewed offer stops being reviewed
  // now: whatever fails below leaves it "parsed", the state the broker was
  // told to expect ("Edits to the lines are lost"), never "reviewed" over
  // lines nobody looked at.
  if (offer.status === "reviewed") {
    await updateOfferRow(session, offerId, { status: "parsed" });
  }

  // Insert first, delete second (as parseRequest does): a failed insert leaves
  // the previous lines untouched, a failed delete leaves both sets to be
  // replaced by the next extraction.
  const rows = tied.map((line) => toOfferLineInsert(session, offerId, line));
  if (rows.length > 0) {
    const { error } = await session.supabase.from("offer_lines").insert(rows);
    if (error) {
      throw new Error(`Could not save the offer lines: ${error.message}`);
    }
  }
  await deleteOfferLines(
    session,
    offerId,
    existing.map((line) => line.id),
  );

  const status: OfferStatus = meta.declined ? "declined" : "parsed";
  await updateOfferRow(session, offerId, {
    status,
    payment_terms: meta.payment_terms,
    early_pay_pct: meta.early_pay_pct,
    early_pay_days: meta.early_pay_days,
    freight_amount: meta.freight_amount,
    freight_basis: meta.freight_basis,
    quote_expires_at: meta.quote_expires_at,
    notes: joinOfferNotes(meta.notes, meta.declined ? (meta.decline_reason ? `Declined: ${meta.decline_reason}` : "Declined.") : null, untiedLinesNote(untied)),
    confidence: offerConfidence(tied, meta.declined),
  });

  await settleRfqStatus(session, rfq.id);
  await settleRequestStatus(session, rfq.request_id);

  await logActivity(session, "vendor_offer", offerId, "offer.extracted", {
    line_count: rows.length,
    declined: meta.declined,
    model: call.model,
    attachment_pages: pages.reduce((n, pdf) => n + pdf.pages.length, 0),
    unverified_spans: tied.filter((line) => !line.span_verified).length,
    untied_lines: untied.map((line) => ({ offered_desc: line.offered_desc, raw_text: line.raw_text })),
    notes: call.output.notes,
    input_tokens: call.inputTokens,
    output_tokens: call.outputTokens,
    latency_ms: call.latencyMs,
  });

  return { lineCount: rows.length, declined: meta.declined };
}

function toOfferLineInsert(session: BrokerSession, offerId: string, line: NormalizedOfferLine): TablesInsert<"offer_lines"> {
  if (line.request_line_id === null) {
    throw new Error("An offer line without a request line cannot be stored.");
  }
  return {
    broker_id: session.brokerId,
    offer_id: offerId,
    request_line_id: line.request_line_id,
    offered_catalog_item_id: line.offered_catalog_item_id,
    offered_desc: line.offered_desc,
    is_exact_match: line.is_exact_match,
    alternate_types: line.alternate_types,
    available_qty: line.available_qty,
    unit: line.unit,
    availability: line.availability,
    ready_date: line.ready_date,
    delivery_estimate_text: line.delivery_estimate_text,
    unit_price: line.unit_price,
    price_basis: line.price_basis,
    extended_price: null,
    flags: line.flags,
    confidence: line.confidence,
    source_span: line.source_span,
  };
}

/** The RFQ's lines (rfq_lines joined to request_lines, removed lines excluded) as the model's context, by line_no. */
async function loadOfferContext(session: BrokerSession, rfq: RfqRow): Promise<OfferContextLine[]> {
  const { data: links, error: linksError } = await session.supabase
    .from("rfq_lines")
    .select("request_line_id")
    .eq("broker_id", session.brokerId)
    .eq("rfq_id", rfq.id);
  if (linksError) {
    throw new Error(`Could not read RFQ lines: ${linksError.message}`);
  }
  const ids = Array.from(new Set((links ?? []).map((link) => link.request_line_id)));
  if (ids.length === 0) return [];

  const lines = await loadRequestLinesById(session, ids);
  const designations = await loadDesignations(session, lines);
  return lines
    .filter((line) => line.status !== "removed")
    .sort((a, b) => a.line_no - b.line_no)
    .map((line) => toContextLine(line, line.catalog_item_id ? (designations.get(line.catalog_item_id) ?? null) : null));
}

async function loadRequestLinesById(session: BrokerSession, ids: string[]): Promise<RequestLineRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await session.supabase
    .from("request_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .in("id", ids);
  if (error) {
    throw new Error(`Could not read request lines: ${error.message}`);
  }
  return data ?? [];
}

async function loadDesignations(
  session: BrokerSession,
  lines: ReadonlyArray<{ catalog_item_id: string | null }>,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(lines.map((line) => line.catalog_item_id).filter((id): id is string => id !== null)));
  if (ids.length === 0) return new Map();
  const { data, error } = await session.supabase.from("catalog_items").select("id, designation").in("id", ids);
  if (error) {
    throw new Error(`Could not read catalog items: ${error.message}`);
  }
  return new Map((data ?? []).map((item) => [item.id, item.designation]));
}

/**
 * The PDFs to read for an offer: the attachments stored under its message
 * (owner_type "message"), then the offer's own attachment_id when it is not
 * among them (a PDF upload stores it under the offer). PDFs only.
 */
async function loadOfferPdfs(session: BrokerSession, offer: OfferRow): Promise<AttachmentRow[]> {
  const pdfs: AttachmentRow[] = [];
  if (offer.message_id !== null) {
    const { data, error } = await session.supabase
      .from("attachments")
      .select("*")
      .eq("broker_id", session.brokerId)
      .eq("owner_type", "message")
      .eq("owner_id", offer.message_id)
      .order("created_at", { ascending: true });
    if (error) {
      throw new Error(`Could not read the message attachments: ${error.message}`);
    }
    pdfs.push(...(data ?? []).filter(isPdf));
  }
  if (offer.attachment_id !== null && !pdfs.some((pdf) => pdf.id === offer.attachment_id)) {
    const { data, error } = await session.supabase
      .from("attachments")
      .select("*")
      .eq("broker_id", session.brokerId)
      .eq("id", offer.attachment_id)
      .maybeSingle();
    if (error) {
      throw new Error(`Could not read the offer attachment: ${error.message}`);
    }
    if (data && isPdf(data)) pdfs.push(data);
  }
  return pdfs;
}

/** Bytes of an object in the attachments bucket. Admin client: the bucket has no user policies. */
async function downloadAttachment(storagePath: string): Promise<Uint8Array> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(ATTACHMENTS_BUCKET).download(storagePath);
  if (error) {
    throw new Error(`Could not download ${storagePath}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`Could not download ${storagePath}: empty response.`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

/** Re-extracting or removing deletes offer lines; a line a sourcing selection (Step 7) points at must not go. */
async function assertNoSelections(
  session: BrokerSession,
  offerLineIds: string[],
  message = "A line of this offer has been selected on the Compare tab. Clear that selection before re-extracting.",
): Promise<void> {
  if (offerLineIds.length === 0) return;
  const { data, error } = await session.supabase
    .from("sourcing_selections")
    .select("id")
    .eq("broker_id", session.brokerId)
    .in("offer_line_id", offerLineIds)
    .limit(1);
  if (error) {
    throw new Error(`Could not check sourcing selections: ${error.message}`);
  }
  if ((data ?? []).length > 0) {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Manual quotes (phone, text)
// ---------------------------------------------------------------------------

/**
 * AC-9.2: a quote the broker took by phone or text, entered with the same
 * fields an extracted offer has. Confidence 1 and an empty source_span: the
 * broker typed it, nothing was read. Flags come from computeOfferFlags(), so a
 * blank price or quantity is flagged, never filled. Every line must belong to
 * the RFQ's request. The offered item is linked to the catalog when its
 * description resolves to one.
 */
export async function createManualOffer(session: BrokerSession, input: ManualOfferInput): Promise<{ offerId: string }> {
  const rfq = await loadRfq(session, input.rfqId);
  if (!SENT_RFQ_STATUSES.includes(rfq.status)) {
    throw new Error("This RFQ has not been sent yet. A quote can only be entered against a sent RFQ.");
  }
  const requestLines = await loadRequestLinesForRequest(session, rfq.request_id);
  const known = new Set(requestLines.map((line) => line.id));
  for (const line of input.lines) {
    if (!known.has(line.requestLineId)) {
      throw new Error("A quoted line does not belong to this request.");
    }
  }

  const status: OfferStatus = input.declined ? "declined" : "parsed";
  const offerId = await insertOffer(session, {
    broker_id: session.brokerId,
    rfq_id: rfq.id,
    branch_id: rfq.branch_id,
    message_id: null,
    attachment_id: null,
    source: input.source,
    status,
    received_at: input.receivedAt.toISOString(),
    quote_expires_at: toExpiryTimestamp(input.quoteExpiresAt),
    payment_terms: clean(input.paymentTerms),
    early_pay_pct: input.earlyPayPct,
    early_pay_days: input.earlyPayDays,
    freight_amount: input.freightAmount,
    freight_basis: input.freightBasis,
    notes: clean(input.notes) ?? "",
    confidence: 1,
  });

  const cleanup = new Cleanup(session);
  cleanup.offer(offerId);
  await cleanup.guard(async () => {
    const prepared = [];
    for (const line of input.lines) {
      const offeredDesc = line.offeredDesc.trim();
      const item = await findItemByDescription(session, offeredDesc);
      const exactness = reconcileExactness({ is_exact_match: line.isExactMatch, alternate_types: line.alternateTypes }, {
        is_exact_match: line.isExactMatch,
        alternate_types: line.alternateTypes,
      });
      // request_line_id, offered_desc, offered_catalog_item_id, and flags are the
      // duplicate key markOfferDuplicates reads; the rest builds the row.
      prepared.push({
        line,
        exactness,
        request_line_id: line.requestLineId,
        offered_desc: offeredDesc,
        offered_catalog_item_id: item?.id ?? null,
        flags: computeOfferFlags({
          request_line_id: line.requestLineId,
          unit_price: line.unitPrice,
          available_qty: line.availableQty,
          availability: line.availability,
          declined: input.declined,
        }),
      });
    }
    const flagged = markOfferDuplicates(prepared);
    const rows: TablesInsert<"offer_lines">[] = flagged.map((entry) =>
      manualOfferLineRow(session, offerId, entry.line, entry.offered_catalog_item_id, entry.exactness, entry.flags),
    );
    if (rows.length > 0) {
      const { error } = await session.supabase.from("offer_lines").insert(rows);
      if (error) {
        throw new Error(`Could not save the quote lines: ${error.message}`);
      }
    }

    await settleRfqStatus(session, rfq.id);
    await settleRequestStatus(session, rfq.request_id);
    await logActivity(session, "vendor_offer", offerId, "offer.created", {
      source: input.source,
      rfq_id: rfq.id,
      declined: input.declined,
      line_count: rows.length,
    });
  });

  return { offerId };
}

/** A typed offer line as an offer_lines insert: confidence 1 and no span, the broker typed it. */
function manualOfferLineRow(
  session: BrokerSession,
  offerId: string,
  line: ManualOfferLineInput,
  offeredCatalogItemId: string | null,
  exactness: { is_exact_match: boolean; alternate_types: OfferLineRow["alternate_types"] },
  flags: OfferFlag[],
): TablesInsert<"offer_lines"> {
  return {
    broker_id: session.brokerId,
    offer_id: offerId,
    request_line_id: line.requestLineId,
    offered_catalog_item_id: offeredCatalogItemId,
    offered_desc: line.offeredDesc.trim(),
    is_exact_match: exactness.is_exact_match,
    alternate_types: exactness.alternate_types,
    available_qty: line.availableQty,
    unit: line.unit,
    availability: line.availability,
    ready_date: line.readyDate,
    delivery_estimate_text: clean(line.deliveryEstimateText),
    unit_price: line.unitPrice,
    price_basis: line.priceBasis,
    extended_price: null,
    flags,
    confidence: 1,
    source_span: {},
  };
}

async function loadRequestLinesForRequest(session: BrokerSession, requestId: string): Promise<RequestLineRow[]> {
  const { data, error } = await session.supabase
    .from("request_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId)
    .neq("status", "removed")
    .order("line_no", { ascending: true });
  if (error) {
    throw new Error(`Could not read request lines: ${error.message}`);
  }
  return data ?? [];
}

/** Every line of the request, removed ones included, by line_no. */
async function loadRequestLines(session: BrokerSession, requestId: string): Promise<RequestLineRow[]> {
  const { data, error } = await session.supabase
    .from("request_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId)
    .order("line_no", { ascending: true });
  if (error) {
    throw new Error(`Could not read request lines: ${error.message}`);
  }
  return data ?? [];
}

type CatalogPick = Pick<Tables<"catalog_items">, "id" | "designation">;

/**
 * The item a typed description resolves to: the description as written, then
 * without a trailing length ("W12x26 x 50'" is W12x26), each tried as a
 * normalized alias first (learned aliases win) and then as a designation.
 */
async function findItemByDescription(session: BrokerSession, description: string): Promise<CatalogPick | null> {
  for (const candidate of offeredItemCandidates(description, null)) {
    const item = await findItemByOneDescription(session, candidate);
    if (item) return item;
  }
  return null;
}

async function findItemByOneDescription(session: BrokerSession, description: string): Promise<CatalogPick | null> {
  const alias = normalizeAlias(description);
  if (alias !== "") {
    const { data, error } = await session.supabase
      .from("catalog_aliases")
      .select("catalog_item_id, catalog_items(id, designation)")
      .eq("alias", alias)
      .order("broker_id", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(`Could not look up the alias: ${error.message}`);
    }
    if (data?.catalog_items) return data.catalog_items;
  }

  const designation = description.replace(/\s+/g, "").replace(/[%_\\]/g, (c) => `\\${c}`);
  if (designation === "") return null;
  const { data, error } = await session.supabase
    .from("catalog_items")
    .select("id, designation")
    .ilike("designation", designation)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not look up the designation: ${error.message}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

const OFFER_LINE_DIFF_KEYS = [
  "request_line_id",
  "offered_desc",
  "offered_catalog_item_id",
  "is_exact_match",
  "alternate_types",
  "available_qty",
  "unit",
  "availability",
  "ready_date",
  "delivery_estimate_text",
  "unit_price",
  "price_basis",
  "flags",
] as const satisfies readonly (keyof OfferLineRow)[];

/**
 * Edit one offer line. The patch holds only the fields that changed; flags are
 * recomputed from the new values (judgment flags carried), the catalog link
 * follows a new description, exactness and alternate types are kept
 * consistent (reconcileExactness), and a new request line must belong to the
 * same request. Logs offer_line.updated with before and after.
 */
export async function updateOfferLine(session: BrokerSession, offerLineId: string, patch: OfferLinePatch): Promise<OfferLineRow> {
  const before = await loadOfferLine(session, offerLineId);
  const offer = await loadOffer(session, before.offer_id);

  if (patch.request_line_id !== undefined && patch.request_line_id !== before.request_line_id) {
    const rfq = await loadRfq(session, offer.rfq_id);
    const lines = await loadRequestLinesForRequest(session, rfq.request_id);
    if (!lines.some((line) => line.id === patch.request_line_id)) {
      throw new Error("That request line does not belong to this request.");
    }
  }

  const offeredDesc = patch.offered_desc !== undefined ? patch.offered_desc.trim() : before.offered_desc;
  const itemId =
    patch.offered_desc !== undefined && offeredDesc !== before.offered_desc
      ? ((await findItemByDescription(session, offeredDesc))?.id ?? null)
      : before.offered_catalog_item_id;
  const exactness = reconcileExactness(patch, before);

  const candidate: OfferLineRow = {
    ...before,
    request_line_id: patch.request_line_id ?? before.request_line_id,
    offered_desc: offeredDesc,
    offered_catalog_item_id: itemId,
    is_exact_match: exactness.is_exact_match,
    alternate_types: exactness.alternate_types,
    available_qty: patch.available_qty !== undefined ? patch.available_qty : before.available_qty,
    unit: patch.unit !== undefined ? patch.unit : before.unit,
    availability: patch.availability ?? before.availability,
    ready_date: patch.ready_date !== undefined ? patch.ready_date : before.ready_date,
    delivery_estimate_text: patch.delivery_estimate_text !== undefined ? clean(patch.delivery_estimate_text) : before.delivery_estimate_text,
    unit_price: patch.unit_price !== undefined ? patch.unit_price : before.unit_price,
    price_basis: patch.price_basis !== undefined ? patch.price_basis : before.price_basis,
  };
  candidate.flags = recomputeOfferLineFlags(candidate, offer.status === "declined");

  // A new request line or offered item breaks the pair possible_duplicate
  // stood for, so the carried flag goes and the offer's lines are re-paired
  // after the write (the old partner loses the flag, a new partner gains it).
  const beforeKey = offerDuplicateKey(before);
  const afterKey = offerDuplicateKey(candidate);
  const pairingChanged = beforeKey !== afterKey;
  if (pairingChanged) candidate.flags = candidate.flags.filter((flag) => flag !== "possible_duplicate");

  const diff = diffRows(before, candidate, OFFER_LINE_DIFF_KEYS);
  if (diff.changed.length === 0) return before;

  const update: Record<string, unknown> = {};
  for (const key of diff.changed) update[key] = candidate[key];
  const { data, error } = await session.supabase
    .from("offer_lines")
    .update(update as TablesUpdate<"offer_lines">)
    .eq("broker_id", session.brokerId)
    .eq("id", offerLineId)
    .select("*")
    .single();
  if (error) {
    throw new Error(`Could not save the offer line: ${error.message}`);
  }

  let stored: OfferLineRow = data;
  let resettled: string[] = [];
  if (pairingChanged) {
    const lines = await resettleOfferDuplicates(session, before.offer_id, [beforeKey]);
    resettled = lines.filter((line) => line.changed).map((line) => line.row.id);
    stored = lines.find((line) => line.row.id === offerLineId)?.row ?? data;
  }

  await logActivity(session, "offer_line", offerLineId, "offer_line.updated", {
    offer_id: before.offer_id,
    before: diff.before as { [key: string]: Json | undefined },
    after: { ...(diff.after as { [key: string]: Json | undefined }), ...(sameJson(stored.flags, data.flags) ? {} : { flags: stored.flags }) },
    ...(resettled.length > 0 ? { duplicate_flags_resettled: resettled } : {}),
  });
  return stored;
}

/**
 * Add a line the broker typed to an existing offer (AC-9.3: an offer is
 * reviewable like a request, and the review grid can add a line): a line the
 * model could not tie and left in the notes, or one the reply states that the
 * extraction missed. Same fields, confidence, span, flags, and request-line
 * check as a manual quote's lines; the offer's duplicates are re-paired after
 * the insert. Logs offer_line.added.
 */
export async function addOfferLine(session: BrokerSession, offerId: string, input: ManualOfferLineInput): Promise<OfferLineRow> {
  const line = manualOfferLineSchema.parse(input);
  const offer = await loadOffer(session, offerId);
  const rfq = await loadRfq(session, offer.rfq_id);
  const requestLines = await loadRequestLinesForRequest(session, rfq.request_id);
  if (!requestLines.some((requestLine) => requestLine.id === line.requestLineId)) {
    throw new Error("That request line does not belong to this request.");
  }

  const item = await findItemByDescription(session, line.offeredDesc.trim());
  const exactness = reconcileExactness({ is_exact_match: line.isExactMatch, alternate_types: line.alternateTypes }, {
    is_exact_match: line.isExactMatch,
    alternate_types: line.alternateTypes,
  });
  const flags = computeOfferFlags({
    request_line_id: line.requestLineId,
    unit_price: line.unitPrice,
    available_qty: line.availableQty,
    availability: line.availability,
    declined: offer.status === "declined",
  });
  const row = manualOfferLineRow(session, offerId, line, item?.id ?? null, exactness, flags);

  const { data, error } = await session.supabase.from("offer_lines").insert(row).select("*").single();
  if (error) {
    throw new Error(`Could not add the offer line: ${error.message}`);
  }
  const lines = await resettleOfferDuplicates(session, offerId, []);
  const stored = lines.find((entry) => entry.row.id === data.id)?.row ?? data;

  await logActivity(session, "offer_line", data.id, "offer_line.added", {
    offer_id: offerId,
    after: pickOfferLineFields(stored),
    ...(lines.some((entry) => entry.changed && entry.row.id !== data.id)
      ? { duplicate_flags_resettled: lines.filter((entry) => entry.changed && entry.row.id !== data.id).map((entry) => entry.row.id) }
      : {}),
  });
  return stored;
}

/**
 * Delete one offer line (a spurious extraction, or a line the vendor did not
 * quote). Refused while a sourcing selection (Step 7) points at it. The
 * offer's duplicates are re-paired afterwards, so a partner left alone loses
 * possible_duplicate. Logs offer_line.removed with the row as it was.
 */
export async function removeOfferLine(session: BrokerSession, offerLineId: string): Promise<OfferLineRow> {
  const before = await loadOfferLine(session, offerLineId);
  await assertNoSelections(session, [offerLineId], "This line has been selected on the Compare tab. Clear that selection before removing it.");

  const { error } = await session.supabase.from("offer_lines").delete().eq("broker_id", session.brokerId).eq("id", offerLineId);
  if (error) {
    throw new Error(`Could not remove the offer line: ${error.message}`);
  }
  const lines = await resettleOfferDuplicates(session, before.offer_id, [offerDuplicateKey(before)]);

  await logActivity(session, "offer_line", offerLineId, "offer_line.removed", {
    offer_id: before.offer_id,
    before: pickOfferLineFields(before),
    ...(lines.some((entry) => entry.changed) ? { duplicate_flags_resettled: lines.filter((entry) => entry.changed).map((entry) => entry.row.id) } : {}),
  });
  return before;
}

/** The logged fields of an offer line (the diff keys), as JSON. */
function pickOfferLineFields(row: OfferLineRow): { [key: string]: Json | undefined } {
  const out: { [key: string]: Json | undefined } = {};
  for (const key of OFFER_LINE_DIFF_KEYS) out[key] = row[key] as Json;
  return out;
}

/**
 * Re-pair possible_duplicate across an offer's lines after one changed, was
 * added, or was removed. Lines whose duplicate key is one of staleKeys (the
 * pairs the change broke) lose the flag, then markOfferDuplicates adds it to
 * every line that now shares its key with another. Rows whose flags did not
 * change are not written; a model-set possible_duplicate on a pair the change
 * did not touch stays. Returns every line of the offer with whether it was
 * rewritten.
 */
async function resettleOfferDuplicates(
  session: BrokerSession,
  offerId: string,
  staleKeys: ReadonlyArray<string | null>,
): Promise<Array<{ row: OfferLineRow; changed: boolean }>> {
  const stale = new Set(staleKeys.filter((key): key is string => key !== null));
  const rows = await loadOfferLines(session, offerId);
  const stripped = rows.map((row) => {
    const flags = rowOfferFlags(row.flags);
    const key = offerDuplicateKey(row);
    return { ...row, flags: key !== null && stale.has(key) ? flags.filter((flag) => flag !== "possible_duplicate") : flags };
  });
  const marked = markOfferDuplicates(stripped);

  const result: Array<{ row: OfferLineRow; changed: boolean }> = [];
  for (let i = 0; i < rows.length; i++) {
    const flags = orderOfferFlags(marked[i].flags);
    if (sameJson(flags, rows[i].flags)) {
      result.push({ row: rows[i], changed: false });
      continue;
    }
    const { error } = await session.supabase
      .from("offer_lines")
      .update({ flags })
      .eq("broker_id", session.brokerId)
      .eq("id", rows[i].id);
    if (error) {
      throw new Error(`Could not update the offer line flags: ${error.message}`);
    }
    result.push({ row: { ...rows[i], flags }, changed: true });
  }
  return result;
}

const OFFER_DIFF_KEYS = [
  "payment_terms",
  "early_pay_pct",
  "early_pay_days",
  "freight_amount",
  "freight_basis",
  "quote_expires_at",
  "received_at",
  "notes",
  "status",
] as const satisfies readonly (keyof OfferRow)[];

/** Edit the offer-level terms. Logs offer.updated with before and after. */
export async function updateOffer(session: BrokerSession, offerId: string, patch: OfferPatch): Promise<OfferRow> {
  const before = await loadOffer(session, offerId);
  const candidate: OfferRow = {
    ...before,
    payment_terms: patch.payment_terms !== undefined ? clean(patch.payment_terms) : before.payment_terms,
    early_pay_pct: patch.early_pay_pct !== undefined ? patch.early_pay_pct : before.early_pay_pct,
    early_pay_days: patch.early_pay_days !== undefined ? patch.early_pay_days : before.early_pay_days,
    freight_amount: patch.freight_amount !== undefined ? patch.freight_amount : before.freight_amount,
    freight_basis: patch.freight_basis ?? before.freight_basis,
    quote_expires_at: patch.quote_expires_at !== undefined ? toExpiryTimestamp(patch.quote_expires_at) : before.quote_expires_at,
    received_at: patch.received_at !== undefined ? (toExpiryTimestamp(patch.received_at) ?? before.received_at) : before.received_at,
    notes: patch.notes !== undefined ? patch.notes : before.notes,
  };
  const diff = diffRows(before, candidate, OFFER_DIFF_KEYS);
  if (diff.changed.length === 0) return before;

  const update: Record<string, unknown> = {};
  for (const key of diff.changed) update[key] = candidate[key];
  const row = await updateOfferRow(session, offerId, update as TablesUpdate<"vendor_offers">);
  await logActivity(session, "vendor_offer", offerId, "offer.updated", {
    before: diff.before as { [key: string]: Json | undefined },
    after: diff.after as { [key: string]: Json | undefined },
  });
  return row;
}

/** Status "reviewed": the broker has checked the extracted lines (AC-9.3). A declined offer has nothing to review. */
export async function markOfferReviewed(session: BrokerSession, offerId: string): Promise<OfferRow> {
  const before = await loadOffer(session, offerId);
  if (before.status === "declined") {
    throw new Error("A declined offer has no lines to review. Undo the decline first.");
  }
  if (before.status === "reviewed") return before;
  const row = await updateOfferRow(session, offerId, { status: "reviewed" });
  await logActivity(session, "vendor_offer", offerId, "offer.reviewed", { before: { status: before.status }, after: { status: "reviewed" } });
  return row;
}

/**
 * Mark an offer declined (AC-9.4: the work queue stops waiting on it) or undo
 * that. Line flags follow (missing_price does not apply to a decline), the RFQ
 * status follows its offers, and the request status settles.
 */
export async function setOfferDeclined(session: BrokerSession, offerId: string, declined: boolean): Promise<OfferRow> {
  const before = await loadOffer(session, offerId);
  const status: OfferStatus = declined ? "declined" : "parsed";
  if (before.status === status) return before;

  const row = await updateOfferRow(session, offerId, { status });
  for (const line of await loadOfferLines(session, offerId)) {
    const flags = recomputeOfferLineFlags(line, declined);
    if (sameJson(flags, line.flags)) continue;
    const { error } = await session.supabase
      .from("offer_lines")
      .update({ flags })
      .eq("broker_id", session.brokerId)
      .eq("id", line.id);
    if (error) {
      throw new Error(`Could not update the offer line flags: ${error.message}`);
    }
  }
  await settleRfqStatus(session, before.rfq_id);
  const rfq = await loadRfq(session, before.rfq_id);
  await settleRequestStatus(session, rfq.request_id);
  await logActivity(session, "vendor_offer", offerId, declined ? "offer.declined" : "offer.undeclined", {
    before: { status: before.status },
    after: { status },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Reads for the Offers tab
// ---------------------------------------------------------------------------

export type OpenRfq = { id: string; branch_name: string; vendor_name: string; status: RfqStatus; sent_at: string | null };

/** The RFQs of this request's revision a reply can still be attached to by hand (sent or responded), by vendor then branch. */
export async function listOpenRfqs(session: BrokerSession, requestId: string): Promise<OpenRfq[]> {
  const request = await loadRequest(session, requestId);
  const rfqs = await loadRfqs(session, requestId, request.revision, ["sent", "responded"]);
  const names = await loadBranchNames(
    session,
    rfqs.map((rfq) => rfq.branch_id),
  );
  return rfqs
    .map((rfq) => {
      const name = names.get(rfq.branch_id);
      return {
        id: rfq.id,
        branch_name: name?.branch ?? "Unknown branch",
        vendor_name: name?.vendor ?? "Unknown vendor",
        status: rfq.status,
        sent_at: rfq.sent_at,
      };
    })
    .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name) || a.branch_name.localeCompare(b.branch_name));
}

export type RfqWithNames = RfqRow & { vendor_name: string; branch_name: string };
export type OfferWithLines = OfferRow & { lines: OfferLineRow[] };

export type OffersContext = {
  request: Tables<"requests">;
  /** Every RFQ of this request's revision (any status) with its vendor and branch names, by vendor then branch. */
  rfqs: RfqWithNames[];
  /** Every offer on those RFQs with its lines in display order (sortOfferLines: request line_no, then created_at, then id), newest offer first. */
  offers: OfferWithLines[];
  /** The request's lines, removed ones included (the page filters), by line_no. */
  lines: RequestLineRow[];
  /** Inbound and outbound messages of this request (links from offer cards, reply text for span display). */
  messages: MessageRow[];
};

/**
 * Everything the Offers tab reads for one request, under RLS: the revision's
 * RFQs with names, the offers with their lines, the request lines for the
 * picker and the manual form, and the messages. The page joins rfq_lines,
 * attachments, and designations itself. Throws when the request is not visible.
 */
export async function loadOffersContext(session: BrokerSession, requestId: string): Promise<OffersContext> {
  const request = await loadRequest(session, requestId);
  const rfqRows = await loadRfqs(session, requestId, request.revision, null);
  const names = await loadBranchNames(
    session,
    rfqRows.map((rfq) => rfq.branch_id),
  );
  const rfqs: RfqWithNames[] = rfqRows
    .map((rfq) => ({
      ...rfq,
      vendor_name: names.get(rfq.branch_id)?.vendor ?? "Unknown vendor",
      branch_name: names.get(rfq.branch_id)?.branch ?? "Unknown branch",
    }))
    .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name) || a.branch_name.localeCompare(b.branch_name));

  const offerRows = await loadOffersForRfqs(
    session,
    rfqs.map((rfq) => rfq.id),
  );
  const [lineRows, requestLines, messages] = await Promise.all([
    loadOfferLinesForOffers(
      session,
      offerRows.map((offer) => offer.id),
    ),
    loadRequestLines(session, requestId),
    loadMessagesForRequest(session, requestId),
  ]);

  const lineNoById = new Map(requestLines.map((line) => [line.id, line.line_no]));
  const offers: OfferWithLines[] = offerRows.map((offer) => ({
    ...offer,
    lines: sortOfferLines(
      lineRows.filter((line) => line.offer_id === offer.id),
      lineNoById,
    ),
  }));

  return { request, rfqs, offers, lines: requestLines, messages };
}

// ---------------------------------------------------------------------------
// Status settlement
// ---------------------------------------------------------------------------

/** rfqs.status from the statuses of the RFQ's offers (rfqStatusFromOffers); a sent RFQ with no offer stays sent. */
async function settleRfqStatus(session: BrokerSession, rfqId: string): Promise<void> {
  const rfq = await loadRfq(session, rfqId);
  if (!SENT_RFQ_STATUSES.includes(rfq.status) || rfq.status === "closed") return;
  const offers = await loadOffersForRfqs(session, [rfqId]);
  const status = rfqStatusFromOffers(offers.map((offer) => offer.status));
  if (status === rfq.status) return;
  const { error } = await session.supabase
    .from("rfqs")
    .update({ status })
    .eq("broker_id", session.brokerId)
    .eq("id", rfqId);
  if (error) {
    throw new Error(`Could not update the RFQ status: ${error.message}`);
  }
}

/** requests.status per nextRequestStatus over every RFQ of the revision. */
async function settleRequestStatus(session: BrokerSession, requestId: string): Promise<void> {
  const request = await loadRequest(session, requestId);
  const rfqs = await loadRfqs(session, requestId, request.revision, null);
  const next = nextRequestStatus(
    request.status,
    rfqs.map((rfq) => rfq.status),
  );
  if (next === null || next === request.status) return;
  const { error } = await session.supabase
    .from("requests")
    .update({ status: next })
    .eq("broker_id", session.brokerId)
    .eq("id", requestId);
  if (error) {
    throw new Error(`Could not update the request status: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Row reads and writes
// ---------------------------------------------------------------------------

async function loadRequest(session: BrokerSession, requestId: string): Promise<Tables<"requests">> {
  const { data, error } = await session.supabase
    .from("requests")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", requestId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read request: ${error.message}`);
  }
  if (!data) {
    throw new Error("Request not found.");
  }
  return data;
}

/** The RFQ a reply may be attached to: one of this request's, and already sent. */
async function loadSentRfq(session: BrokerSession, request: Tables<"requests">, rfqId: string): Promise<RfqRow> {
  const rfq = await loadRfq(session, rfqId);
  if (rfq.request_id !== request.id) {
    throw new Error("That RFQ belongs to another request.");
  }
  if (!SENT_RFQ_STATUSES.includes(rfq.status)) {
    throw new Error("This RFQ has not been sent yet. A reply can only be attached to a sent RFQ.");
  }
  return rfq;
}

/** This request's outbound messages, for header matching. */
async function loadOutboundRefs(session: BrokerSession, requestId: string): Promise<Array<{ rfq_id: string; provider_message_id: string | null }>> {
  const { data, error } = await session.supabase
    .from("messages")
    .select("rfq_id, provider_message_id")
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId)
    .eq("direction", "out");
  if (error) {
    throw new Error(`Could not read outbound messages: ${error.message}`);
  }
  return (data ?? [])
    .filter((row): row is { rfq_id: string; provider_message_id: string | null } => row.rfq_id !== null)
    .map((row) => ({ rfq_id: row.rfq_id, provider_message_id: row.provider_message_id }));
}

export async function loadOffer(session: BrokerSession, offerId: string): Promise<OfferRow> {
  const { data, error } = await session.supabase
    .from("vendor_offers")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", offerId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the offer: ${error.message}`);
  }
  if (!data) {
    throw new Error("Offer not found.");
  }
  return data;
}

async function loadOfferLine(session: BrokerSession, offerLineId: string): Promise<OfferLineRow> {
  const { data, error } = await session.supabase
    .from("offer_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", offerLineId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the offer line: ${error.message}`);
  }
  if (!data) {
    throw new Error("Offer line not found.");
  }
  return data;
}

async function loadOfferLines(session: BrokerSession, offerId: string): Promise<OfferLineRow[]> {
  const { data, error } = await session.supabase
    .from("offer_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("offer_id", offerId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Could not read the offer lines: ${error.message}`);
  }
  return data ?? [];
}

async function loadOfferLinesForOffers(session: BrokerSession, offerIds: string[]): Promise<OfferLineRow[]> {
  if (offerIds.length === 0) return [];
  const { data, error } = await session.supabase
    .from("offer_lines")
    .select("*")
    .eq("broker_id", session.brokerId)
    .in("offer_id", offerIds)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Could not read the offer lines: ${error.message}`);
  }
  return data ?? [];
}

async function loadOffersForRfqs(session: BrokerSession, rfqIds: string[]): Promise<OfferRow[]> {
  if (rfqIds.length === 0) return [];
  const { data, error } = await session.supabase
    .from("vendor_offers")
    .select("*")
    .eq("broker_id", session.brokerId)
    .in("rfq_id", rfqIds)
    .order("received_at", { ascending: false });
  if (error) {
    throw new Error(`Could not read the offers: ${error.message}`);
  }
  return data ?? [];
}

async function loadMessage(session: BrokerSession, messageId: string): Promise<MessageRow> {
  const { data, error } = await session.supabase
    .from("messages")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", messageId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the message: ${error.message}`);
  }
  if (!data) {
    throw new Error("Message not found.");
  }
  return data;
}

async function loadMessagesForRequest(session: BrokerSession, requestId: string): Promise<MessageRow[]> {
  const { data, error } = await session.supabase
    .from("messages")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId)
    .order("received_at", { ascending: true });
  if (error) {
    throw new Error(`Could not read messages: ${error.message}`);
  }
  return data ?? [];
}

/** Branch and vendor names by branch id. */
async function loadBranchNames(session: BrokerSession, branchIds: string[]): Promise<Map<string, { branch: string; vendor: string }>> {
  const ids = Array.from(new Set(branchIds));
  if (ids.length === 0) return new Map();
  const { data: branches, error: branchError } = await session.supabase
    .from("vendor_branches")
    .select("id, name, vendor_id")
    .eq("broker_id", session.brokerId)
    .in("id", ids);
  if (branchError) {
    throw new Error(`Could not read vendor branches: ${branchError.message}`);
  }
  const vendorIds = Array.from(new Set((branches ?? []).map((branch) => branch.vendor_id)));
  const { data: vendors, error: vendorError } =
    vendorIds.length === 0
      ? { data: [], error: null }
      : await session.supabase.from("vendors").select("id, name").eq("broker_id", session.brokerId).in("id", vendorIds);
  if (vendorError) {
    throw new Error(`Could not read vendors: ${vendorError.message}`);
  }
  const vendorName = new Map((vendors ?? []).map((vendor) => [vendor.id, vendor.name]));
  return new Map((branches ?? []).map((branch) => [branch.id, { branch: branch.name, vendor: vendorName.get(branch.vendor_id) ?? "Unknown vendor" }]));
}

async function insertInboundMessage(session: BrokerSession, row: TablesInsert<"messages">): Promise<string> {
  const { data, error } = await session.supabase.from("messages").insert(row).select("id").single();
  if (error) {
    throw new Error(`Could not record the reply message: ${error.message}`);
  }
  return data.id;
}

async function setMessageRawAttachment(session: BrokerSession, messageId: string, attachmentId: string): Promise<void> {
  const { error } = await session.supabase
    .from("messages")
    .update({ raw_attachment_id: attachmentId })
    .eq("broker_id", session.brokerId)
    .eq("id", messageId);
  if (error) {
    throw new Error(`Could not link the raw .eml to the message: ${error.message}`);
  }
}

async function insertOffer(session: BrokerSession, row: TablesInsert<"vendor_offers">): Promise<string> {
  const { data, error } = await session.supabase.from("vendor_offers").insert(row).select("id").single();
  if (error) {
    throw new Error(`Could not create the offer: ${error.message}`);
  }
  return data.id;
}

async function updateOfferRow(session: BrokerSession, offerId: string, patch: TablesUpdate<"vendor_offers">): Promise<OfferRow> {
  const { data, error } = await session.supabase
    .from("vendor_offers")
    .update(patch)
    .eq("broker_id", session.brokerId)
    .eq("id", offerId)
    .select("*")
    .single();
  if (error) {
    throw new Error(`Could not update the offer: ${error.message}`);
  }
  return data;
}

async function deleteOfferLines(session: BrokerSession, offerId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await session.supabase
    .from("offer_lines")
    .delete()
    .eq("broker_id", session.brokerId)
    .eq("offer_id", offerId)
    .in("id", ids);
  if (error) {
    throw new Error(`Could not clear the previous offer lines: ${error.message}`);
  }
}

async function logActivity(
  session: BrokerSession,
  entityType: string,
  entityId: string,
  action: string,
  payload: { [key: string]: Json | undefined },
): Promise<void> {
  const { error } = await session.supabase.from("activity_log").insert({
    broker_id: session.brokerId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    actor_user_id: session.userId,
    payload,
  });
  if (error) {
    throw new Error(`Could not write the activity log: ${error.message}`);
  }
}

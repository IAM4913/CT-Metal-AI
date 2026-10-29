// Offers tab (PRD FR-9): reply ingestion (paste, .eml, PDF), phone and text
// quotes, and the extracted offers grouped by RFQ with editable lines.
//
// Server component: loads the offers context (this revision's RFQs with vendor
// and branch names, the offers with their lines, the request lines, and the
// messages), joins in the rfq_lines, the attachments the offers and messages
// point at, and the designations of linked catalog items, then hands plain
// serializable props (strings, numbers, booleans, null) to the client
// workspace. The [id] layout has already returned 404 for an unknown id.
// Nothing from the admin client reaches this file.

import { notFound } from "next/navigation";
import { z } from "zod";
import type { OfferAttachment, OfferCardData, OfferMessage } from "@/components/offers/offer-card";
import type { OfferLineRow, OfferRequestLine } from "@/components/offers/offer-lines-grid";
import { OffersWorkspace, type OffersRfq } from "@/components/offers/offers-workspace";
import type { Tables } from "@/lib/db/client";
import { alternateTypeSchema, type AlternateType } from "@/lib/db/enums";
import type { SourceSpan } from "@/lib/parsing/document";
import { offerFlagSchema, type OfferFlag } from "@/lib/parsing/offers-schema";
import { loadOffersContext, sortOfferLines } from "@/lib/server/offers";
import { loadRequestWorkspace } from "@/lib/server/requests";
import { SENT_RFQ_STATUSES } from "@/lib/server/routing";
import { requireBroker, type BrokerSession } from "@/lib/server/session";

type OffersPageProps = {
  params: Promise<{ id: string }>;
};

// offer_lines.source_span as written by extractOffer (PRD section 7). A manual
// line stores {} and shows as "no span" rather than failing the page.
const sourceSpanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("attachment"),
    attachment_id: z.string(),
    page: z.number().int(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
]);

type RfqWithNames = Tables<"rfqs"> & { vendor_name: string; branch_name: string };
type OfferWithLines = Tables<"vendor_offers"> & { lines: Tables<"offer_lines">[] };

export default async function OffersPage({ params }: OffersPageProps) {
  const { id } = await params;
  const [workspace, session] = await Promise.all([loadRequestWorkspace(id), requireBroker()]);
  if (!workspace) notFound();

  const context = await loadOffersContext(session, id);
  const rfqRows: RfqWithNames[] = context.rfqs.filter((rfq) => SENT_RFQ_STATUSES.includes(rfq.status));
  const offerRows: OfferWithLines[] = context.offers;
  const lineRows: Tables<"request_lines">[] = context.lines;
  const messageRows: Tables<"messages">[] = context.messages;

  const attachmentIds = unique([
    ...offerRows.map((offer) => offer.attachment_id),
    ...messageRows.map((message) => message.raw_attachment_id),
  ]);
  const itemIds = unique(offerRows.flatMap((offer) => offer.lines.map((line) => line.offered_catalog_item_id)));

  const [rfqLines, attachments, designations] = await Promise.all([
    loadRfqLines(session, rfqRows.map((rfq) => rfq.id)),
    loadAttachments(session, attachmentIds),
    loadDesignations(session, itemIds),
  ]);

  const rfqById = new Map(rfqRows.map((rfq) => [rfq.id, rfq]));
  const messageById = new Map(messageRows.map((message) => [message.id, message]));
  const lineNoById = new Map(lineRows.map((line) => [line.id, line.line_no]));

  const rfqs: OffersRfq[] = rfqRows.map((rfq) => ({
    id: rfq.id,
    branch_id: rfq.branch_id,
    vendor_name: rfq.vendor_name,
    branch_name: rfq.branch_name,
    status: rfq.status,
    sent_at: rfq.sent_at,
    line_ids: rfqLines.filter((row) => row.rfq_id === rfq.id).map((row) => row.request_line_id),
  }));

  const offers: OfferCardData[] = offerRows.map((offer) => {
    const rfq = rfqById.get(offer.rfq_id) ?? context.rfqs.find((row) => row.id === offer.rfq_id) ?? null;
    return toOfferCard(offer, rfq, offer.message_id ? (messageById.get(offer.message_id) ?? null) : null, attachments, designations, lineNoById);
  });

  const requestLines: OfferRequestLine[] = lineRows
    .filter((line) => line.status !== "removed")
    .sort((a, b) => a.line_no - b.line_no)
    .map((line) => ({ id: line.id, line_no: line.line_no, description: line.description, qty: line.qty, unit: line.unit }));

  return (
    <OffersWorkspace
      request={{ id: workspace.request.id, status: workspace.request.status, revision: workspace.request.revision }}
      rfqs={rfqs}
      offers={offers}
      requestLines={requestLines}
      supersededBy={workspace.childRequestId}
    />
  );
}

// ---------------------------------------------------------------------------
// Row to prop mapping
// ---------------------------------------------------------------------------

function toOfferCard(
  offer: OfferWithLines,
  rfq: RfqWithNames | null,
  message: Tables<"messages"> | null,
  attachments: Map<string, OfferAttachment>,
  designations: Map<string, string>,
  lineNoById: ReadonlyMap<string, number>,
): OfferCardData {
  const offerMessage: OfferMessage | null = message
    ? {
        id: message.id,
        from_email: message.from_email,
        subject: message.subject,
        body_text: message.body_text,
        received_at: message.received_at,
        raw_attachment_id: message.raw_attachment_id,
      }
    : null;
  return {
    id: offer.id,
    rfq_id: offer.rfq_id,
    branch_id: offer.branch_id,
    vendor_name: rfq?.vendor_name ?? "Unknown vendor",
    branch_name: rfq?.branch_name ?? "Unknown branch",
    source: offer.source,
    status: offer.status,
    received_at: offer.received_at,
    quote_expires_at: offer.quote_expires_at,
    payment_terms: offer.payment_terms,
    early_pay_pct: offer.early_pay_pct,
    early_pay_days: offer.early_pay_days,
    freight_amount: offer.freight_amount,
    freight_basis: offer.freight_basis,
    notes: offer.notes,
    confidence: offer.confidence,
    message: offerMessage,
    attachment: offer.attachment_id ? (attachments.get(offer.attachment_id) ?? null) : null,
    // Request line order (line_no), then created_at, then id: every line of
    // one extraction shares a created_at, so that alone left the order random.
    lines: sortOfferLines(offer.lines, lineNoById).map((line) => toOfferLine(line, designations)),
  };
}

function toOfferLine(row: Tables<"offer_lines">, designations: Map<string, string>): OfferLineRow {
  return {
    id: row.id,
    offer_id: row.offer_id,
    request_line_id: row.request_line_id,
    offered_desc: row.offered_desc,
    offered_catalog_item_id: row.offered_catalog_item_id,
    offered_designation: row.offered_catalog_item_id ? (designations.get(row.offered_catalog_item_id) ?? null) : null,
    is_exact_match: row.is_exact_match,
    alternate_types: toAlternateTypes(row.alternate_types),
    available_qty: row.available_qty,
    unit: row.unit,
    availability: row.availability,
    ready_date: row.ready_date,
    delivery_estimate_text: row.delivery_estimate_text,
    unit_price: row.unit_price,
    price_basis: row.price_basis,
    flags: toFlags(row.flags),
    confidence: row.confidence,
    source_span: toSourceSpan(row.source_span),
  };
}

/** Unknown strings in flags (none expected) are dropped rather than rendered as chips. */
function toFlags(flags: string[]): OfferFlag[] {
  const known: OfferFlag[] = [];
  for (const flag of flags) {
    const parsed = offerFlagSchema.safeParse(flag);
    if (parsed.success) known.push(parsed.data);
  }
  return known;
}

function toAlternateTypes(values: string[]): AlternateType[] {
  const known: AlternateType[] = [];
  for (const value of values) {
    const parsed = alternateTypeSchema.safeParse(value);
    if (parsed.success) known.push(parsed.data);
  }
  return known;
}

function toSourceSpan(value: unknown): SourceSpan | null {
  const parsed = sourceSpanSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function unique(ids: Array<string | null>): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

// ---------------------------------------------------------------------------
// Supporting reads, all through the RLS client
// ---------------------------------------------------------------------------

async function loadRfqLines(session: BrokerSession, rfqIds: string[]): Promise<Pick<Tables<"rfq_lines">, "rfq_id" | "request_line_id">[]> {
  if (rfqIds.length === 0) return [];
  const { data, error } = await session.supabase
    .from("rfq_lines")
    .select("rfq_id, request_line_id")
    .eq("broker_id", session.brokerId)
    .in("rfq_id", rfqIds);
  if (error) throw new Error(`Could not read RFQ lines: ${error.message}`);
  return data ?? [];
}

async function loadAttachments(session: BrokerSession, ids: string[]): Promise<Map<string, OfferAttachment>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await session.supabase
    .from("attachments")
    .select("id, filename, mime")
    .eq("broker_id", session.brokerId)
    .in("id", ids);
  if (error) throw new Error(`Could not read attachments: ${error.message}`);
  return new Map((data ?? []).map((row) => [row.id, { id: row.id, filename: row.filename, mime: row.mime }]));
}

/** Designation per offered catalog item, read through the RLS client (the catalog is readable by every member). */
async function loadDesignations(session: BrokerSession, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await session.supabase.from("catalog_items").select("id, designation").in("id", ids);
  if (error) throw new Error(`Could not read catalog items: ${error.message}`);
  return new Map((data ?? []).map((item) => [item.id, item.designation]));
}

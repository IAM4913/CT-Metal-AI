// Review tab (PRD FR-2, FR-3): the original source beside the parsed lines,
// with parse, inline edit, add, remove, merge, link, clear flags, and confirm.
//
// Server component: loads the workspace through the cached loader shared with
// the [id] layout, looks up the designations of linked catalog items, decides
// server-side whether the request can be confirmed (AC-3.3), and hands plain
// serializable props (strings, numbers, booleans, null) to the client
// workspace. Nothing from the admin client reaches this file.

import { notFound } from "next/navigation";
import { z } from "zod";
import type { ReviewLine, SourceSpan } from "@/components/review/lines-grid";
import { ReviewWorkspace } from "@/components/review/review-workspace";
import type { SourceMessage } from "@/components/review/source-pane";
import type { Tables } from "@/lib/db/client";
import { requestLineFlagSchema, type RequestLineFlag } from "@/lib/db/enums";
import { loadRequestWorkspace } from "@/lib/server/requests";
import { canConfirm } from "@/lib/server/review";
import { requireBroker, type BrokerSession } from "@/lib/server/session";

type ReviewPageProps = {
  params: Promise<{ id: string }>;
};

// request_lines.source_span as written by parseRequest (PRD section 7). A
// manual line stores {} and shows as "no span" rather than failing the page.
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

export default async function ReviewPage({ params }: ReviewPageProps) {
  const { id } = await params;
  const [workspace, session] = await Promise.all([loadRequestWorkspace(id), requireBroker()]);
  if (!workspace) notFound();

  const { request, lines, attachments, messages, childRequestId } = workspace;
  const designations = await loadDesignations(session, lines);
  const reviewLines = lines.map((row) => toReviewLine(row, designations));
  const gate = canConfirm(lines);

  // The inbound email that created the request, when there is one.
  const inbound = messages.find((message) => message.direction === "in") ?? null;
  const message: SourceMessage | null = inbound
    ? {
        from_email: inbound.from_email,
        to_emails: inbound.to_emails,
        cc_emails: inbound.cc_emails,
        received_at: inbound.received_at,
      }
    : null;

  return (
    <ReviewWorkspace
      request={{ id: request.id, status: request.status, source_text: request.source_text }}
      lines={reviewLines}
      attachments={attachments.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size_bytes: a.size_bytes }))}
      message={message}
      canConfirm={{ ok: gate.ok, problems: [...gate.problems] }}
      supersededBy={childRequestId}
    />
  );
}

/** Designation per linked catalog item, read through the RLS client (the catalog is readable by every member). */
async function loadDesignations(
  session: BrokerSession,
  lines: Tables<"request_lines">[],
): Promise<Map<string, string>> {
  const ids = [...new Set(lines.map((line) => line.catalog_item_id).filter((v): v is string => v !== null))];
  if (ids.length === 0) return new Map();
  const { data, error } = await session.supabase.from("catalog_items").select("id, designation").in("id", ids);
  if (error) throw new Error(`Could not read catalog items: ${error.message}`);
  return new Map((data ?? []).map((item) => [item.id, item.designation]));
}

function toReviewLine(row: Tables<"request_lines">, designations: Map<string, string>): ReviewLine {
  return {
    id: row.id,
    line_no: row.line_no,
    raw_text: row.raw_text,
    description: row.description,
    category: row.category,
    catalog_item_id: row.catalog_item_id,
    catalog_designation: row.catalog_item_id ? (designations.get(row.catalog_item_id) ?? null) : null,
    dims: toDims(row.dims),
    grade_spec: row.grade_spec,
    qty: row.qty,
    unit: row.unit,
    length_ft: row.length_ft,
    length_text: row.length_text,
    cut_to_length: row.cut_to_length,
    delivery_notes: row.delivery_notes,
    flags: toFlags(row.flags),
    confidence: row.confidence,
    source_span: toSourceSpan(row.source_span),
    status: row.status,
  };
}

function toDims(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Unknown strings in flags (none expected) are dropped rather than rendered as chips. */
function toFlags(flags: string[]): RequestLineFlag[] {
  const known: RequestLineFlag[] = [];
  for (const flag of flags) {
    const parsed = requestLineFlagSchema.safeParse(flag);
    if (parsed.success) known.push(parsed.data);
  }
  return known;
}

function toSourceSpan(value: unknown): SourceSpan | null {
  const parsed = sourceSpanSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

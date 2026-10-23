// parseRequest(): extract a request's material lines with the model, normalize
// them in code, and write request_lines (PLAN Step 4, PRD FR-2).
//
// Flow: load the request and its PDF attachments (RLS); download the PDFs with
// the admin client (the attachments bucket is reachable only with the secret
// key, see src/lib/server/attachments.ts) and split them into pages; build the
// extraction document (source text first, then one segment per page); load the
// alias index (seed aliases plus this broker's learned ones, learned first so
// they win a tie); set status "parsing"; one callExtractionTool() call; the
// deterministic pass (src/lib/parsing/normalize.ts); replace the previously
// parsed lines; set status "needs_review"; log request.parsed.
//
// Lines the broker has already confirmed, marked custom, or removed are kept on
// a re-parse. Only lines with status "parsed" are replaced, and the new lines
// are numbered after the kept ones. The swap is insert first, delete second:
// the new rows are written, then the previous parsed rows are deleted by id.
// Supabase JS has no transactions, so this order is the guard against losing
// the old lines: a failed insert leaves them untouched, and a failed delete
// leaves both sets on a request reset to "new", where the next Parse replaces
// every parsed line again. line_no has no unique constraint, so the two sets
// may share numbers for the moment both exist.
//
// On any failure after the status flips to "parsing" the request goes back to
// "new" and the error is rethrown; the llm_call row (written by
// callExtractionTool, success or failure) is the record of what happened.

import { createAdminClient, type Db, type Tables, type TablesInsert } from "@/lib/db/client";
import type { Json } from "@/lib/db/types";
import type { RequestStatus } from "@/lib/db/enums";
import { extractPdfPages } from "@/lib/mail/pdf-text";
import { createAliasIndex, type AliasIndex, type AliasIndexRow } from "@/lib/parsing/alias-index";
import { buildExtractionDocument, type DocumentSegment } from "@/lib/parsing/document";
import { callExtractionTool } from "@/lib/parsing/extract";
import { normalizeExtractedLines, type NormalizedLine } from "@/lib/parsing/normalize";
import { buildExtractionUserMessage, EXTRACTION_SYSTEM_PROMPT } from "@/lib/parsing/prompt";
import { EXTRACT_MATERIAL_LINES, extractMaterialLinesOutputSchema } from "@/lib/parsing/schema";
import { ATTACHMENTS_BUCKET } from "@/lib/server/attachments";
import type { BrokerSession } from "@/lib/server/session";

const PDF_MIME = "application/pdf";

// PostgREST caps a response at 1000 rows by default; the seed catalog has over
// 11000 aliases, so the index is loaded in pages.
const ALIAS_PAGE_SIZE = 1000;

export async function parseRequest(session: BrokerSession, requestId: string): Promise<{ lineCount: number }> {
  const request = await loadRequest(session, requestId);
  await setRequestStatus(session, requestId, "parsing");

  try {
    const attachments = await loadPdfAttachments(session, requestId);
    const segments: DocumentSegment[] = [{ kind: "text", text: request.source_text }];
    let attachmentPages = 0;
    for (const attachment of attachments) {
      const bytes = await downloadAttachment(attachment.storage_path);
      const pages = await extractPdfPages(bytes);
      pages.forEach((text, i) => {
        segments.push({ kind: "attachment", attachmentId: attachment.id, filename: attachment.filename, page: i + 1, text });
      });
      attachmentPages += pages.length;
    }
    const doc = buildExtractionDocument(segments);
    const index = await loadAliasIndex(session.supabase);

    const call = await callExtractionTool({
      supabase: session.supabase,
      brokerId: session.brokerId,
      actorUserId: session.userId,
      entityType: "request",
      entityId: requestId,
      toolName: EXTRACT_MATERIAL_LINES,
      system: EXTRACTION_SYSTEM_PROMPT,
      userContent: buildExtractionUserMessage(doc),
      schema: extractMaterialLinesOutputSchema,
    });

    const lines = normalizeExtractedLines(call.output, doc, index);
    const existing = await loadExistingLines(session, requestId);
    const kept = existing.filter((row) => row.status !== "parsed");
    const stale = existing.filter((row) => row.status === "parsed").map((row) => row.id);
    const lineNoBase = kept.reduce((max, row) => Math.max(max, row.line_no), 0);
    const rows = lines.map((line) => toInsertRow(session, requestId, lineNoBase, line));
    if (rows.length > 0) {
      const { error } = await session.supabase.from("request_lines").insert(rows);
      if (error) {
        throw new Error(`Could not save the parsed lines: ${error.message}`);
      }
    }
    await deleteLines(session, requestId, stale);

    await setRequestStatus(session, requestId, "needs_review");
    await logActivity(session, requestId, "request.parsed", {
      line_count: rows.length,
      model: call.model,
      attachment_pages: attachmentPages,
      unverified_spans: lines.filter((line) => !line.span_verified).length,
      notes: call.output.notes,
      input_tokens: call.inputTokens,
      output_tokens: call.outputTokens,
      latency_ms: call.latencyMs,
    });

    return { lineCount: rows.length };
  } catch (error) {
    try {
      await setRequestStatus(session, requestId, "new");
    } catch {
      // The parse failure is the error to surface.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reads
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

async function loadPdfAttachments(session: BrokerSession, requestId: string): Promise<Tables<"attachments">[]> {
  const { data, error } = await session.supabase
    .from("attachments")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("owner_type", "request")
    .eq("owner_id", requestId)
    .eq("mime", PDF_MIME)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Could not read attachments: ${error.message}`);
  }
  return data ?? [];
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

function asDims(value: Json): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Every alias visible to this broker (seed rows and its own learned rows, the
 * learned ones first so they take precedence), plus every item by designation
 * so an item with no alias row is still reachable by its canonical name.
 */
export async function loadAliasIndex(supabase: Db): Promise<AliasIndex> {
  const rows: AliasIndexRow[] = [];

  for (let from = 0; ; from += ALIAS_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("catalog_aliases")
      .select("alias, catalog_item_id, catalog_items(designation, category, weight_per_ft, dims)")
      .order("broker_id", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, from + ALIAS_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Could not read catalog aliases: ${error.message}`);
    }
    const page = data ?? [];
    for (const row of page) {
      const item = row.catalog_items;
      if (!item) continue;
      rows.push({
        alias: row.alias,
        catalog_item_id: row.catalog_item_id,
        designation: item.designation,
        category: item.category,
        weight_per_ft: item.weight_per_ft,
        dims: asDims(item.dims),
      });
    }
    if (page.length < ALIAS_PAGE_SIZE) break;
  }

  const { data: items, error: itemsError } = await supabase
    .from("catalog_items")
    .select("id, designation, category, weight_per_ft, dims")
    .order("designation", { ascending: true });
  if (itemsError) {
    throw new Error(`Could not read catalog items: ${itemsError.message}`);
  }
  for (const item of items ?? []) {
    rows.push({
      alias: item.designation,
      catalog_item_id: item.id,
      designation: item.designation,
      category: item.category,
      weight_per_ft: item.weight_per_ft,
      dims: asDims(item.dims),
    });
  }

  return createAliasIndex(rows);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function setRequestStatus(session: BrokerSession, requestId: string, status: RequestStatus): Promise<void> {
  const { error } = await session.supabase
    .from("requests")
    .update({ status })
    .eq("broker_id", session.brokerId)
    .eq("id", requestId);
  if (error) {
    throw new Error(`Could not set request status to ${status}: ${error.message}`);
  }
}

type ExistingLine = Pick<Tables<"request_lines">, "id" | "line_no" | "status">;

/**
 * Every line the request has now: the ones a previous parse wrote (status
 * "parsed", replaced by this parse) and the ones the broker touched (confirmed,
 * custom, removed, kept and numbered before the new lines).
 */
async function loadExistingLines(session: BrokerSession, requestId: string): Promise<ExistingLine[]> {
  const { data, error } = await session.supabase
    .from("request_lines")
    .select("id, line_no, status")
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId);
  if (error) {
    throw new Error(`Could not read existing lines: ${error.message}`);
  }
  return data ?? [];
}

/** Delete the previously parsed lines by id, after the new ones are in place. */
async function deleteLines(session: BrokerSession, requestId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await session.supabase
    .from("request_lines")
    .delete()
    .eq("broker_id", session.brokerId)
    .eq("request_id", requestId)
    .in("id", ids);
  if (error) {
    throw new Error(`Could not clear the previously parsed lines: ${error.message}`);
  }
}

function toInsertRow(
  session: BrokerSession,
  requestId: string,
  lineNoBase: number,
  line: NormalizedLine,
): TablesInsert<"request_lines"> {
  return {
    broker_id: session.brokerId,
    request_id: requestId,
    line_no: lineNoBase + line.line_no,
    raw_text: line.raw_text,
    catalog_item_id: line.catalog_item_id,
    category: line.category,
    description: line.description,
    dims: line.dims,
    grade_spec: line.grade_spec,
    qty: line.qty,
    unit: line.unit,
    length_ft: line.length_ft,
    length_text: line.length_text,
    cut_to_length: line.cut_to_length,
    delivery_notes: line.delivery_notes,
    flags: line.flags,
    confidence: line.confidence,
    source_span: line.source_span,
    status: "parsed",
  };
}

async function logActivity(
  session: BrokerSession,
  requestId: string,
  action: string,
  payload: { [key: string]: Json | undefined },
): Promise<void> {
  const { error } = await session.supabase.from("activity_log").insert({
    broker_id: session.brokerId,
    entity_type: "request",
    entity_id: requestId,
    action,
    actor_user_id: session.userId,
    payload,
  });
  if (error) {
    throw new Error(`Could not write the activity log: ${error.message}`);
  }
}

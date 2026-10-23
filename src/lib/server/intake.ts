// Intake: turn a pasted list, an uploaded .eml, or hand-entered lines into a
// requests row (PLAN Step 3, PRD FR-1).
//
// Every function takes the caller's BrokerSession and writes the business rows
// (requests, request_lines, messages, activity_log) through session.supabase,
// so row level security applies and every row carries the session's broker_id.
// Files go through storeAttachment() (src/lib/server/attachments.ts), which is
// the one place the admin client touches Storage.
//
// Nothing here parses material lines: paste and eml requests are stored with
// status "new" and PLAN Step 4 extracts their lines. Manual lines are typed by
// the broker, so they are written as request_lines right away with the flags
// the deterministic rules produce, and the request starts at "needs_review"
// (the review grid still has to link them to catalog items).
//
// A request survives whole or not at all. Everything written after the
// requests row (Storage objects, attachments rows, the message, the lines, the
// request.created activity row) runs inside orDiscard(), which deletes the
// request again when any of it fails, so a half-made request never sits in the
// work queue and a retry never duplicates one. No transaction spans Storage
// and Postgres, so this is best effort, but it is the same best effort on
// every path.
//
// Missing data stays null plus a flag. No grade, quantity, or length is ever
// defaulted here.

import { parseEml, parsedEmlHeadersSchema, type ParsedEml } from "@/lib/mail/eml";
import type { TablesInsert } from "@/lib/db/client";
import type { RequestSourceType } from "@/lib/db/enums";
import { computeLineFlags, manualDuplicateDims, markPossibleDuplicates } from "@/lib/parsing/flags";
import { buildManualRequest, type ManualLineInput } from "@/lib/parsing/manual";
import { removeAttachmentObjects, storeAttachment } from "@/lib/server/attachments";
import type { BrokerSession } from "@/lib/server/session";

export type CreatedRequest = { requestId: string };

type RequestInsert = TablesInsert<"requests">;
type RequestLineInsert = TablesInsert<"request_lines">;

/** Raw bytes of an uploaded .eml plus the name the browser gave it. */
export type EmlUpload = { name: string; bytes: Uint8Array };

/**
 * The uploaded file could not be read as an email: mailparser failed or the
 * headers did not pass parsedEmlHeadersSchema. Thrown before anything is
 * written, so the action can tell the broker the file is the problem. Every
 * other error out of createEmlRequest is a write failure (Storage, RLS, the
 * activity log) and is reported as one, never as a bad file.
 */
export class EmlParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmlParseError";
  }
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

/**
 * AC-1.1: a pasted plain-text list with optional subject and customer. The text
 * is stored unchanged as source_text (leading and trailing whitespace
 * included; the action validates without transforming); Step 4 parses it.
 */
export async function createPasteRequest(
  session: BrokerSession,
  input: { text: string; subject: string | null; customerId: string | null },
): Promise<CreatedRequest> {
  const requestId = await insertRequest(session, {
    broker_id: session.brokerId,
    customer_id: input.customerId,
    source_type: "paste",
    subject: input.subject ?? "",
    source_text: input.text,
    received_at: new Date().toISOString(),
    status: "new",
  });

  await orDiscard(session, requestId, () => logRequestCreated(session, requestId, { source_type: "paste" }));
  return { requestId };
}

// ---------------------------------------------------------------------------
// .eml upload
// ---------------------------------------------------------------------------

/**
 * AC-1.2: an uploaded .eml. Headers, body, and attachments are parsed with
 * mailparser (src/lib/mail/eml.ts). The full text body, signature and quoted
 * thread included, becomes source_text so the review pane shows exactly what
 * the customer sent. The raw .eml and every parsed attachment are stored under
 * the request (owner_type "request"), and the email itself is recorded as an
 * inbound messages row pointing at the stored .eml.
 *
 * The customer is linked when the sender's domain matches exactly one of this
 * broker's customers.email_domain (case-insensitive). Two customers on the same
 * domain, or no match, leaves customer_id null for the broker to set.
 *
 * Throws EmlParseError when the file cannot be read as an email; any other
 * error is a write failure.
 */
export async function createEmlRequest(session: BrokerSession, file: EmlUpload): Promise<CreatedRequest> {
  const parsed = await parseUploadedEml(file.bytes);

  const receivedAt = validDate(parsed.date) ?? new Date();
  const customerId = await matchCustomerByDomain(session, parsed.from?.address ?? null);

  const requestId = await insertRequest(session, {
    broker_id: session.brokerId,
    customer_id: customerId,
    source_type: "eml",
    subject: parsed.subject ?? "",
    source_text: parsed.text,
    source_message_id: parsed.messageId,
    received_at: receivedAt.toISOString(),
    status: "new",
  });

  await orDiscard(session, requestId, async () => {
    const rawEml = await storeAttachment({
      brokerId: session.brokerId,
      ownerType: "request",
      ownerId: requestId,
      filename: file.name,
      mime: "message/rfc822",
      bytes: file.bytes,
    });

    for (const attachment of parsed.attachments) {
      await storeAttachment({
        brokerId: session.brokerId,
        ownerType: "request",
        ownerId: requestId,
        filename: attachment.filename,
        mime: attachment.contentType,
        bytes: attachment.content,
      });
    }

    await insertInboundMessage(session, requestId, parsed, receivedAt, rawEml.id);
    await logRequestCreated(session, requestId, {
      source_type: "eml",
      attachment_count: parsed.attachments.length,
    });
  });

  return { requestId };
}

/** parseEml plus the header schema, with any failure wrapped as EmlParseError. */
async function parseUploadedEml(bytes: Uint8Array): Promise<ParsedEml> {
  try {
    const parsed = await parseEml(toBuffer(bytes));
    // Fail loudly on a header shape mailparser should never produce (PRD section 11:
    // Zod at every boundary, the .eml parse output included).
    parsedEmlHeadersSchema.parse(parsed);
    return parsed;
  } catch (error) {
    throw new EmlParseError(`Could not read the .eml file: ${errorMessage(error)}`, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Manual lines
// ---------------------------------------------------------------------------

/**
 * AC-1.3: lines typed into the form. buildManualRequest() (pure, tested) turns
 * them into a synthetic source_text with one line per input and a span per
 * line, so the review pane works the same way it does for a paste. Lines are
 * written as request_lines with catalog_item_id null; Step 4's alias lookup
 * and the review grid link them. Flags come from computeLineFlags(), so a blank
 * qty or grade is flagged, never filled.
 */
export async function createManualRequest(
  session: BrokerSession,
  lines: ManualLineInput[],
  input: { subject: string | null; customerId: string | null },
): Promise<CreatedRequest> {
  if (lines.length === 0) {
    throw new Error("A manual request needs at least one line.");
  }

  const built = buildManualRequest(lines);

  const requestId = await insertRequest(session, {
    broker_id: session.brokerId,
    customer_id: input.customerId,
    source_type: "manual",
    subject: input.subject ?? "",
    source_text: built.source_text,
    received_at: new Date().toISOString(),
    status: "needs_review",
  });

  const flagged = markPossibleDuplicates(
    built.lines.map((line) => ({
      line,
      description: line.description,
      // Duplicate key only. A manual line has no section dims until Step 4
      // normalizes it, so the fields the broker typed (qty, unit, length,
      // grade) stand in: two W12x26 lines in different lengths are two lines.
      // The stored dims below stay {}.
      dims: manualDuplicateDims(line),
      flags: computeLineFlags({
        qty: line.qty,
        unit: line.unit,
        length_ft: line.length_ft,
        length_text: line.length_text,
        grade_spec: line.grade_spec,
        catalog_item_id: null,
        category: null,
        alternates_mentioned: [],
        ambiguous_size: false,
        ambiguous_unit: false,
      }),
    })),
  );

  const rows: RequestLineInsert[] = flagged.map(({ line, flags }) => ({
    broker_id: session.brokerId,
    request_id: requestId,
    line_no: line.line_no,
    raw_text: line.raw_text,
    catalog_item_id: null,
    category: null,
    description: line.description,
    dims: {},
    grade_spec: line.grade_spec,
    qty: line.qty,
    unit: line.unit,
    length_ft: line.length_ft,
    length_text: line.length_text,
    cut_to_length: false,
    delivery_notes: line.delivery_notes,
    flags,
    // Typed by the broker, not extracted, so there is nothing uncertain to score.
    confidence: 1,
    source_span: line.source_span,
    status: "parsed",
  }));

  await orDiscard(session, requestId, async () => {
    const { error } = await session.supabase.from("request_lines").insert(rows);
    if (error) {
      throw new Error(`Could not save request lines: ${error.message}`);
    }
    await logRequestCreated(session, requestId, { source_type: "manual", line_count: rows.length });
  });

  return { requestId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertRequest(session: BrokerSession, row: RequestInsert): Promise<string> {
  const { data, error } = await session.supabase.from("requests").insert(row).select("id").single();
  if (error) {
    throw new Error(`Could not create request: ${error.message}`);
  }
  return data.id;
}

async function insertInboundMessage(
  session: BrokerSession,
  requestId: string,
  parsed: ParsedEml,
  receivedAt: Date,
  rawAttachmentId: string,
): Promise<void> {
  const row: TablesInsert<"messages"> = {
    broker_id: session.brokerId,
    direction: "in",
    request_id: requestId,
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
    // The broker uploaded this file against a new request by hand; "thread"
    // is for replies matched by In-Reply-To (Step 6).
    matched_by: "manual",
    raw_attachment_id: rawAttachmentId,
  };
  const { error } = await session.supabase.from("messages").insert(row);
  if (error) {
    throw new Error(`Could not record the email message: ${error.message}`);
  }
}

/**
 * The customer whose email_domain equals the sender's domain, case-insensitive,
 * when exactly one does. Compared in code rather than with ilike so a domain
 * containing LIKE wildcards cannot widen the match.
 */
async function matchCustomerByDomain(session: BrokerSession, fromAddress: string | null): Promise<string | null> {
  const domain = emailDomain(fromAddress);
  if (!domain) return null;

  const { data, error } = await session.supabase
    .from("customers")
    .select("id, email_domain")
    .eq("broker_id", session.brokerId)
    .neq("email_domain", "");
  if (error) {
    throw new Error(`Could not read customers: ${error.message}`);
  }

  const matches = (data ?? []).filter((c) => normalizeDomain(c.email_domain) === domain);
  return matches.length === 1 ? matches[0].id : null;
}

function emailDomain(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return null;
  return normalizeDomain(address.slice(at + 1));
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^@/, "").toLowerCase();
}

function validDate(date: Date | null): Date | null {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function logRequestCreated(
  session: BrokerSession,
  requestId: string,
  payload: { source_type: RequestSourceType; line_count?: number; attachment_count?: number },
): Promise<void> {
  const { error } = await session.supabase.from("activity_log").insert({
    broker_id: session.brokerId,
    entity_type: "request",
    entity_id: requestId,
    action: "request.created",
    actor_user_id: session.userId,
    payload,
  });
  if (error) {
    throw new Error(`Could not write the activity log: ${error.message}`);
  }
}

/**
 * Run the writes that follow insertRequest(). If any of them fails the request
 * is discarded and the error rethrown, so a request only exists together with
 * its children and its request.created row. The activity_log insert is last
 * and append-only, so a failure there leaves no log row to clean up.
 */
async function orDiscard<T>(session: BrokerSession, requestId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await discardRequest(session, requestId);
    throw error;
  }
}

/**
 * Best-effort cleanup after a partial failure: the request, its messages, its
 * attachments rows, and the Storage objects those rows point at. The object key
 * embeds the request id, so a retry (a new request with a new id) could never
 * reach these objects again; they are removed now or they leak. Errors here are
 * swallowed so the error that triggered the cleanup is the one that surfaces.
 */
async function discardRequest(session: BrokerSession, requestId: string): Promise<void> {
  try {
    const { data: stored } = await session.supabase
      .from("attachments")
      .select("storage_path")
      .eq("broker_id", session.brokerId)
      .eq("owner_type", "request")
      .eq("owner_id", requestId);

    // Children first: messages point at the request and at the raw .eml
    // attachment, neither with a cascade. request_lines cascade with the request.
    await session.supabase.from("messages").delete().eq("broker_id", session.brokerId).eq("request_id", requestId);
    await session.supabase
      .from("attachments")
      .delete()
      .eq("broker_id", session.brokerId)
      .eq("owner_type", "request")
      .eq("owner_id", requestId);
    await session.supabase.from("requests").delete().eq("broker_id", session.brokerId).eq("id", requestId);

    // Objects last, once no row points at them.
    await removeAttachmentObjects((stored ?? []).map((row) => row.storage_path));
  } catch {
    // Reported through the error that triggered the cleanup.
  }
}

// Attachment storage: Supabase Storage bucket "attachments" plus the attachments
// table (PRD section 11).
//
// Path rule, applied exactly: {broker_id}/{owner_type}/{owner_id}/{sha256}-{filename}
// with safeFilename() on the filename, so a path is always safe to use as an
// object key and two uploads of the same bytes for the same owner land on the
// same object (dedupe by hash).
//
// storeAttachment(), removeAttachmentObjects(), and signedAttachmentUrl() use
// the admin client, so this module lives under src/lib/server/** and is never
// imported by a client component. Callers must have already checked tenancy: the broker_id they pass
// is the one from requireBroker(), and the owner row was loaded through RLS.
// attachmentStoragePath() and safeFilename() are pure and unit tested.

import { createHash } from "node:crypto";
import { createAdminClient, type Tables, type TablesInsert } from "@/lib/db/client";

export type AttachmentOwnerType = "request" | "message" | "vendor_offer";

export const ATTACHMENTS_BUCKET = "attachments";

const MAX_FILENAME_LENGTH = 120;
const FALLBACK_FILENAME = "attachment";
const DEFAULT_SIGNED_URL_SECONDS = 600;

/**
 * Keep letters, digits, dot, dash, and underscore; every run of anything else
 * becomes one dash; cut to 120 characters; "attachment" when nothing is left.
 */
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, MAX_FILENAME_LENGTH);
  return cleaned === "" ? FALLBACK_FILENAME : cleaned;
}

export function attachmentStoragePath(args: {
  brokerId: string;
  ownerType: AttachmentOwnerType;
  ownerId: string;
  sha256: string;
  filename: string;
}): string {
  return `${args.brokerId}/${args.ownerType}/${args.ownerId}/${args.sha256}-${safeFilename(args.filename)}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Upload bytes to the attachments bucket and insert the attachments row. When
 * this owner already has an attachment with the same sha256 the existing row is
 * returned and nothing is uploaded or inserted.
 */
export async function storeAttachment(args: {
  brokerId: string;
  ownerType: AttachmentOwnerType;
  ownerId: string;
  filename: string;
  mime: string;
  bytes: Uint8Array;
}): Promise<Tables<"attachments">> {
  const sha256 = sha256Hex(args.bytes);
  const admin = createAdminClient();

  const { data: existing, error: lookupError } = await admin
    .from("attachments")
    .select("*")
    .eq("broker_id", args.brokerId)
    .eq("owner_type", args.ownerType)
    .eq("owner_id", args.ownerId)
    .eq("sha256", sha256)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (lookupError) {
    throw new Error(`Could not check for an existing attachment: ${lookupError.message}`);
  }
  if (existing) return existing;

  const storagePath = attachmentStoragePath({
    brokerId: args.brokerId,
    ownerType: args.ownerType,
    ownerId: args.ownerId,
    sha256,
    filename: args.filename,
  });

  const { error: uploadError } = await admin.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(storagePath, args.bytes, { contentType: args.mime, upsert: true });
  if (uploadError) {
    throw new Error(`Could not upload ${storagePath}: ${uploadError.message}`);
  }

  const row: TablesInsert<"attachments"> = {
    broker_id: args.brokerId,
    owner_type: args.ownerType,
    owner_id: args.ownerId,
    storage_path: storagePath,
    filename: args.filename,
    mime: args.mime,
    size_bytes: args.bytes.byteLength,
    sha256,
  };
  const { data, error } = await admin.from("attachments").insert(row).select("*").single();
  if (error) {
    throw new Error(`Could not insert the attachment row for ${storagePath}: ${error.message}`);
  }
  return data;
}

/**
 * Delete objects from the attachments bucket. Used when a request is discarded
 * after a partial failure: the object key embeds the owner id, so nothing
 * could ever reach those objects again. Callers delete the attachments rows
 * first so no row points at a missing object. No-op for an empty list.
 */
export async function removeAttachmentObjects(storagePaths: string[]): Promise<void> {
  if (storagePaths.length === 0) return;
  const admin = createAdminClient();
  const { error } = await admin.storage.from(ATTACHMENTS_BUCKET).remove(storagePaths);
  if (error) {
    throw new Error(`Could not remove ${storagePaths.length} attachment object(s): ${error.message}`);
  }
}

/** Short-lived download URL for an object in the attachments bucket. */
export async function signedAttachmentUrl(
  storagePath: string,
  expiresInSeconds: number = DEFAULT_SIGNED_URL_SECONDS,
): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(storagePath, expiresInSeconds);
  if (error) {
    throw new Error(`Could not sign a URL for ${storagePath}: ${error.message}`);
  }
  return data.signedUrl;
}

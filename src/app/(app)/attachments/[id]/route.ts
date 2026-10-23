// GET /attachments/[id]: open a stored file.
//
// The attachments row is loaded through the RLS client, so a file that belongs
// to another broker is a 404, not a download. Only after that check does the
// admin client (inside signedAttachmentUrl) sign a short-lived Storage URL,
// and the browser is redirected to it. requireBroker() redirects to /login when
// nobody is signed in; redirect() works in route handlers.
//
// The context is typed by hand rather than with the generated RouteContext
// helper so a plain `tsc --noEmit` passes on a fresh checkout before typegen.

import { NextResponse } from "next/server";
import { z } from "zod";
import { signedAttachmentUrl } from "@/lib/server/attachments";
import { requireBroker } from "@/lib/server/session";

const uuidSchema = z.uuid();

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await requireBroker();
  const { id } = await ctx.params;

  if (!uuidSchema.safeParse(id).success) {
    return new Response("Attachment not found", { status: 404 });
  }

  const { data: attachment, error } = await session.supabase
    .from("attachments")
    .select("id, storage_path")
    .eq("broker_id", session.brokerId)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read attachment: ${error.message}`);
  }
  if (!attachment) {
    return new Response("Attachment not found", { status: 404 });
  }

  const url = await signedAttachmentUrl(attachment.storage_path);
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store" } });
}

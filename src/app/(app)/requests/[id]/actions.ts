"use server";

// Review tab server actions (PRD FR-2, FR-3). Thin wrappers: each one checks
// the session, validates its arguments with Zod, calls the lib function in
// src/lib/server, revalidates the request page, and returns a plain result.
// Nothing here throws to the client: a failure is logged server-side and comes
// back as { ok: false, error } so the grid can show it next to the cell.
//
// requireBroker() redirects to /login when nobody is signed in. redirect()
// works by throwing, so it is called before the try/catch in attempt(), never
// inside it.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseRequest } from "@/lib/server/parse-request";
import {
  addLine,
  clearLineFlags,
  confirmRequest,
  lineEditSchema,
  linkLineToItem,
  mergeLines,
  removeLine,
  searchCatalog,
  updateLine,
} from "@/lib/server/review";
import { requireBroker, type BrokerSession } from "@/lib/server/session";

type Ok<T> = { ok: true } & T;
type Failed = { ok: false; error: string };
type ActionResult<T = object> = Ok<T> | Failed;

const idSchema = z.uuid();
const searchSchema = z.string().trim().min(1).max(120);

// A new line needs a description; everything else may be left blank and is
// flagged by computeLineFlags in the lib, never filled in.
const addLineSchema = lineEditSchema.extend({
  description: z.string().trim().min(1, "Description is required"),
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export async function parseRequestAction(requestId: string): Promise<ActionResult<{ lineCount: number }>> {
  const session = await requireBroker();
  return attempt("parseRequest", async () => {
    const id = idSchema.parse(requestId);
    const { lineCount } = await parseRequest(session, id);
    revalidateRequest(id);
    return { lineCount };
  });
}

// ---------------------------------------------------------------------------
// Line edits
// ---------------------------------------------------------------------------

export async function updateLineAction(lineId: string, patch: unknown): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("updateLine", async () => {
    const id = idSchema.parse(lineId);
    const edit = lineEditSchema.parse(patch);
    const requestId = await requestIdForLine(session, id);
    await updateLine(session, id, edit);
    revalidateRequest(requestId);
    return {};
  });
}

export async function addLineAction(requestId: string, input: unknown): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("addLine", async () => {
    const id = idSchema.parse(requestId);
    const line = addLineSchema.parse(input);
    await addLine(session, id, line);
    revalidateRequest(id);
    return {};
  });
}

export async function removeLineAction(lineId: string): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("removeLine", async () => {
    const id = idSchema.parse(lineId);
    const requestId = await requestIdForLine(session, id);
    await removeLine(session, id);
    revalidateRequest(requestId);
    return {};
  });
}

export async function mergeLinesAction(keepId: string, dropId: string): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("mergeLines", async () => {
    const keep = idSchema.parse(keepId);
    const drop = idSchema.parse(dropId);
    if (keep === drop) throw new Error("Pick two different lines to merge");
    const requestId = await requestIdForLine(session, keep);
    await mergeLines(session, keep, drop);
    revalidateRequest(requestId);
    return {};
  });
}

export async function linkLineToItemAction(lineId: string, catalogItemId: string): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("linkLineToItem", async () => {
    const id = idSchema.parse(lineId);
    const itemId = idSchema.parse(catalogItemId);
    const requestId = await requestIdForLine(session, id);
    await linkLineToItem(session, id, itemId);
    revalidateRequest(requestId);
    return {};
  });
}

export async function clearLineFlagsAction(lineId: string): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("clearLineFlags", async () => {
    const id = idSchema.parse(lineId);
    const requestId = await requestIdForLine(session, id);
    await clearLineFlags(session, id);
    revalidateRequest(requestId);
    return {};
  });
}

// ---------------------------------------------------------------------------
// Request level
// ---------------------------------------------------------------------------

export async function confirmRequestAction(requestId: string): Promise<ActionResult> {
  const session = await requireBroker();
  return attempt("confirmRequest", async () => {
    const id = idSchema.parse(requestId);
    await confirmRequest(session, id);
    revalidateRequest(id);
    return {};
  });
}

// The result rows are the lib's { id, designation, category }; the dialog
// types them with Awaited<ReturnType<typeof searchCatalogAction>>, since a
// "use server" module exports only async functions.
export async function searchCatalogAction(q: string) {
  const session = await requireBroker();
  return attempt("searchCatalog", async () => {
    const query = searchSchema.parse(q);
    const results = await searchCatalog(session, query);
    return { results };
  });
}

// ---------------------------------------------------------------------------
// Helpers (not exported: a "use server" module may export only async functions)
// ---------------------------------------------------------------------------

async function attempt<T extends object>(name: string, work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const value = await work();
    return { ok: true, ...value };
  } catch (error) {
    console.error(`[review] ${name} failed`, error);
    return { ok: false, error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
    return `Invalid input. ${where}${first?.message ?? "check the values"}`;
  }
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "Something went wrong. Try again.";
}

/**
 * The request a line belongs to, read under RLS so a line id from another
 * broker is "not found" rather than a row. Used only to know which page to
 * revalidate; the lib function does its own loading and checks.
 */
async function requestIdForLine(session: BrokerSession, lineId: string): Promise<string> {
  const { data, error } = await session.supabase
    .from("request_lines")
    .select("request_id")
    .eq("broker_id", session.brokerId)
    .eq("id", lineId)
    .maybeSingle();
  if (error) throw new Error(`Could not read line: ${error.message}`);
  if (!data) throw new Error("Line not found");
  return data.request_id;
}

function revalidateRequest(requestId: string): void {
  revalidatePath(`/requests/${requestId}`);
  // Work queue counts by status (Step 8) change when a request is parsed or confirmed.
  revalidatePath("/");
}

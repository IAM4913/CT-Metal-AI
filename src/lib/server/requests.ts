// Read side of a request: everything the /requests/[id] workspace shows.
//
// Every query runs through session.supabase (the RLS client), so a request id
// that belongs to another broker reads as "not found", never as a row. The
// explicit broker_id filters are belt and braces on top of the policies.
//
// loadRequestWorkspace() is wrapped in React cache() so the [id] layout and
// the tab page under it, which both need the same rows, share one set of
// queries per server render.

import { cache } from "react";
import { z } from "zod";
import type { Tables } from "@/lib/db/client";
import { requireBroker, type BrokerSession } from "@/lib/server/session";

export type RequestWorkspace = {
  request: Tables<"requests">;
  customer: Tables<"customers"> | null;
  lines: Tables<"request_lines">[];
  attachments: Tables<"attachments">[];
  messages: Tables<"messages">[];
  /**
   * The newest later revision of this request (parent_request_id = this id),
   * when one exists (AC-8.4). Highest revision, then newest created_at. A set
   * child means this revision is superseded: the tabs render it read-only and
   * every write path refuses it (assertNotSuperseded in revisions.ts).
   */
  childRequestId: string | null;
};

export type CustomerOption = Pick<Tables<"customers">, "id" | "name" | "short_name">;

const uuidSchema = z.uuid();

/**
 * The request with its customer, lines (by line_no), attachments stored under
 * it (owner_type "request"), and messages. Null when the id is not a uuid or
 * no visible request has it.
 */
export async function getRequestWorkspace(
  session: BrokerSession,
  requestId: string,
): Promise<RequestWorkspace | null> {
  // Postgres rejects a malformed uuid with an error; a bad id is simply "not found".
  if (!uuidSchema.safeParse(requestId).success) return null;

  const { supabase, brokerId } = session;

  const [requestResult, linesResult, attachmentsResult, messagesResult, childResult] = await Promise.all([
    supabase.from("requests").select("*").eq("broker_id", brokerId).eq("id", requestId).maybeSingle(),
    supabase
      .from("request_lines")
      .select("*")
      .eq("broker_id", brokerId)
      .eq("request_id", requestId)
      .order("line_no", { ascending: true }),
    supabase
      .from("attachments")
      .select("*")
      .eq("broker_id", brokerId)
      .eq("owner_type", "request")
      .eq("owner_id", requestId)
      .order("created_at", { ascending: true }),
    supabase
      .from("messages")
      .select("*")
      .eq("broker_id", brokerId)
      .eq("request_id", requestId)
      .order("received_at", { ascending: true }),
    supabase
      .from("requests")
      .select("id")
      .eq("broker_id", brokerId)
      .eq("parent_request_id", requestId)
      .order("revision", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (requestResult.error) {
    throw new Error(`Could not read request: ${requestResult.error.message}`);
  }
  if (!requestResult.data) return null;
  if (linesResult.error) {
    throw new Error(`Could not read request lines: ${linesResult.error.message}`);
  }
  if (attachmentsResult.error) {
    throw new Error(`Could not read attachments: ${attachmentsResult.error.message}`);
  }
  if (messagesResult.error) {
    throw new Error(`Could not read messages: ${messagesResult.error.message}`);
  }
  if (childResult.error) {
    throw new Error(`Could not read request revisions: ${childResult.error.message}`);
  }

  const request = requestResult.data;
  const customer = request.customer_id ? await getCustomer(session, request.customer_id) : null;

  return {
    request,
    customer,
    lines: linesResult.data ?? [],
    attachments: attachmentsResult.data ?? [],
    messages: messagesResult.data ?? [],
    childRequestId: childResult.data?.id ?? null,
  };
}

/** Customers for the intake selects, by name. */
export async function listCustomers(session: BrokerSession): Promise<CustomerOption[]> {
  const { data, error } = await session.supabase
    .from("customers")
    .select("id, name, short_name")
    .eq("broker_id", session.brokerId)
    .order("name", { ascending: true });
  if (error) {
    throw new Error(`Could not read customers: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Session plus workspace for one request, memoized for the current server
 * render so a layout and the page inside it do not repeat the queries. Redirects
 * to /login (through requireBroker) when nobody is signed in.
 */
export const loadRequestWorkspace = cache(async (requestId: string): Promise<RequestWorkspace | null> => {
  const session = await requireBroker();
  return getRequestWorkspace(session, requestId);
});

async function getCustomer(session: BrokerSession, customerId: string): Promise<Tables<"customers"> | null> {
  const { data, error } = await session.supabase
    .from("customers")
    .select("*")
    .eq("broker_id", session.brokerId)
    .eq("id", customerId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read customer: ${error.message}`);
  }
  return data;
}

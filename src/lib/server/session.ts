// Who is signed in and which broker they work for.
//
// Phase 1 is one user in one broker, so the first broker_members row wins. The
// membership lookup runs through the RLS client: broker_members is readable by
// its own user, so no admin client is needed here.

import { redirect } from "next/navigation";
import { createClient, type Db } from "@/lib/db/client";

export type BrokerSession = {
  supabase: Db;
  userId: string;
  brokerId: string;
  email: string | null;
};

/**
 * Returns the session for the signed-in user, or null when nobody is signed in.
 * Throws when the user exists but has no broker membership (the seed script
 * creates it).
 */
export async function getBrokerOrNull(): Promise<BrokerSession | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership, error } = await supabase
    .from("broker_members")
    .select("broker_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read broker membership: ${error.message}`);
  }
  if (!membership) {
    throw new Error("User has no broker membership. Run npm run seed.");
  }

  return {
    supabase,
    userId: user.id,
    brokerId: membership.broker_id,
    email: user.email ?? null,
  };
}

/**
 * Same as getBrokerOrNull but redirects to /login when nobody is signed in.
 * Call this at the top of every page, layout, and server action inside (app).
 */
export async function requireBroker(): Promise<BrokerSession> {
  const session = await getBrokerOrNull();
  if (!session) redirect("/login");
  return session;
}

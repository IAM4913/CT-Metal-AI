// Supabase clients for server code.
//
// createClient(): per-request client bound to the caller's auth cookies. Every
// query runs under row level security as the signed-in user. Use it from
// server components, server actions, and route handlers.
//
// createAdminClient(): built with SUPABASE_SECRET_KEY, so it BYPASSES RLS. It is
// called only from src/lib/server/** and scripts/ (seed, fixture recording) and
// must never be imported by a client component or anything a client component
// imports. Do not add "server-only" here: scripts run outside Next and cannot
// load it. The import boundary is enforced by convention and review.

import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { supabasePublishableKey, supabaseSecretKey, supabaseUrl } from "@/lib/env";
import type { Database } from "./types";

export type Db = SupabaseClient<Database>;

// Re-exported so callers can type rows without reaching into the generated file.
export type { Database, Enums, Tables, TablesInsert, TablesUpdate } from "./types";

/**
 * RLS client for the current request. Reads the session from the request
 * cookies and writes refreshed tokens back when the caller can set cookies
 * (server actions, route handlers). Server components cannot set cookies, so
 * setAll swallows that error; the proxy (src/proxy.ts) keeps the session fresh.
 */
export async function createClient(): Promise<Db> {
  const cookieStore = await cookies();
  return createServerClient<Database>(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a server component, where cookies are read-only. Safe to
          // ignore because the proxy refreshes the session on every request.
        }
      },
    },
  });
}

/**
 * Admin client. Bypasses RLS. No session is persisted or refreshed because the
 * secret key is a static credential, not a user login.
 */
export function createAdminClient(): Db {
  return createSupabaseClient<Database>(supabaseUrl(), supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

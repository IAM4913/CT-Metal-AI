// Next.js 16 proxy (the file convention formerly called middleware).
//
// Two jobs on every matched request:
//   1. Refresh the Supabase session cookie so server components, which cannot
//      write cookies, always see a valid token.
//   2. Optimistic auth gate: no user and not on /login (or /auth/*) redirects to
//      /login; a signed-in user on /login goes to /.
//
// The real authorization check is RLS plus requireBroker() in src/lib/server.
// Cookie bridging follows the documented @supabase/ssr pattern: getAll reads
// the request, setAll writes to both the request (so downstream code sees the
// new token) and the response (so the browser stores it). setAll also receives
// the headers that must accompany any auth cookie write (Cache-Control: private,
// no-store, and friends), so a response carrying a fresh token is never cached
// by a CDN or reverse proxy and served to another user. Those headers are kept
// in pendingHeaders and applied to the pass-through response and to redirects.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/db/types";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";

const PUBLIC_PREFIXES = ["/login", "/auth"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Carry any refreshed auth cookies, and the cache headers that must travel with
 * them, from the pass-through response onto a redirect.
 */
function withCookies(
  from: NextResponse,
  to: NextResponse,
  headers: Record<string, string>,
): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
  for (const [name, value] of Object.entries(headers)) {
    to.headers.set(name, value);
  }
  return to;
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  // Headers @supabase/ssr hands to setAll alongside a cookie write; empty until then.
  const pendingHeaders: Record<string, string> = {};

  const supabase = createServerClient<Database>(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        Object.assign(pendingHeaders, headers);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [name, value] of Object.entries(pendingHeaders)) {
          response.headers.set(name, value);
        }
      },
    },
  });

  // Must run before any redirect decision so a token refresh is written back.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return withCookies(response, NextResponse.redirect(url), pendingHeaders);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return withCookies(response, NextResponse.redirect(url), pendingHeaders);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals, the favicon, and static image files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

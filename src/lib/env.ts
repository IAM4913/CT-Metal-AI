// Typed accessors for the environment variables the app needs at runtime.
//
// Each accessor reads process.env on every call and throws a clear error that
// names the missing variable. There are no defaults for URLs or keys: a missing
// value should fail loudly, not quietly point at the wrong project.
//
// This module has no imports on purpose so scripts/ (run with tsx) and the
// Next.js proxy can load it without pulling in Zod or Next internals.

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.local.example to .env.local and fill it in (see SETUP.md).`,
    );
  }
  return value;
}

/** Supabase project URL, for example http://127.0.0.1:54321 or https://<ref>.supabase.co. */
export function supabaseUrl(): string {
  return required("NEXT_PUBLIC_SUPABASE_URL");
}

/** Publishable key: safe for the browser, every query goes through RLS. */
export function supabasePublishableKey(): string {
  return required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
}

/** Secret key: bypasses RLS. Server-side only (src/lib/server/** and scripts/). */
export function supabaseSecretKey(): string {
  return required("SUPABASE_SECRET_KEY");
}

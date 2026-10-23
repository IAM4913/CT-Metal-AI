# SESSION_NOTES

Build session for Anvil Phase 1. Kept current after every PLAN.md step. Sections: What works, Deviations, Stubs and known gaps, Needs a live database, Phase 2 first tasks, Stop point summaries.

## Environment for this session

- Unattended session. Stop points are written here and the build continues.
- Docker is not available in this container (CLI present, no daemon). Per the session instructions, no install attempt and no hosted project. Building in offline mode.
- PostgreSQL 16 with `pg_trgm` is installed locally (no Supabase stack). A throwaway cluster on port 54329 with a shim `auth` schema (`auth.users`, `auth.uid()`, roles `anon`, `authenticated`, `service_role`) is used to apply the migrations from scratch and exercise RLS. This is a verification aid only; nothing in the repo depends on it.
- `ANTHROPIC_API_KEY` is not set. Extraction code is written fully against the SDK. Tests run from hand-authored recordings under `fixtures/recorded/`. Live extraction is unverified until `npm run record-fixtures` is run with a key (see SETUP.md).
- Env names used everywhere: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (the current Supabase key names; the three docs were updated to match).

## What works

- Step 0: Next.js 16.4 (App Router, TypeScript strict, Tailwind 4, ESLint 9 flat config), Vitest 5 with the `@` alias, `supabase init` config, folder layout per CLAUDE.md. `npm test`, `npm run build`, `npm run lint` clean.

## Deviations

- `next.config.ts` sets `cacheComponents: false`. The create-next-app default enables Cache Components, which turns every request-time cookie or database read outside a Suspense boundary into a build error. Every page in this app is request-bound, so the previous fully dynamic model is the simplest correct fit. Not a PRD deviation; recorded because it changes a scaffold default.
- Google fonts removed from the root layout. `next/font/google` downloads at build time and this container's network policy may block it; system fonts keep `npm run build` offline.
- Dependencies added beyond the PLAN Step 0 list: `pdfkit` and `@types/pdfkit` (dev only, generate the fixture PDFs, PLAN Step 2 allows a PDF lib for fixture generation), `pdf-parse` (runtime, PDF text for reply ingestion, PLAN Step 6 names it), `@types/mailparser` (types for `mailparser`). `@types/node` bumped to 22 to satisfy Vitest 5's peer range (Node here is 22).
- `supabase/config.toml` declares Postgres 17 (CLI default). Local verification ran on Postgres 16. The SQL used is common to both.

## Stubs and known gaps

(filled in as steps complete)

## Needs a live database

Verifications skipped because no Supabase stack could run in this session. Each maps to a PLAN.md "done when" item.

- Step 0: `supabase status` showing a running local stack.

## Phase 2 first tasks

(filled in at Step 9)

## Stop point summaries

(written at stop points 1, 2, 3)

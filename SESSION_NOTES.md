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
- Step 1: `supabase/migrations/0001_init.sql` (22 tables, 17 Postgres enums, `set_updated_at` triggers, composite tenant foreign keys, RLS enabled and forced everywhere, 80+ policies, `is_broker_member()` helper) and `0002_search.sql` (`pg_trgm` in schema `extensions`, five GIN trigram indexes). Applied from scratch on the local Postgres 16 cluster through `scripts/local-pg/apply.sh`; `scripts/rls-proof.sql` passes (member sees own rows, outsider sees none, cross-tenant insert fails, anon sees nothing, shared catalog readable, learned aliases tenant-scoped, activity_log append-only). `src/lib/db/types.ts` is real generated output (`supabase gen types typescript --db-url ...` works without Docker). `src/lib/db/enums.ts` derives Zod enums from the generated `Constants`. `src/lib/db/client.ts` (RLS `createClient()`, admin `createAdminClient()`), `src/lib/env.ts`, `src/lib/server/session.ts` (`requireBroker()`, `getBrokerOrNull()`), `src/proxy.ts` (Next 16 proxy, session refresh, redirect to `/login`), `/login` page with `signIn` and `signOut` server actions, `(app)` layout with nav.

## Deviations

- `next.config.ts` sets `cacheComponents: false`. The create-next-app default enables Cache Components, which turns every request-time cookie or database read outside a Suspense boundary into a build error. Every page in this app is request-bound, so the previous fully dynamic model is the simplest correct fit. Not a PRD deviation; recorded because it changes a scaffold default.
- Google fonts removed from the root layout. `next/font/google` downloads at build time and this container's network policy may block it; system fonts keep `npm run build` offline.
- Dependencies added beyond the PLAN Step 0 list: `pdfkit` and `@types/pdfkit` (dev only, generate the fixture PDFs, PLAN Step 2 allows a PDF lib for fixture generation), `pdf-parse` (runtime, PDF text for reply ingestion, PLAN Step 6 names it), `@types/mailparser` (types for `mailparser`). `@types/node` bumped to 22 to satisfy Vitest 5's peer range (Node here is 22).
- `supabase/config.toml` declares Postgres 17 (CLI default). Local verification ran on Postgres 16. The SQL used is common to both.
- `catalog_items` has no `broker_id` (PRD section 7 as written). PRD principle 5 says every business table carries `broker_id`, but section 7 lists `catalog_items` without one and puts the optional `broker_id` on `catalog_aliases` only, so the item master is read as shared reference data (an HSS 8x8x5/8 is the same for every broker) and broker-specific knowledge lives in learned aliases. Policies: every authenticated user can read the catalog and, per AC-4.4, insert, update, and delete items; `anon` sees nothing. `designation` stays globally unique. Per-broker private items are a Phase 5 question, not a Phase 1 column.
- Parent/child tenant consistency is a constraint, not a convention. Every parent business table carries `unique (id, broker_id)` and every child foreign key is composite, for example `foreign key (request_id, broker_id) references requests (id, broker_id)`. PRD section 7 names only the single-column references. Reason: a plain `with check (is_broker_member(broker_id))` validates the new row's own `broker_id` but not the parent it points at, so a member of broker B who learned a broker A uuid (request ids appear in URLs, idempotency keys, and mail threading) could attach rows to A's parents, probe which A ids exist via foreign key error text, and block A's deletes with rows A cannot see. The composite keys close all four. `catalog_item_id` references stay single-column because the catalog is shared.
- `activity_log` is append-only for app users. Only select and insert policies exist, `update`, `delete`, and `truncate` are revoked from `anon` and `authenticated`, and the table has no `updated_at` trigger (the column stays for the shared column convention and always equals `created_at`). The admin client (`service_role`) keeps full access. PRD section 7 does not say either way; the PRD relies on this table as the traceability record for every edit and every LLM call, so a tenant member must not be able to rewrite or erase it. `scripts/rls-proof.sql` asserts it.
- Vitest config is `vitest.config.mts`, not the `vitest.config.ts` named in PLAN Step 0. `package.json` has no `"type": "module"`, so a `.ts` config is loaded as CommonJS and every `npm test` printed a Vite warning that the native config loader (the future default) will not support that; `__dirname` would also be undefined there. The `.mts` file uses `import.meta.url` for the `@` alias.
- `.env.local.example` is committed (`!.env.local.example` after `.env*` in `.gitignore`). The create-next-app default ignored it, so a fresh clone had no template even though SETUP.md, README.md, and the `src/lib/env.ts` error message tell you to copy it. It holds placeholders only.

## Stubs and known gaps

(filled in as steps complete)

## Needs a live database

Verifications skipped because no Supabase stack could run in this session. Each maps to a PLAN.md "done when" item.

- Step 0: `supabase status` showing a running local stack.
- Step 1: `supabase db reset` against the real Supabase image (Postgres 17 with the real `auth` schema and default grants). The migrations were applied on plain Postgres 16 with `scripts/local-pg/auth-shim.sql` standing in for `auth.users`, `auth.uid()`, and the three roles. Differences that could surface: Supabase's own grants on `public`, the `extensions` schema already existing (the migration uses `create extension if not exists ... with schema extensions`, which is fine either way).
- Step 1: `supabase gen types typescript --local` was replaced by `--db-url` against the local cluster. Re-run `--linked` tomorrow (SETUP.md); the output should be identical apart from formatting.
- Step 1: the login page, proxy redirect, and `requireBroker()` have only been type-checked and built, not exercised against a running Auth server.

## Phase 2 first tasks

(filled in at Step 9)

## Stop point summaries

### Stop point 1 (after Step 1)

What works: the schema applies clean from zero and the RLS proof passes on a real Postgres; types are generated, not hand-typed; auth plumbing builds. `npm test`, `npm run build`, `npm run lint`, `tsc --noEmit` are all clean.

Schema decisions: Postgres enums (not check constraints) so the generated `Constants` drive the TypeScript and Zod enums from one source. Every child table carries `broker_id` and a composite foreign key `(parent_id, broker_id)` so a row can never point at another tenant's parent. `catalog_items` is shared reference data without `broker_id` (PRD section 7 literal); learned aliases carry `broker_id`. `activity_log` is append-only for app users. Free-form text columns the PRD lists as required default to `''`; `source_span`, `dims`, and `payload` default to `{}`. `messages."references"` keeps the PRD name (quoted in SQL). Extra unique constraints exist where seed and learned-alias writes need `on conflict` (see Deviations).

Risky: nothing has touched a real Supabase Auth or Storage service yet, so the first `supabase db push` plus `npm run seed` tomorrow is the real test of the plumbing. The proxy's cookie bridging follows the documented `@supabase/ssr` pattern but is unexercised. Forced tool use is not available on `claude-sonnet-5-5`; Step 4 will use structured outputs instead (recorded there).

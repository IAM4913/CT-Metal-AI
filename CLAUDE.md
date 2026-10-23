# CLAUDE.md

Project: Anvil (working name). A back office for independent steel brokers. Phase 1 is a single-user demo. See PRD.md for requirements and PLAN.md for the build order.

## Non-negotiables

- Greenfield. Do not copy or adapt code, prompts, schemas, or fixtures from any other repository on this machine.
- No em dashes anywhere: code comments, UI strings, email templates, docs, commit messages. Use commas, colons, or parentheses.
- AI extracts, code computes. Any arithmetic, unit conversion, matching, or ranking lives in a pure TypeScript function with a Vitest test. The LLM never produces a number that is then used without normalization.
- Nothing is sent or purchased without an explicit user action in the UI.
- Every business table has `broker_id`. RLS is on. The admin client (built with `SUPABASE_SECRET_KEY`, the secret key that replaced the service-role key) is imported only in `src/lib/server/**` and never reaches a client component.
- Missing data is null plus a flag. Never default a grade, quantity, length, price, or freight to a value.

## Stack

Next.js App Router, TypeScript strict, Tailwind, Supabase (Postgres, Auth, Storage) via `@supabase/ssr` and `@supabase/supabase-js`, Anthropic SDK with forced tool use for extraction, Zod at every boundary, TanStack Table for grids, `mailparser` for `.eml`, Vitest for tests. No ORM. Schema is SQL migrations under `supabase/migrations/`, types generated with `supabase gen types`.

## Layout

```
src/
  app/                    routes (App Router), server actions colocated in actions.ts files
  components/             shared UI
  lib/
    db/                   client.ts (server + admin clients), types.ts (generated)
    catalog/              generate.ts, normalize.ts, match.ts
    parsing/              schema.ts, prompt.ts, extract.ts, normalize.ts, offers.ts
    routing/              match.ts (vendor matching)
    rfq/                  draft.ts, templates.ts
    mail/                 adapter.ts, noop.ts, eml.ts
    compare/              cost.ts, build.ts
    server/               anything that uses the service-role client
supabase/
  migrations/
scripts/                  seed.ts, record-fixtures.ts, make-fixture-pdfs.ts
fixtures/                 requests/, replies/, recorded/
```

## Conventions

- Server actions validate input with Zod, call a pure `lib` function, then write through the RLS client. Keep actions thin.
- Enums: define once in SQL, mirror once in `src/lib/db/enums.ts`, import everywhere else.
- Fractions and mixed numbers are parsed by `parseFraction()` in `src/lib/catalog/normalize.ts`. Do not reimplement.
- Every LLM call goes through `callExtractionTool()` in `src/lib/parsing/extract.ts`, which logs to `activity_log` and validates with Zod. No direct SDK calls elsewhere.
- Tests for `lib/**` are colocated as `*.test.ts`. Fixture-driven parser tests use recorded model outputs from `fixtures/recorded/` so `npm test` runs offline.
- Commit after each PLAN.md step with the given message. Keep `SESSION_NOTES.md` current: What works, Deviations, Stubs and known gaps, Phase 2 first tasks.
- Plain UI. No component library beyond Tailwind and TanStack Table. Readability over polish.
- Email body templates read like a busy broker wrote them: short lines, no pleasantries beyond one, item list, "let me know what you can do."

## Commands

```
npm run dev            # next dev
npm test               # vitest
npm run seed           # tsx scripts/seed.ts
npm run record-fixtures  # refresh recorded LLM outputs (hits the API)
supabase start | status | db reset
supabase gen types typescript --local > src/lib/db/types.ts
```

## Out of scope for this phase

Real email sending or polling, background jobs, QuickBooks, customer portal, multi-user admin, web scraping, freight lookups, any marketplace feature. If a task seems to need one of these, stub the smallest interface and note it in SESSION_NOTES.md.

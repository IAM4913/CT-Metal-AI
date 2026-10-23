# PLAN: Anvil Phase 1 build session

Companion to PRD.md. This is the execution order for one extended Claude Code session. Follow it top to bottom. Each step ends with a "done when" check and a commit.

## Session objective

Ship the Phase 1 demo defined in PRD §18 on a fresh Next.js + Supabase repo, with fixtures and tests, deployable to Vercel. No real email. No background jobs. Single seeded user.

## Session rules

1. Read CLAUDE.md, PRD.md, and this file completely before writing code.
2. Work in this order. Do not skip ahead to a later step to "set it up early."
3. Commit at the end of every step with the message given. Small commits in between are fine.
4. **Stop points:** after Step 1, Step 4, and Step 7, stop and write a short summary (what works, what deviated from the PRD and why, what is risky). Then continue only after a reply, or if the session is unattended, continue and leave the summary in `SESSION_NOTES.md`.
5. If a step is taking far longer than it should, do not improvise a different architecture. Note the blocker in `SESSION_NOTES.md`, stub the smallest thing that unblocks the next step, and move on.
6. Deviations from PRD §7 (schema) or §11 (tech decisions) require a note in `SESSION_NOTES.md` under "Deviations" with the reason.
7. No new dependencies beyond the list in Step 0 without noting why in `SESSION_NOTES.md`.
8. Never copy code from any other repository on this machine. Greenfield only.
9. The user has a standing rule: no em dashes in any written output, including UI copy, templates, and docs.

## Time budget and cut line

Rough order of effort: Steps 0 to 2 are plumbing and should be fast. Steps 3 to 5 are the heart of the demo. Steps 6 and 7 are the second half of the value. Step 8 is polish. Step 9 is required.

If time runs short, cut from the bottom in this order:
1. Step 8 (work queue and history search) → replace with a plain list of requests and a basic history table.
2. Step 6 PDF reply ingestion → paste and `.eml` only.
3. Step 6 LLM offer-line extraction → manual offer entry form only, keep the comparison screen.

Do not cut: schema with RLS, request parsing with spans, review screen, vendor matching, per-vendor RFQ drafts with isolation test, idempotent no-op send, comparison screen with manual offers, confirm purchase, tests.

---

## Step 0: Scaffold

- `npx create-next-app@latest anvil --typescript --tailwind --app --src-dir --eslint`
- Add dependencies: `@supabase/supabase-js`, `@supabase/ssr`, `@anthropic-ai/sdk`, `zod`, `mailparser`, `@tanstack/react-table`, `date-fns`. Dev: `vitest`, `@vitejs/plugin-react`, `supabase` (CLI), `tsx`.
- `supabase init`, `supabase start` (local stack). If Docker is unavailable, point at a hosted Supabase project instead and note it.
- `.env.local.example` with: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `PARSE_MODEL=claude-sonnet-5-5`, `MAIL_ADAPTER=noop`, `SEED_USER_EMAIL`, `SEED_USER_PASSWORD`.
- Folder layout per CLAUDE.md.
- `vitest.config.ts`, one passing smoke test.
- `README.md` with local run instructions (3 commands max).

**Done when:** `npm run dev` serves a page, `npm test` passes, `supabase status` shows a running local stack.
**Commit:** `chore: scaffold next + supabase + vitest`

## Step 1: Schema, RLS, types

- Write `supabase/migrations/0001_init.sql` implementing PRD §7 exactly: tables, enums (as Postgres enums or check constraints, pick one and stay consistent), foreign keys, indexes, `updated_at` triggers.
- RLS on every table with `broker_id`. Policy: `broker_id in (select broker_id from broker_members where user_id = auth.uid())`. `catalog_items` and seed `catalog_aliases` (`broker_id is null`) are readable by all authenticated users; learned aliases carry `broker_id`.
- `supabase/migrations/0002_search.sql`: `pg_trgm` extension and trigram indexes on `request_lines.raw_text`, `request_lines.description`, `catalog_aliases.alias`, `purchases` search columns.
- `supabase gen types typescript --local > src/lib/db/types.ts`.
- `src/lib/db/client.ts`: server client (cookies, RLS) and admin client (secret key, formerly called service role; server-only, never imported by client components).
- Auth: Supabase email/password. One login page. Middleware that redirects unauthenticated routes to `/login`.

**Done when:** migrations apply clean from scratch (`supabase db reset`), types generate, and a tiny script proves a user in `broker_members` can read their broker's rows and a user outside cannot.
**Commit:** `feat(db): initial schema with RLS and search indexes`
**STOP POINT 1.** Summarize schema decisions and any deviations.

## Step 2: Seed data and fixtures

- `scripts/seed.ts` (run with `tsx`): creates one broker, one user (`SEED_USER_EMAIL`), membership, example vendors/branches/contacts/capabilities/terms from PRD §14, and the catalog.
- Catalog generator `src/lib/catalog/generate.ts`: produces items and rule-based aliases for the categories in PRD AC-4.1. Keep size lists modest (the common sizes a Texas broker sees). Hand-add aliases needed by the fixtures.
- `src/lib/catalog/normalize.ts`: alias normalization function (lowercase, collapse whitespace, strip punctuation, canonicalize `"`/`in`/`inch`, `#`/`lb`, `sq`/`square`, `tube`/`hss`). Unit tests.
- `fixtures/requests/` and `fixtures/replies/` per PRD §15. Write real `.eml` files with headers; generate the PDF fixtures with a small script (any PDF lib is fine for fixture generation only; do not add it to runtime deps).

**Done when:** `npm run seed` populates a reset database; alias tests pass for every example in PRD AC-4.3; fixtures exist.
**Commit:** `feat(seed): catalog, example vendors, fixtures`

## Step 3: Intake

- `/requests/new`: paste box (customer optional, subject optional), `.eml` upload, manual lines form.
- `src/lib/mail/eml.ts`: parse with `mailparser`, return headers, text body (prefer text, fall back to html → text), attachments. Store attachments to Storage bucket `attachments` with the path rule in PRD §11; store the raw `.eml` itself as an attachment too.
- Create the `requests` row with `source_type`, `source_text`, `received_at`, `status = new`.
- `/requests/[id]`: shell page with tabs; Review tab shows source text and attachments list.

**Done when:** uploading `mixed-list.eml` creates a request with the body text, the signature, and the quoted thread visible in the source pane, and the raw `.eml` in Storage.
**Commit:** `feat(intake): paste, eml upload, manual entry, attachments`

## Step 4: Parsing and review

- `src/lib/parsing/schema.ts`: Zod schemas for `extract_material_lines` tool output (PRD §13A).
- `src/lib/parsing/prompt.ts`: system prompt with shop-language examples.
- `src/lib/parsing/extract.ts`: Anthropic Messages call with forced tool use, model from `PARSE_MODEL`, returns validated output. Log the call to `activity_log`.
- `src/lib/parsing/normalize.ts`: deterministic pass: fraction parsing, unit canonicalization, length parsing (`40'`, `40 ft`, `40-0`, `480"`), alias lookup → `catalog_item_id`, category inference from the matched item, flag computation. Unit tests for every conversion.
- Server action `parseRequest(requestId)`: runs extract + normalize, writes `request_lines` with spans, sets `status = needs_review`.
- Review tab: TanStack grid of lines beside the source; selecting a line highlights its span; inline edit every field; add, remove, merge; "link to item" picker that also saves a learned alias; "confirm request" button gated by AC-3.3.
- Activity log entries for edits with before/after.
- Fixture tests: for each request fixture, assert line count and flags (mock the Anthropic call with recorded outputs stored under `fixtures/recorded/` so tests run offline; add an `npm run record-fixtures` script that hits the real API to refresh them).

**Done when:** all five request fixtures parse to the expected line counts and flags from recorded outputs; the review grid works end to end; `confirm` is blocked until lines are complete.
**Commit:** `feat(parse): LLM extraction, deterministic normalization, review grid`
**STOP POINT 2.** Summarize parser accuracy on the fixtures and anything the prompt struggled with.

## Step 5: Vendor matching and RFQ drafts

- `src/lib/routing/match.ts`: deterministic ranking per PRD AC-6.1. Unit tests.
- Route tab: per-line suggested branches with add/remove; consolidated recipient list for the request; override at either level.
- `src/lib/rfq/draft.ts`: build one draft per branch with only its lines; subject and body template in Caleb's voice (short, direct, plain text; no AI tone; customer name only when toggled). Unit test: **recipient isolation**, no draft ever contains another branch's contact.
- `src/lib/mail/adapter.ts`: `MailAdapter` interface; `src/lib/mail/noop.ts`: `NoopMailAdapter` that writes to `messages` and returns a fake provider id.
- Server action `sendAll(requestId)`: for each draft, compute `idempotency_key`, skip if an `rfqs` row with that key is already `sent`, otherwise send via adapter, update status, record errors per RFQ. Unit test: calling twice produces one send.
- RFQs tab: draft previews, per-draft edit (to, cc, body, include-customer toggle), "send all", per-RFQ status and retry.
- Post-send edit guard: editing lines on a request with any `sent` RFQ creates a new revision (`parent_request_id`) and copies lines; old RFQs stay on the old revision.

**Done when:** `mixed-list` routes to at least three branches, drafts preview correctly, isolation and idempotency tests pass, "send all" records messages.
**Commit:** `feat(rfq): vendor matching, per-vendor drafts, idempotent no-op send`

## Step 6: Response ingestion

- Offers tab: "add reply" with three modes: paste text, upload `.eml`, upload PDF; and "enter phone/text quote" form with the offer and offer-line fields.
- Auto-match: if the uploaded `.eml` has `In-Reply-To` or `References` matching a `messages.provider_message_id` for this request, attach to that RFQ; otherwise show a picker limited to this request's open RFQs.
- `src/lib/parsing/offers.ts`: `extract_offer_lines` (PRD §13B) with the RFQ's lines passed as context so the model references `request_line_id`s; same normalization and logging pattern as Step 4; PDF text via `pdf-parse` or similar (one dependency, note it).
- Offer review: same grid pattern as Step 4 for offer lines; status `declined` when the reply declines.
- Fixture tests with recorded outputs for replies 1, 2, 3, 5.

**Done when:** all four text/eml reply fixtures ingest against the right RFQ and produce reviewed offer lines; a manual phone quote can be entered.
**Commit:** `feat(offers): reply ingestion, offer extraction, manual quotes`

## Step 7: Comparison, selection, purchase

- `src/lib/compare/cost.ts`: extended cost per PRD §8 math, returns `{ value } | { reason }`. Unit tests for every basis and for the "not comparable" paths.
- `src/lib/compare/build.ts`: assemble the per-line comparison model: offers side by side, exact vs alternate with changed attributes, unfilled balance, unknowns, early-pay scenario row.
- Compare tab: grid per request line, default sort by vendor name, sortable by price/ready date/availability; alternate selection requires a confirm dialog naming the difference; split-quantity control; running "selected vs requested" per line with over-selection warning.
- `confirmPurchase(requestId)`: explicit button; creates one `purchases` row per branch from current selections, `purchase_lines`, sets `status = sourced`, logs activity.

**Done when:** the comparison for `mixed-list` shows the alternate wall, the partial qty, unknown freight, early-pay scenario, and rolling date; a split selection and purchase confirm work; cost tests pass.
**Commit:** `feat(compare): side-by-side offers, selections, confirm purchase`
**STOP POINT 3.** Summarize what the demo can do end to end and what is stubbed.

## Step 8: Work queue and history

- `/`: requests grouped by status with counts; awaiting-responses shows received/sent and days since send.
- `/history`: search by customer, vendor, category, designation, date range, free text (trigram); results link to request, RFQ, and the originating message.
- `/vendors` and `/items` CRUD pages (plain forms are fine).

**Done when:** searching `C12x30` returns the purchase and opens the reply; queue counts match the data.
**Commit:** `feat(ui): work queue, history search, vendor and item admin`

## Step 9: Verification and demo prep

- Run PRD §18 top to bottom on a reset + seeded database. Record pass/fail per item in `SESSION_NOTES.md`.
- `npm test` green. `npm run build` clean. `npm run lint` clean.
- `DEMO.md`: the click path for showing Caleb, 10 steps, using the fixtures, ending on the history search.
- Deploy: `vercel` with env vars set against a hosted Supabase project (create one if only local was used; run migrations and seed against it). Preview URL in `SESSION_NOTES.md`.
- Final `SESSION_NOTES.md` sections: What works, Deviations, Stubs and known gaps, Phase 2 first tasks.

**Commit:** `chore: demo script, session notes, deploy`

---

## Kickoff prompt (paste into Claude Code)

```
Read CLAUDE.md, PRD.md, and PLAN.md in full. Then execute PLAN.md from Step 0 through Step 9 in order. Obey the session rules, especially the stop points, the commit messages, and the no-em-dash rule. Keep SESSION_NOTES.md current as you go. Do not start any Phase 2 item. If something in the PRD is ambiguous, choose the simplest interpretation that satisfies the acceptance criteria and note it under Deviations.
```

## Before the demo is shown to Caleb (not a build task)

Send Caleb a one-page terms note first: design partner (reduced rate, Forgentics keeps IP, he provides data and intros) or partnership (network and financing from him, build from you, split in writing). Settle the mailbox question on the same call. The demo gets better reception when the relationship is already defined.

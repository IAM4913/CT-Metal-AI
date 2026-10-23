# PRD: Anvil (working name), a back office for independent steel brokers

Version 0.1, 2026-10-23. Owner: Michael Pierce, Forgentics LLC.
First user and design partner: Caleb, solo steel broker, ~$12M revenue, Texas.

This document is written for a Claude Code build session. It is a strawman: every decision below is made so the build can start. Decisions marked OPEN do not block the first phase.

---

## 1. Summary

Caleb turns customer material requests into vendor RFQs by hand: read the email, figure out which of ~15 vendor reps sell what, write a separate email to each, chase replies, and compare the responses in his head. Then he re-types everything into QuickBooks. He has no purchase history he can search.

Anvil automates the back office around that workflow. AI reads and organizes. Caleb decides what gets sent and what gets bought. Nothing in the product is customer-facing in the first two phases.

The core chain:

**Customer request → reviewed material lines → targeted vendor RFQs → consolidated offers → sourcing decision → purchase history**

Success target for the pilot: save Caleb roughly one hour per day.

## 2. Problem decomposition

| Job | What Caleb does today | What hurts |
|---|---|---|
| Intake | Reads a customer email or text, sometimes a PDF list | Lists are messy, mixed units, shop slang, missing grades |
| Route | Decides which vendor branches might have each item | Knowledge lives in his head; 32 calls in one day on a bad day |
| Send | Writes one email per vendor, by hand | Pure clerical time; mistakes when a line goes to the wrong rep |
| Collect | Replies trickle in by email, phone, text, PDF | No single view; easy to lose a reply in a thread |
| Compare | In stock? Alternate length? Price? Early-pay discount? | Done mentally, line by line, across 5 to 10 vendors |
| Decide | Picks a vendor per line, sometimes splits a quantity | No record of why |
| Remember | Who sold me 12" channel last time, at what? | Nothing. Mill portals only, and only for mill buys |
| Account | Types invoices and quotes into QuickBooks | Books are a year behind (out of scope until Phase 3) |

Phase 1 and 2 attack Intake through Remember. Account is Phase 3.

## 3. Users and roles

| Role | Phase | Access |
|---|---|---|
| Broker (Caleb) | 1 | Everything inside his broker tenant |
| Admin/accounting support | 3 | Orders, documents, accounting exceptions |
| Customer | 4 | Their own requests, saved parts and prints, order history. Never sees vendor cost or margin |
| Additional brokers | 5 | Their own book inside a shared network tenant; central financing visibility |

Phase 1 is single-user. Build auth and tenancy correctly anyway (see Principles).

## 4. Principles (non-negotiable)

1. **AI reads, Caleb decides.** Every automated extraction is reviewable before it affects anything. Nothing is sent or purchased without an explicit action.
2. **Not customer-facing.** No AI talks to Caleb's customers or vendors in Phases 1 and 2. RFQs read as if Caleb wrote them.
3. **Send as Caleb.** Vendors reply to the person they know. Outbound mail must come from Caleb's real address when real sending ships (Phase 2). The demo does not send.
4. **Traceable.** Every extracted value keeps a pointer to the source text or attachment it came from.
5. **Tenant from day one.** Every business table carries `broker_id`. Row-level security is on from the first migration. Phase 5 (broker network) is a configuration change, not a migration.
6. **LLM extracts, code computes.** The model identifies and labels. Unit conversion, weight math, extended prices, and matching rules are deterministic code with tests.
7. **Clean room.** This is a greenfield Forgentics repo. No code, prompts, schemas, or fixtures are copied from any Willbanks or Pantheon repository.

## 5. Phases and scope

| Phase | Name | Scope | Status |
|---|---|---|---|
| 1 | Demo | Import a real request, parse lines, review and correct, match vendors, preview per-vendor RFQs, "send" to a no-op adapter, ingest pasted or uploaded replies, compare offers, record selections and a confirmed purchase, search history. Single user. | **This build** |
| 2 | Pilot | Real email send and receive through Caleb's mailbox, exception handling, duplicate protection in production, phone/text offer entry polish, revision workflow, Caleb using it daily | Next |
| 3 | AP/AR | Link confirmed purchases and customer sales to QuickBooks, document association, reconciliation exceptions | Later |
| 4 | Customer portal | Optional request submission, saved parts and prints, repeat ordering, order history, reorder reminders | Later |
| 5 | Broker network | Separate broker books, transaction ownership, central financing visibility, configurable margin splits, settlement tracking | Later |

### Explicitly out of scope for Phase 1
- Real email sending or mailbox polling
- Multi-user auth flows (one seeded broker, one seeded user)
- QuickBooks or any accounting integration
- Customer portal, customer logins
- Web scraping of vendor e-commerce sites
- Freight rate lookups
- Background job infrastructure (Inngest is Phase 2; Phase 1 parsing runs synchronously in server actions)
- Any marketplace, listing, or cross-broker feature

## 6. Functional requirements

Each FR has acceptance criteria (AC). Phase 1 must meet every AC marked P1.

### FR-1 Request intake
- P1 AC-1.1: Accept a pasted material list (plain text) with optional customer name and subject.
- P1 AC-1.2: Accept an uploaded `.eml` file. Parse headers (from, to, subject, date, message-id), body text, and attachments. Store attachments in Supabase Storage under the request.
- P1 AC-1.3: Accept manual entry of lines through a form.
- P1 AC-1.4: Original text and attachments are preserved unchanged and viewable beside the parsed result.
- P2 AC-1.5: Connect a mailbox (provider OPEN, see §12) so new customer emails create requests automatically.

### FR-2 Material parsing
- P1 AC-2.1: Produce one `request_line` per distinct item in the source, with: product type, dimensions, grade/spec, quantity, unit, length, cut-to-length flag, delivery notes, and a source span (character offsets into the source text, or attachment id + page).
- P1 AC-2.2: Each line carries a confidence (0 to 1) and zero or more flags from: `missing_grade`, `missing_qty`, `missing_length`, `ambiguous_size`, `ambiguous_unit`, `unmatched_item`, `possible_duplicate`, `alternate_mentioned`.
- P1 AC-2.3: A line whose description resolves to a catalog item (directly or via alias) is linked to that `catalog_item_id`. Custom, fabricated, and one-off items remain unlinked with `unmatched_item` and are still routable.
- P1 AC-2.4: Parsing a fixture (see §15) produces the expected line count and the expected flags. Covered by tests.
- P1 AC-2.5: The parser never invents a grade, quantity, or length. Missing means flagged, not filled.

### FR-3 Review and correction
- P1 AC-3.1: Review screen shows parsed lines in a grid beside the source text, with the source span highlighted on hover/select.
- P1 AC-3.2: Caleb can edit any field, add a line, remove a line, merge two lines, and clear flags.
- P1 AC-3.3: A request cannot move to RFQ drafting until every line has qty, unit, and either a catalog link or an explicit "custom item" confirmation. Grade may stay blank if confirmed.
- P1 AC-3.4: Edits are recorded in the activity log with before/after values.
- P1 AC-3.5: When Caleb links an unmatched description to a catalog item, the description is saved as a learned alias for that item (`source = learned`).

### FR-4 Item master
- P1 AC-4.1: Seeded catalog covering: HSS square, HSS rectangular, HSS round, pipe, W beam, S beam, channel (C and MC), angle (equal and unequal), flat bar, round bar, square bar, plate, sheet, rebar. Common sizes only; completeness is not the goal, alias handling is.
- P1 AC-4.2: Each item has a canonical designation (e.g. `HSS8x8x5/8`, `C12x30`, `L2x2x1/4`, `W12x26`, `PL3/8`), a category, a dims JSON, and weight per foot where applicable.
- P1 AC-4.3: Aliases map shop language to items: `8 square 5/8`, `8x8x5/8 tube`, `8" sq tube 5/8 wall`, `12 inch channel 30#`, `2x2x1/4 angle`, `3/8 plate`. Alias matching is case-insensitive, whitespace- and punctuation-tolerant, and understands `"`, `in`, `inch`, `#`, `lb`, `wall`, `sq`, `square`, `tube`, `HSS`.
- P1 AC-4.4: Caleb can add items and aliases from the UI.

### FR-5 Vendor directory
- P1 AC-5.1: Entities: vendor (company), branch (location), contact (person with email/phone), capability (category a branch sells), terms (payment terms, early-pay discount %, early-pay days, freight default: quoted / arranged by broker / FOB).
- P1 AC-5.2: Seeded with example vendors from the discovery call (see §14). Marked as examples for Caleb to correct.
- P1 AC-5.3: Relationship notes per branch and per contact (free text).
- P1 AC-5.4: Vendor type: mill, service center, broker, other.

### FR-6 Vendor matching
- P1 AC-6.1: For each request line with a category, suggest branches whose capabilities include that category. Rank by: explicit "preferred" flag, then number of past purchases of that category from that branch, then alphabetical.
- P1 AC-6.2: Show suggestions per line and as a consolidated recipient list per request. Caleb can add, remove, or override recipients at either level.
- P1 AC-6.3: A line with no category match shows "no suggested vendors" and still allows manual routing.
- P1 AC-6.4: Matching is deterministic and unit-tested. No LLM in the matching step.

### FR-7 RFQ preparation
- P1 AC-7.1: Generate one RFQ draft per selected branch containing only the lines routed to that branch.
- P1 AC-7.2: Draft includes: to (primary contact), cc (optional), subject (`RFQ: <customer short name or "Material request">, <n> items, <date>`), a plain-text body in Caleb's voice (template, editable), and relevant attachments.
- P1 AC-7.3: Line formatting in the body uses the vendor-facing designation (canonical when linked, raw text when custom), qty, unit, length, grade, and any per-line notes. Customer name is included only if Caleb toggles it on for that RFQ.
- P1 AC-7.4: Caleb can edit the body and recipients of any single draft before sending.
- P1 AC-7.5: Recipient lists are isolated per RFQ. No RFQ ever contains another vendor's address.

### FR-8 RFQ sending
- P1 AC-8.1: "Send all" sends every reviewed draft through the configured `MailAdapter`. Phase 1 ships `NoopMailAdapter`, which records the RFQ as sent with a fake provider message id and writes the full outbound message to the `messages` table.
- P1 AC-8.2: Each RFQ has an idempotency key (`request_id + branch_id + revision`). Sending the same key twice is a no-op that returns the existing result. Covered by a test.
- P1 AC-8.3: Send failures are recorded per RFQ with the error and are retryable individually.
- P1 AC-8.4: Sent RFQs are immutable. Editing a request after any RFQ is sent creates a new request revision (`revision + 1`, `parent_request_id` set) and new drafts.
- P2 AC-8.5: `GraphMailAdapter` (Microsoft 365) or `GmailMailAdapter` sends from Caleb's mailbox. Provider OPEN.

### FR-9 Response collection
- P1 AC-9.1: Ingest a reply by pasting text, uploading an `.eml`, or uploading a PDF, and associate it with an RFQ (auto-match by `in_reply_to` / thread headers when present, otherwise Caleb picks the RFQ from a list filtered to open RFQs for that vendor).
- P1 AC-9.2: Enter a phone or text quote manually against an RFQ with the same offer fields.
- P1 AC-9.3: Each ingested reply becomes a `vendor_offer` with zero or more `offer_lines`, each tied to a `request_line_id`. Offer-line extraction is LLM-assisted and reviewable exactly like request parsing (confidence, flags, source span).
- P1 AC-9.4: A reply that declines or says "don't stock" is recorded as an offer with status `declined` so the work queue stops waiting on it.
- P2 AC-9.5: Mailbox polling auto-attaches replies.

### FR-10 Quote comparison
See §8 for fields and rules.
- P1 AC-10.1: Comparison screen shows, per request line, every offer line from every vendor side by side.
- P1 AC-10.2: Exact vs alternate is visually distinct. Alternates show what changed (grade / dimension / wall / length).
- P1 AC-10.3: Missing price or freight renders as "unknown", never as zero.
- P1 AC-10.4: Extended material cost is computed only when price basis and the needed weight/length data exist. Otherwise "cannot compute" with the reason.
- P1 AC-10.5: Early-pay discount shows as a conditional line ("if paid in 10 days: $X"), not folded into the base price.
- P1 AC-10.6: Caleb can select an offer line per request line, select different vendors for different lines, and split one line's quantity across two or more offers.

### FR-11 Sourcing history
- P1 AC-11.1: "Confirm purchase" turns the current selections for a request into one `purchase` per branch, with a timestamp and optional PO number. Explicit action only.
- P1 AC-11.2: Purchase history is searchable by customer, vendor, category, canonical designation, date range, and free text.
- P1 AC-11.3: From any history row, Caleb can open the original request, the RFQ, and the reply that produced it.

### FR-12 Work queue
- P1 AC-12.1: Home screen lists requests grouped by status: new, needs review, drafts ready, awaiting responses (with count received / sent), ready to compare, sourced.
- P1 AC-12.2: Awaiting responses shows days since send per RFQ.

## 7. Domain model

All business tables: `id uuid pk`, `broker_id uuid not null`, `created_at`, `updated_at`. RLS: a row is visible when `broker_id` is in the caller's `broker_members`.

```
brokers            id, name
broker_members     broker_id, user_id (auth.users), role [owner|admin|member]

customers          broker_id, name, short_name, email_domain, notes
customer_contacts  customer_id, name, email, phone

requests           broker_id, customer_id?, source_type [paste|eml|manual|mailbox],
                   subject, source_text, source_message_id?, received_at,
                   status [new|parsing|needs_review|reviewed|rfqs_drafted|rfqs_sent|
                           collecting|comparing|sourced|closed],
                   revision int default 1, parent_request_id?,
                   delivery_requirements, notes
request_lines      request_id, line_no, raw_text, catalog_item_id?,
                   category?, description, dims jsonb, grade_spec?,
                   qty numeric?, unit [pcs|ft|in|lbs|cwt|tons|sqft]?,
                   length_ft numeric?, length_text?, cut_to_length bool,
                   delivery_notes?, flags text[], confidence numeric,
                   source_span jsonb {kind: text|attachment, start, end, attachment_id?, page?},
                   status [parsed|confirmed|custom|removed]

attachments        broker_id, owner_type, owner_id, storage_path, filename,
                   mime, size_bytes, sha256

catalog_items      category, designation (unique), dims jsonb,
                   weight_per_ft numeric?, default_grade?
catalog_aliases    catalog_item_id, alias (normalized), source [seed|learned], broker_id?

vendors            broker_id, name, vendor_type [mill|service_center|broker|other],
                   website?, notes
vendor_branches    vendor_id, name, city, state, region?, preferred bool,
                   payment_terms?, early_pay_pct?, early_pay_days?,
                   freight_default [quoted|arranged|fob|unknown], notes
vendor_contacts    branch_id, name, email, phone?, is_primary bool, notes
vendor_capabilities branch_id, category, notes?

rfqs               broker_id, request_id, branch_id, revision int,
                   status [draft|queued|sent|failed|responded|declined|closed],
                   to_emails text[], cc_emails text[], subject, body_text,
                   include_customer_name bool, idempotency_key (unique),
                   sent_at?, provider_message_id?, last_error?
rfq_lines          rfq_id, request_line_id, note?

messages           broker_id, direction [in|out], rfq_id?, request_id?,
                   from_email, to_emails text[], cc_emails text[], subject,
                   body_text, body_html?, received_at, provider_message_id?,
                   in_reply_to?, references text[], matched_by [thread|manual|ai|none],
                   raw_attachment_id?

vendor_offers      broker_id, rfq_id, branch_id, message_id?, attachment_id?,
                   source [email|pdf|phone|text|manual],
                   status [parsed|reviewed|declined],
                   received_at, quote_expires_at?, payment_terms?,
                   early_pay_pct?, early_pay_days?,
                   freight_amount?, freight_basis [included|separate|unknown],
                   notes, confidence
offer_lines        offer_id, request_line_id, offered_catalog_item_id?,
                   offered_desc, is_exact_match bool,
                   alternate_types text[] subset of [grade|dimension|wall|length],
                   available_qty?, unit?, availability [stock|rolling|unknown],
                   ready_date?, delivery_estimate_text?,
                   unit_price?, price_basis [per_cwt|per_lb|per_ft|per_pc|per_ton|per_sqft]?,
                   extended_price? (computed, nullable), flags text[],
                   confidence, source_span jsonb

sourcing_selections broker_id, request_line_id, offer_line_id, qty numeric,
                   selected_at, note?
purchases          broker_id, request_id, branch_id, confirmed_at,
                   po_number?, total_material?, total_freight?, notes
purchase_lines     purchase_id, selection_id

activity_log       broker_id, entity_type, entity_id, action, actor_user_id?,
                   payload jsonb, at
```

Indexes: `request_lines(request_id)`, `rfqs(request_id)`, `rfqs(idempotency_key)`, `messages(in_reply_to)`, `messages(provider_message_id)`, `offer_lines(request_line_id)`, `catalog_aliases(alias)`, `purchases(broker_id, confirmed_at desc)`, plus a trigram or tsvector index on `request_lines.raw_text` and `purchases` search fields.

## 8. Quote comparison specification

Each offer line shows:
- Requested item (canonical or raw) and offered item
- Exact match, or alternate with the changed attributes called out
- Available quantity and unfilled balance against requested qty
- Availability: stock, rolling (with date if given), unknown
- Ready-to-ship date and delivery estimate, as separate fields
- Unit price, price basis, extended material cost
- Freight amount and basis
- Payment terms and conditional early-pay savings
- Quote expiration
- Link to the reply text or attachment that produced the values

Rules:
1. Unknown is unknown. Missing freight or price is displayed as unknown and excluded from totals, with a visible "incomplete" marker.
2. Normalize units only when conversion data exists: per-cwt and per-lb to per-ft requires `weight_per_ft`; per-pc to per-ft requires length. Otherwise show the native basis and mark "not comparable".
3. Alternates are never auto-selected. Selecting an alternate requires a confirmation that names the difference.
4. Early-pay savings are a scenario row, not a discount applied to the base.
5. Selection is per request line. Splits are allowed. The sum of selected qty may be less than requested (shows remaining) but a warning appears if it exceeds requested.
6. Price is one column among several. The UI does not sort by price by default; default sort is vendor name, with sort controls for price, ready date, and availability.

Extended cost math (deterministic, tested):
- `per_ft`: `unit_price * length_ft * qty_pcs`
- `per_pc`: `unit_price * qty_pcs`
- `per_cwt`: `unit_price * (weight_per_ft * length_ft * qty_pcs) / 100`
- `per_lb`: `unit_price * weight_per_ft * length_ft * qty_pcs`
- `per_ton`: `unit_price * (weight_per_ft * length_ft * qty_pcs) / 2000`
- plate `per_sqft` and `per_cwt` need dims; otherwise not computed.

## 9. Screens

| Screen | Route | Purpose |
|---|---|---|
| Work queue | `/` | Requests by status, counts, days waiting |
| Request workspace | `/requests/[id]` | Source + parsed lines + attachments + vendor selections + activity. Tabs: Review, Route, RFQs, Offers, Compare |
| RFQ review | `/requests/[id]/rfqs` | Per-branch draft preview, edit, send all |
| Quote comparison | `/requests/[id]/compare` | Line-by-line grid, alternates, selections, confirm purchase |
| Vendors | `/vendors`, `/vendors/[id]` | Companies, branches, contacts, capabilities, terms |
| Items | `/items` | Catalog and aliases |
| Purchase history | `/history` | Search and drill back to source |
| Intake | `/requests/new` | Paste, upload .eml, or manual lines |

UI: server-rendered Next.js App Router pages, Tailwind, a headless table (TanStack Table) for the review and comparison grids. Keep it plain and fast. No design system work in Phase 1.

## 10. Non-functional requirements

- Traceability: every extracted value has a `source_span`; every edit is in `activity_log`.
- Revisions: post-send edits create a new request revision; old RFQs stay attached to the old revision.
- Isolation: RFQ recipient lists are per-branch; a test asserts no cross-vendor leakage in generated drafts.
- Idempotency: send is idempotent on `idempotency_key`.
- Privacy: customer-facing data structures (Phase 4) must never include vendor cost or margin. Model it now: `vendor_offers`, `offer_lines`, `purchases` are broker-only tables with no customer-readable view.
- Performance: parsing a 30-line request completes within 20 seconds synchronously in Phase 1. If it cannot, Phase 2 moves it to a job.
- Auditability: `messages` keeps the full outbound text of every "sent" RFQ even in no-op mode.

## 11. Technical decisions

| Decision | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router), TypeScript, server actions | Known stack, fast to ship |
| Database | Supabase Postgres | Auth, Storage, RLS, and Postgres on one bill; multi-tenant later without replatforming |
| Schema management | Supabase CLI SQL migrations; `supabase gen types` for TS types | Simple, reviewable, no ORM to fight |
| Data access | `@supabase/supabase-js` with RLS; admin client (`SUPABASE_SECRET_KEY`, the secret key that replaced the service-role key) only inside server-side code | Keeps policies honest from day one |
| Files | Supabase Storage, bucket `attachments`, path `{broker_id}/{owner_type}/{owner_id}/{sha256}-{filename}` | Dedupe by hash |
| Hosting | Vercel | Known stack; preview deploys per branch |
| LLM | Anthropic Messages API, forced tool use with a JSON schema for extraction; model from env `PARSE_MODEL` (default `claude-sonnet-5-5`) | Structured output, swappable model |
| Email | `MailAdapter` interface; `NoopMailAdapter` in Phase 1; `.eml` parsed with `mailparser` | Provider decision deferred without blocking |
| Jobs | None in Phase 1; Inngest in Phase 2 | Reduce tonight's surface area |
| Tables | TanStack Table | Headless, handles the grids |
| Tests | Vitest for pure logic (normalization, alias matching, vendor matching, extended cost, idempotency) | The deterministic parts are where correctness matters |
| Validation | Zod at every boundary: server action inputs, LLM tool output, `.eml` parse output | Fail loudly on bad shapes |

## 12. Email strategy (OPEN, does not block Phase 1)

Preferred path: send and receive through Caleb's own mailbox (Microsoft Graph if he is on M365, Gmail API if Google), so RFQs come from his address and replies land in his inbox. The app reads the mailbox, never replaces it.

Fallback path: a transactional provider with inbound parsing (Postmark delivers full inbound content in one webhook) on a Forgentics-controlled domain with `Reply-To` set to Caleb. Cleaner to build, worse for relationships.

Phase 1 ships only the `MailAdapter` interface and `NoopMailAdapter`:

```ts
interface MailAdapter {
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
  // Phase 2:
  // fetchNew(since: Date): Promise<InboundMessage[]>;
}
```

Question for Caleb this week: which mailbox, and is he fine with the app sending as him.

## 13. Parsing specification

Two extraction tasks, same pattern:

**A. Request lines** (input: source text, optional attachment text). Tool schema `extract_material_lines` returns `lines[]` with: `raw_text`, `span {start,end}`, `product_type` (free text), `category` (enum or null), `dims` (object of named numbers and fractions as strings, e.g. `{a:"8", b:"8", t:"5/8"}`), `grade_spec` (string or null), `qty` (number or null), `unit` (enum or null), `length_ft` (number or null), `length_text` (string or null), `cut_to_length` (bool), `delivery_notes`, `alternates_mentioned` (string[]), `confidence`, `flags[]`.

**B. Offer lines** (input: reply text or PDF text, plus the RFQ's lines for context). Tool schema `extract_offer_lines` returns `offer_meta` (terms, early-pay, freight, expiration, overall availability remarks) and `lines[]` each referencing a `request_line_id` from the provided context, with the fields in §7 `offer_lines`.

Rules for both:
- The model returns strings for fractions and mixed numbers; code converts (`5/8` → 0.625, `1-1/2` → 1.5).
- The model never fills missing values. Missing → null + flag.
- After extraction, deterministic normalization runs: alias lookup to `catalog_items`, unit canonicalization, length parsing (`40'`, `40 ft`, `40-0`, `480"`), weight lookup.
- Prompt and schema live in `src/lib/parsing/` with fixtures and snapshot tests. Prompt changes require fixture runs to pass.
- Log every model call (input hash, model, tokens, latency) to `activity_log` with `action = 'llm_call'`.

System prompt stance: "You are extracting line items from steel material requests sent to a broker in Texas. Shop language is common: `8 square 5/8` means HSS 8x8 with 5/8 wall. `12 inch channel 30#` means C12x30. `#` and `lb` after a number denote weight per foot. Do not guess grades. Do not guess quantities." Extend with examples from §15.

## 14. Seed data

Catalog: generate programmatically from AISC-style size lists for the categories in AC-4.1, with aliases generated by rule (e.g. for `HSS8x8x5/8`: `8x8x5/8`, `8 square 5/8`, `8 sq 5/8`, `8" sq tube 5/8`, `8x8 5/8 wall`, `8 square 5/8 wall`). Hand-add aliases for the fixtures.

Vendors (examples from the discovery call; mark `notes = 'example from discovery call, verify'`):
- Mills: Gerdau (structural), Bull Moose (tubing), Nucor Tubular (tubing; accessed via a partner's account, note that)
- Service centers: Delta Steel (TX), Morgan Steel (TX), Triad Metals (VA), Norfolk Iron & Metal, Ryerson, Metals USA, Alro, Infra-Metals, JMS / Russel Metals, Phoenix Metals, O'Neal Steel (has Pronto portal, pricing access removed)

Contacts: placeholder names and `@example.com` emails. Caleb replaces.

One broker: `Caleb's company (set name)`. One user: Michael's email for tonight; Caleb's added in Phase 2.

## 15. Test fixtures

Requests (`fixtures/requests/*.txt` or `.eml`):
1. `single-hss.txt`: "Need pricing on 100 pcs 8x8x5/8 HSS, 40' lengths, A500 Gr B, delivered Fort Worth. If 5/8 is too heavy can look at 3/8." Expect 1 line, `alternate_mentioned`, cut_to_length false.
2. `channel-heavier.txt`: "12 inch channel 30# or heavier, 6 pcs at 40 ft" Expect C12x30 link, flag `alternate_mentioned`, missing grade.
3. `mixed-list.eml`: W12x26 x 50' qty 8; L2x2x1/4 x 20' qty 40; 3/8 plate 48x96 qty 10 A36; 6" sq 3/8 x 24' qty 20; signature block and a quoted earlier thread to ignore. Expect 4 lines, correct categories, plate dims parsed.
4. `ambiguous.txt`: "8 square 3/8 x 40 - 20 pcs, also 1/2 wall if 3/8 not available, and some angle for clips" Expect 2 lines with flags (`alternate_mentioned`, and `ambiguous_size` + `missing_qty` on the angle).
5. `pdf-list.eml`: email with a one-page PDF table attached. Expect lines extracted with attachment spans.

Replies (`fixtures/replies/*`):
1. `alt-wall-rolling.txt`: "3/8 wall is booked through December, nothing on the floor. We can offer 8x8x1/2 from stock, 40', $XX.XX/cwt FOB mill." Expect alternate `wall`, availability stock, basis per_cwt.
2. `partial-discount.txt`: "Have 60 pcs in stock at $X.XX/ft, freight separate, 1% net 10." Expect available_qty 60, freight_basis separate, early_pay 1%/10.
3. `future-rolling.txt`: "Rolling week of Nov 17, five loads, can cut 40'." Expect availability rolling with date, cut noted, price null + flag.
4. `quote.pdf.eml`: PDF quote with a table. Expect lines with attachment spans.
5. `decline.txt`: "Sorry, we don't stock channel." Expect offer status declined.
6. Manual phone quote entered through the UI (covered by an integration test or the demo script).

## 16. Open decisions (do not block Phase 1)

| Item | Owner | Needed by |
|---|---|---|
| Caleb's mailbox provider and consent to send-as | Michael, call with Caleb | Phase 2 start |
| Real vendor branches, contacts, categories | Caleb | Before pilot |
| 5 to 10 real requests and the replies they got | Caleb | Before pilot (replace fixtures) |
| Whether freight is usually quoted by vendors or arranged by Caleb | Caleb | Phase 2 |
| QuickBooks edition and current quote/invoice flow | Caleb | Phase 3 |
| Customer quote generation: MVP or Phase 3 | Michael | Phase 2 |
| Product name | Michael | Whenever |
| Commercial terms with Caleb (design partner vs partnership) | Michael | **Before the demo is shown** |

## 17. Success metric

Pilot target: roughly one hour per day saved. Measure before and during the pilot: minutes spent preparing RFQs, minutes comparing responses, minutes re-entering transaction data. Instrument the app to time the RFQ draft → send and reply → selection intervals so the "during" number is automatic.

## 18. Phase 1 acceptance (definition of done for the build)

The demo is done when, on seeded data and fixtures, Michael can:
1. Import `mixed-list.eml`, see 4 parsed lines with correct spans, fix one field, and confirm the request.
2. See suggested branches per line, remove one, add one, and generate drafts.
3. Preview three per-vendor RFQs, confirm no cross-vendor recipients, edit one body, and "send all" through the no-op adapter.
4. Ingest replies 1, 2, 3, and 5 against the right RFQs, review extracted offer lines.
5. Open the comparison, see the alternate wall flagged, the partial quantity, the unknown freight, the early-pay scenario, and the rolling date.
6. Select vendor A for two lines, split the third across A and B, confirm the purchase.
7. Search history for `C12x30` and open the original reply from the result.
8. Run `npm test` green, with tests covering alias matching, unit/length parsing, extended cost, vendor matching, idempotent send, and recipient isolation.

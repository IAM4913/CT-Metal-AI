# Anvil

Back office for independent steel brokers. Phase 1 is a single-user demo: import a customer material request, review the parsed lines, route them to vendor branches, preview per-vendor RFQs, "send" through a no-op mail adapter, ingest replies, compare offers, and confirm a purchase.

See `PRD.md` for requirements, `PLAN.md` for the build order, `CLAUDE.md` for conventions, `SETUP.md` for pointing at a hosted Supabase project, and `SESSION_NOTES.md` for the current state.

## Run locally

```
cp .env.local.example .env.local   # then fill in keys from `supabase status` (local) or SETUP.md (hosted)
supabase start && supabase db reset && npm run seed
npm run dev
```

## Checks

```
npm test          # vitest, offline, uses recorded model outputs under fixtures/recorded
npm run build
npm run lint
```

# SETUP: point this repo at a hosted Supabase project

Run from the repo root. Replace `<ref>` with the project ref from the Supabase dashboard URL and `<db-password>` with the database password you set when creating the project.

```
npm install
npx supabase login
npx supabase link --project-ref <ref> --password '<db-password>'

# keys into .env.local (keeps the other variables from the example file)
cp -n .env.local.example .env.local
npx supabase projects api-keys --project-ref <ref>
#   copy the "publishable" key into NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
#   copy the "secret" key into SUPABASE_SECRET_KEY
#   set NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
#   set ANTHROPIC_API_KEY, SEED_USER_EMAIL, SEED_USER_PASSWORD

npx supabase db push                                   # applies supabase/migrations in order
npx supabase gen types typescript --linked > src/lib/db/types.ts
npm run seed                                           # broker, login user, vendors, catalog, attachments bucket
npm run record-fixtures                                # replaces hand-authored fixtures/recorded/*.json with real model output
npm test && npm run build && npm run lint
npm run dev                                            # sign in with SEED_USER_EMAIL / SEED_USER_PASSWORD
```

Notes: `supabase db push` only runs migrations that are not yet recorded on the project. `npm run seed` is idempotent on the broker and user (looks them up by name and email first). To start over on a hosted project: `npx supabase db reset --linked` (destroys data), then seed again.

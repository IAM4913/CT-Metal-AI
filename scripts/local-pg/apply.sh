#!/usr/bin/env bash
# Apply the auth shim, every migration in order, and the RLS proof to a fresh
# database on a plain PostgreSQL cluster. Used when the Supabase stack (Docker)
# is not available. Against a real Supabase project use `supabase db reset`.
#
# Env: PGHOST (default /home/pgtest/pg), PGPORT (54329), PGUSER (postgres), PGDATABASE (anvil_test)
set -euo pipefail
cd "$(dirname "$0")/../.."

export PGHOST="${PGHOST:-/home/pgtest/pg}"
export PGPORT="${PGPORT:-54329}"
export PGUSER="${PGUSER:-postgres}"
DB="${PGDATABASE:-anvil_test}"
unset PGDATABASE

psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists ${DB}" -c "create database ${DB}"
psql -v ON_ERROR_STOP=1 -q -d "${DB}" -f scripts/local-pg/auth-shim.sql

shopt -s nullglob
for f in supabase/migrations/*.sql; do
  echo "applying ${f}"
  psql -v ON_ERROR_STOP=1 -q -d "${DB}" -f "${f}"
done

if [[ -f scripts/rls-proof.sql ]]; then
  echo "running scripts/rls-proof.sql"
  psql -v ON_ERROR_STOP=1 -q -d "${DB}" -f scripts/rls-proof.sql
fi
echo "ok: ${DB} on ${PGHOST}:${PGPORT}"

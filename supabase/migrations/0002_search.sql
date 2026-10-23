-- 0002_search: trigram indexes for fuzzy search over request lines, aliases, and purchases.

create extension if not exists pg_trgm with schema extensions;

create index request_lines_raw_text_trgm_idx
  on public.request_lines using gin (raw_text extensions.gin_trgm_ops);

create index request_lines_description_trgm_idx
  on public.request_lines using gin (description extensions.gin_trgm_ops);

create index catalog_aliases_alias_trgm_idx
  on public.catalog_aliases using gin (alias extensions.gin_trgm_ops);

create index purchases_po_number_trgm_idx
  on public.purchases using gin (po_number extensions.gin_trgm_ops);

create index purchases_notes_trgm_idx
  on public.purchases using gin (notes extensions.gin_trgm_ops);

-- the plain btree index catalog_aliases_alias_idx (PRD section 7) is created in 0001_init.sql

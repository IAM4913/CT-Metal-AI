-- 0001_init: Anvil Phase 1 schema (PRD section 7).
--
-- Conventions
--   every table: id uuid pk, created_at, updated_at (set by trigger)
--   every business table: broker_id, row level security enabled and forced
--   catalog_items: shared item master with no broker_id (PRD section 7)
--   catalog_aliases: broker_id null means seeded/global, non-null means learned by that broker
--   every child row references its parent by (id, broker_id), so a row can never
--     point at another tenant's parent; parents carry unique (id, broker_id) for this
--   activity_log is append-only for app users: select and insert only
--   enums are postgres enum types, one per PRD field
--   "references" on messages is a reserved word and is always quoted

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------

create type public.member_role as enum ('owner', 'admin', 'member');

create type public.request_source_type as enum ('paste', 'eml', 'manual', 'mailbox');

create type public.request_status as enum (
  'new', 'parsing', 'needs_review', 'reviewed', 'rfqs_drafted', 'rfqs_sent',
  'collecting', 'comparing', 'sourced', 'closed'
);

create type public.line_unit as enum ('pcs', 'ft', 'in', 'lbs', 'cwt', 'tons', 'sqft');

create type public.request_line_status as enum ('parsed', 'confirmed', 'custom', 'removed');

-- channel covers C and MC, angle covers equal and unequal; the designation distinguishes them
create type public.material_category as enum (
  'hss_square', 'hss_rectangular', 'hss_round', 'pipe', 'w_beam', 's_beam', 'channel',
  'angle', 'flat_bar', 'round_bar', 'square_bar', 'plate', 'sheet', 'rebar'
);

create type public.alias_source as enum ('seed', 'learned');

create type public.vendor_type as enum ('mill', 'service_center', 'broker', 'other');

create type public.freight_default as enum ('quoted', 'arranged', 'fob', 'unknown');

create type public.rfq_status as enum (
  'draft', 'queued', 'sent', 'failed', 'responded', 'declined', 'closed'
);

create type public.message_direction as enum ('in', 'out');

create type public.matched_by as enum ('thread', 'manual', 'ai', 'none');

create type public.offer_source as enum ('email', 'pdf', 'phone', 'text', 'manual');

create type public.offer_status as enum ('parsed', 'reviewed', 'declined');

create type public.availability as enum ('stock', 'rolling', 'unknown');

create type public.price_basis as enum (
  'per_cwt', 'per_lb', 'per_ft', 'per_pc', 'per_ton', 'per_sqft'
);

create type public.freight_basis as enum ('included', 'separate', 'unknown');

-- offer_lines.alternate_types: the ways an offered item differs from the request line
create type public.alternate_type as enum ('grade', 'dimension', 'wall', 'length');

-- ---------------------------------------------------------------------------
-- helper functions
-- ---------------------------------------------------------------------------

-- shared before update trigger: stamps updated_at on every row change
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

create table public.brokers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.brokers is 'Tenant: one independent steel broker (company).';

create table public.broker_members (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (broker_id, user_id)
);
comment on table public.broker_members is 'Which auth users belong to which broker, with a role; drives every RLS check.';

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  name text not null,
  short_name text not null default '',
  email_domain text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id)
);
comment on table public.customers is 'The broker''s customers (fabricators, contractors) who send material requests.';

create table public.customer_contacts (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  customer_id uuid not null,
  name text not null,
  email text not null,
  phone text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (customer_id, broker_id) references public.customers (id, broker_id) on delete cascade
);
comment on table public.customer_contacts is 'People at a customer who send or receive requests.';

create table public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  category public.material_category not null,
  designation text not null unique,
  dims jsonb not null default '{}'::jsonb,
  weight_per_ft numeric null,
  default_grade text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.catalog_items is 'Shared item master of standard steel shapes (no broker_id, PRD section 7); readable and writable by every authenticated user.';

create table public.catalog_aliases (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid null references public.brokers(id),
  catalog_item_id uuid not null references public.catalog_items(id),
  alias text not null,
  source public.alias_source not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (catalog_item_id, alias, broker_id)
);
comment on table public.catalog_aliases is 'Normalized spellings that resolve to a catalog item; broker_id null means seeded, non-null means learned by that broker.';

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  customer_id uuid null,
  source_type public.request_source_type not null,
  subject text not null default '',
  source_text text not null,
  source_message_id text null,
  received_at timestamptz not null default now(),
  status public.request_status not null default 'new',
  revision integer not null default 1,
  parent_request_id uuid null,
  delivery_requirements text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id),
  foreign key (customer_id, broker_id) references public.customers (id, broker_id),
  foreign key (parent_request_id, broker_id) references public.requests (id, broker_id)
);
comment on table public.requests is 'An inbound customer material request (one email or paste), revisioned via parent_request_id.';

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  owner_type text not null,
  owner_id uuid not null,
  storage_path text not null,
  filename text not null,
  mime text not null,
  size_bytes bigint not null,
  sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id)
);
comment on table public.attachments is 'Files in the attachments storage bucket, owned by a request, message, or offer (owner_type, owner_id).';

create table public.request_lines (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  request_id uuid not null,
  line_no integer not null,
  raw_text text not null,
  catalog_item_id uuid null references public.catalog_items(id),
  category public.material_category null,
  description text not null,
  dims jsonb not null default '{}'::jsonb,
  grade_spec text null,
  qty numeric null,
  unit public.line_unit null,
  length_ft numeric null,
  length_text text null,
  cut_to_length boolean not null default false,
  delivery_notes text null,
  flags text[] not null default '{}',
  confidence numeric not null,
  source_span jsonb not null default '{}'::jsonb,
  status public.request_line_status not null default 'parsed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id),
  foreign key (request_id, broker_id) references public.requests (id, broker_id) on delete cascade
);
comment on table public.request_lines is 'One material line extracted from a request, with normalized fields, flags, confidence, and its source span.';

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  name text not null,
  vendor_type public.vendor_type not null,
  website text null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id)
);
comment on table public.vendors is 'Mills, service centers, and other suppliers the broker buys from.';

create table public.vendor_branches (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  vendor_id uuid not null,
  name text not null,
  city text not null,
  state text not null,
  region text null,
  preferred boolean not null default false,
  payment_terms text null,
  early_pay_pct numeric null,
  early_pay_days integer null,
  freight_default public.freight_default not null default 'unknown',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id),
  foreign key (vendor_id, broker_id) references public.vendors (id, broker_id) on delete cascade
);
comment on table public.vendor_branches is 'A vendor location that receives RFQs, with its terms and freight default.';

create table public.vendor_contacts (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  branch_id uuid not null,
  name text not null,
  email text not null,
  phone text null,
  is_primary boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, broker_id) references public.vendor_branches (id, broker_id) on delete cascade
);
comment on table public.vendor_contacts is 'People at a vendor branch; RFQs go to the primary contact.';

create table public.vendor_capabilities (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  branch_id uuid not null,
  category public.material_category not null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (branch_id, category),
  foreign key (branch_id, broker_id) references public.vendor_branches (id, broker_id) on delete cascade
);
comment on table public.vendor_capabilities is 'Material categories a vendor branch can supply; used for vendor matching.';

create table public.rfqs (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  request_id uuid not null,
  branch_id uuid not null,
  revision integer not null default 1,
  status public.rfq_status not null default 'draft',
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  subject text not null,
  body_text text not null,
  include_customer_name boolean not null default false,
  idempotency_key text not null unique,
  sent_at timestamptz null,
  provider_message_id text null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id),
  foreign key (request_id, broker_id) references public.requests (id, broker_id),
  foreign key (branch_id, broker_id) references public.vendor_branches (id, broker_id)
);
comment on table public.rfqs is 'One request-for-quote draft or send to one vendor branch for one request revision.';

create table public.rfq_lines (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  rfq_id uuid not null,
  request_line_id uuid not null,
  note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rfq_id, request_line_id),
  foreign key (rfq_id, broker_id) references public.rfqs (id, broker_id) on delete cascade,
  foreign key (request_line_id, broker_id) references public.request_lines (id, broker_id)
);
comment on table public.rfq_lines is 'Which request lines are included in an RFQ.';

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  direction public.message_direction not null,
  rfq_id uuid null,
  request_id uuid null,
  from_email text not null,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  subject text not null default '',
  body_text text not null,
  body_html text null,
  received_at timestamptz not null default now(),
  provider_message_id text null,
  in_reply_to text null,
  "references" text[] not null default '{}',
  matched_by public.matched_by not null default 'none',
  raw_attachment_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id),
  foreign key (rfq_id, broker_id) references public.rfqs (id, broker_id),
  foreign key (request_id, broker_id) references public.requests (id, broker_id),
  foreign key (raw_attachment_id, broker_id) references public.attachments (id, broker_id)
);
comment on table public.messages is 'Inbound and outbound email messages, threaded to an RFQ or request when matched.';

create table public.vendor_offers (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  rfq_id uuid not null,
  branch_id uuid not null,
  message_id uuid null,
  attachment_id uuid null,
  source public.offer_source not null,
  status public.offer_status not null default 'parsed',
  received_at timestamptz not null default now(),
  quote_expires_at timestamptz null,
  payment_terms text null,
  early_pay_pct numeric null,
  early_pay_days integer null,
  freight_amount numeric null,
  freight_basis public.freight_basis not null default 'unknown',
  notes text not null default '',
  confidence numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id),
  foreign key (rfq_id, broker_id) references public.rfqs (id, broker_id),
  foreign key (branch_id, broker_id) references public.vendor_branches (id, broker_id),
  foreign key (message_id, broker_id) references public.messages (id, broker_id),
  foreign key (attachment_id, broker_id) references public.attachments (id, broker_id)
);
comment on table public.vendor_offers is 'A vendor''s quote in reply to an RFQ: header terms, freight, and confidence.';

create table public.offer_lines (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  offer_id uuid not null,
  request_line_id uuid not null,
  offered_catalog_item_id uuid null references public.catalog_items(id),
  offered_desc text not null,
  is_exact_match boolean not null default false,
  alternate_types public.alternate_type[] not null default '{}',
  available_qty numeric null,
  unit public.line_unit null,
  availability public.availability not null default 'unknown',
  ready_date date null,
  delivery_estimate_text text null,
  unit_price numeric null,
  price_basis public.price_basis null,
  extended_price numeric null,
  flags text[] not null default '{}',
  confidence numeric not null,
  source_span jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id),
  foreign key (offer_id, broker_id) references public.vendor_offers (id, broker_id) on delete cascade,
  foreign key (request_line_id, broker_id) references public.request_lines (id, broker_id)
);
comment on table public.offer_lines is 'One quoted line in a vendor offer, mapped to a request line; extended_price is computed by code and nullable.';

create table public.sourcing_selections (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  request_line_id uuid not null,
  offer_line_id uuid not null,
  qty numeric not null,
  selected_at timestamptz not null default now(),
  note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id),
  foreign key (request_line_id, broker_id) references public.request_lines (id, broker_id),
  foreign key (offer_line_id, broker_id) references public.offer_lines (id, broker_id)
);
comment on table public.sourcing_selections is 'The broker''s choice of which offer line fills which request line, and how much.';

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  request_id uuid not null,
  branch_id uuid not null,
  confirmed_at timestamptz not null default now(),
  po_number text null,
  total_material numeric null,
  total_freight numeric null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, broker_id),
  foreign key (request_id, broker_id) references public.requests (id, broker_id),
  foreign key (branch_id, broker_id) references public.vendor_branches (id, broker_id)
);
comment on table public.purchases is 'A confirmed buy from one vendor branch for one request; the sourcing history record.';

create table public.purchase_lines (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  purchase_id uuid not null,
  selection_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (selection_id),
  foreign key (purchase_id, broker_id) references public.purchases (id, broker_id) on delete cascade,
  foreign key (selection_id, broker_id) references public.sourcing_selections (id, broker_id)
);
comment on table public.purchase_lines is 'Which sourcing selections were confirmed into a purchase.';

create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  broker_id uuid not null references public.brokers(id),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor_user_id uuid null references auth.users(id),
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.activity_log is 'Append-only audit trail of user and system actions, including every LLM call. App users can only insert and read; update, delete, and truncate are revoked and there is no updated_at trigger (updated_at always equals created_at).';

-- ---------------------------------------------------------------------------
-- indexes
-- ---------------------------------------------------------------------------

-- PRD section 7 "Indexes"
create index request_lines_request_id_idx on public.request_lines (request_id);
create index rfqs_request_id_idx on public.rfqs (request_id);
-- rfqs(idempotency_key) is covered by the unique constraint
create index messages_in_reply_to_idx on public.messages (in_reply_to);
create index messages_provider_message_id_idx on public.messages (provider_message_id);
create index offer_lines_request_line_id_idx on public.offer_lines (request_line_id);
create index catalog_aliases_alias_idx on public.catalog_aliases (alias);
create index purchases_broker_id_confirmed_at_idx on public.purchases (broker_id, confirmed_at desc);

-- foreign key and *_id indexes not already covered
create index broker_members_user_id_idx on public.broker_members (user_id);
create index customers_broker_id_idx on public.customers (broker_id);
create index customer_contacts_broker_id_idx on public.customer_contacts (broker_id);
create index customer_contacts_customer_id_idx on public.customer_contacts (customer_id);
create index catalog_aliases_broker_id_idx on public.catalog_aliases (broker_id);
create index catalog_aliases_catalog_item_id_idx on public.catalog_aliases (catalog_item_id);
create index requests_broker_id_idx on public.requests (broker_id);
create index requests_customer_id_idx on public.requests (customer_id);
create index requests_parent_request_id_idx on public.requests (parent_request_id);
create index attachments_broker_id_idx on public.attachments (broker_id);
create index attachments_owner_idx on public.attachments (owner_type, owner_id);
create index request_lines_broker_id_idx on public.request_lines (broker_id);
create index request_lines_catalog_item_id_idx on public.request_lines (catalog_item_id);
create index vendors_broker_id_idx on public.vendors (broker_id);
create index vendor_branches_broker_id_idx on public.vendor_branches (broker_id);
create index vendor_branches_vendor_id_idx on public.vendor_branches (vendor_id);
create index vendor_contacts_broker_id_idx on public.vendor_contacts (broker_id);
create index vendor_contacts_branch_id_idx on public.vendor_contacts (branch_id);
create index vendor_capabilities_broker_id_idx on public.vendor_capabilities (broker_id);
-- vendor_capabilities(branch_id) is covered by the unique constraint
create index rfqs_broker_id_idx on public.rfqs (broker_id);
create index rfqs_branch_id_idx on public.rfqs (branch_id);
create index rfq_lines_broker_id_idx on public.rfq_lines (broker_id);
-- rfq_lines(rfq_id) is covered by the unique constraint
create index rfq_lines_request_line_id_idx on public.rfq_lines (request_line_id);
create index messages_broker_id_idx on public.messages (broker_id);
create index messages_rfq_id_idx on public.messages (rfq_id);
create index messages_request_id_idx on public.messages (request_id);
create index messages_raw_attachment_id_idx on public.messages (raw_attachment_id);
create index vendor_offers_broker_id_idx on public.vendor_offers (broker_id);
create index vendor_offers_rfq_id_idx on public.vendor_offers (rfq_id);
create index vendor_offers_branch_id_idx on public.vendor_offers (branch_id);
create index vendor_offers_message_id_idx on public.vendor_offers (message_id);
create index vendor_offers_attachment_id_idx on public.vendor_offers (attachment_id);
create index offer_lines_broker_id_idx on public.offer_lines (broker_id);
create index offer_lines_offer_id_idx on public.offer_lines (offer_id);
create index offer_lines_offered_catalog_item_id_idx on public.offer_lines (offered_catalog_item_id);
create index sourcing_selections_broker_id_idx on public.sourcing_selections (broker_id);
create index sourcing_selections_request_line_id_idx on public.sourcing_selections (request_line_id);
create index sourcing_selections_offer_line_id_idx on public.sourcing_selections (offer_line_id);
-- purchases(broker_id) is covered by purchases_broker_id_confirmed_at_idx
create index purchases_request_id_idx on public.purchases (request_id);
create index purchases_branch_id_idx on public.purchases (branch_id);
create index purchase_lines_broker_id_idx on public.purchase_lines (broker_id);
create index purchase_lines_purchase_id_idx on public.purchase_lines (purchase_id);
-- purchase_lines(selection_id) is covered by the unique constraint
create index activity_log_broker_id_at_idx on public.activity_log (broker_id, at desc);
create index activity_log_entity_idx on public.activity_log (entity_type, entity_id);
create index activity_log_actor_user_id_idx on public.activity_log (actor_user_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create trigger brokers_set_updated_at before update on public.brokers for each row execute function public.set_updated_at();
create trigger broker_members_set_updated_at before update on public.broker_members for each row execute function public.set_updated_at();
create trigger customers_set_updated_at before update on public.customers for each row execute function public.set_updated_at();
create trigger customer_contacts_set_updated_at before update on public.customer_contacts for each row execute function public.set_updated_at();
create trigger catalog_items_set_updated_at before update on public.catalog_items for each row execute function public.set_updated_at();
create trigger catalog_aliases_set_updated_at before update on public.catalog_aliases for each row execute function public.set_updated_at();
create trigger requests_set_updated_at before update on public.requests for each row execute function public.set_updated_at();
create trigger attachments_set_updated_at before update on public.attachments for each row execute function public.set_updated_at();
create trigger request_lines_set_updated_at before update on public.request_lines for each row execute function public.set_updated_at();
create trigger vendors_set_updated_at before update on public.vendors for each row execute function public.set_updated_at();
create trigger vendor_branches_set_updated_at before update on public.vendor_branches for each row execute function public.set_updated_at();
create trigger vendor_contacts_set_updated_at before update on public.vendor_contacts for each row execute function public.set_updated_at();
create trigger vendor_capabilities_set_updated_at before update on public.vendor_capabilities for each row execute function public.set_updated_at();
create trigger rfqs_set_updated_at before update on public.rfqs for each row execute function public.set_updated_at();
create trigger rfq_lines_set_updated_at before update on public.rfq_lines for each row execute function public.set_updated_at();
create trigger messages_set_updated_at before update on public.messages for each row execute function public.set_updated_at();
create trigger vendor_offers_set_updated_at before update on public.vendor_offers for each row execute function public.set_updated_at();
create trigger offer_lines_set_updated_at before update on public.offer_lines for each row execute function public.set_updated_at();
create trigger sourcing_selections_set_updated_at before update on public.sourcing_selections for each row execute function public.set_updated_at();
create trigger purchases_set_updated_at before update on public.purchases for each row execute function public.set_updated_at();
create trigger purchase_lines_set_updated_at before update on public.purchase_lines for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------------

-- true when the calling user is a member of the given broker.
-- security definer so it reads broker_members without recursing into its own policy.
create or replace function public.is_broker_member(target_broker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.broker_members
    where broker_id = target_broker_id
      and user_id = auth.uid()
  );
$$;

grant execute on function public.is_broker_member(uuid) to authenticated;

alter table public.brokers enable row level security;
alter table public.brokers force row level security;
alter table public.broker_members enable row level security;
alter table public.broker_members force row level security;
alter table public.customers enable row level security;
alter table public.customers force row level security;
alter table public.customer_contacts enable row level security;
alter table public.customer_contacts force row level security;
alter table public.catalog_items enable row level security;
alter table public.catalog_items force row level security;
alter table public.catalog_aliases enable row level security;
alter table public.catalog_aliases force row level security;
alter table public.requests enable row level security;
alter table public.requests force row level security;
alter table public.attachments enable row level security;
alter table public.attachments force row level security;
alter table public.request_lines enable row level security;
alter table public.request_lines force row level security;
alter table public.vendors enable row level security;
alter table public.vendors force row level security;
alter table public.vendor_branches enable row level security;
alter table public.vendor_branches force row level security;
alter table public.vendor_contacts enable row level security;
alter table public.vendor_contacts force row level security;
alter table public.vendor_capabilities enable row level security;
alter table public.vendor_capabilities force row level security;
alter table public.rfqs enable row level security;
alter table public.rfqs force row level security;
alter table public.rfq_lines enable row level security;
alter table public.rfq_lines force row level security;
alter table public.messages enable row level security;
alter table public.messages force row level security;
alter table public.vendor_offers enable row level security;
alter table public.vendor_offers force row level security;
alter table public.offer_lines enable row level security;
alter table public.offer_lines force row level security;
alter table public.sourcing_selections enable row level security;
alter table public.sourcing_selections force row level security;
alter table public.purchases enable row level security;
alter table public.purchases force row level security;
alter table public.purchase_lines enable row level security;
alter table public.purchase_lines force row level security;
alter table public.activity_log enable row level security;
alter table public.activity_log force row level security;

-- brokers: members can read and update their own broker; no insert or delete (admin client only)
create policy brokers_select on public.brokers
  for select to authenticated
  using (public.is_broker_member(id));
create policy brokers_update on public.brokers
  for update to authenticated
  using (public.is_broker_member(id))
  with check (public.is_broker_member(id));

-- broker_members: members see every membership of their own broker (the roster);
-- no insert, update, or delete (admin client only). The helper is security definer,
-- so reading broker_members inside it does not re-enter this policy.
create policy broker_members_select on public.broker_members
  for select to authenticated
  using (public.is_broker_member(broker_id));

-- catalog_items: shared item master (PRD section 7, no broker_id). Every authenticated
-- user can read it and, per AC-4.4, add and maintain items. anon has no policy and sees nothing.
create policy catalog_items_select on public.catalog_items
  for select to authenticated
  using (true);
create policy catalog_items_insert on public.catalog_items
  for insert to authenticated
  with check (true);
create policy catalog_items_update on public.catalog_items
  for update to authenticated
  using (true)
  with check (true);
create policy catalog_items_delete on public.catalog_items
  for delete to authenticated
  using (true);

-- catalog_aliases: seed rows (broker_id null) readable by every authenticated user;
-- a broker can only write learned aliases carrying its own broker_id
create policy catalog_aliases_select on public.catalog_aliases
  for select to authenticated
  using (broker_id is null or public.is_broker_member(broker_id));
create policy catalog_aliases_insert on public.catalog_aliases
  for insert to authenticated
  with check (broker_id is not null and public.is_broker_member(broker_id));
create policy catalog_aliases_update on public.catalog_aliases
  for update to authenticated
  using (broker_id is not null and public.is_broker_member(broker_id))
  with check (broker_id is not null and public.is_broker_member(broker_id));
create policy catalog_aliases_delete on public.catalog_aliases
  for delete to authenticated
  using (broker_id is not null and public.is_broker_member(broker_id));

-- every other business table except activity_log (below): full access for members of the row's broker

create policy customers_select on public.customers
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy customers_insert on public.customers
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy customers_update on public.customers
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy customers_delete on public.customers
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy customer_contacts_select on public.customer_contacts
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy customer_contacts_insert on public.customer_contacts
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy customer_contacts_update on public.customer_contacts
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy customer_contacts_delete on public.customer_contacts
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy requests_select on public.requests
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy requests_insert on public.requests
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy requests_update on public.requests
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy requests_delete on public.requests
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy attachments_select on public.attachments
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy attachments_insert on public.attachments
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy attachments_update on public.attachments
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy attachments_delete on public.attachments
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy request_lines_select on public.request_lines
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy request_lines_insert on public.request_lines
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy request_lines_update on public.request_lines
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy request_lines_delete on public.request_lines
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy vendors_select on public.vendors
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy vendors_insert on public.vendors
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy vendors_update on public.vendors
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy vendors_delete on public.vendors
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy vendor_branches_select on public.vendor_branches
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy vendor_branches_insert on public.vendor_branches
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy vendor_branches_update on public.vendor_branches
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy vendor_branches_delete on public.vendor_branches
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy vendor_contacts_select on public.vendor_contacts
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy vendor_contacts_insert on public.vendor_contacts
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy vendor_contacts_update on public.vendor_contacts
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy vendor_contacts_delete on public.vendor_contacts
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy vendor_capabilities_select on public.vendor_capabilities
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy vendor_capabilities_insert on public.vendor_capabilities
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy vendor_capabilities_update on public.vendor_capabilities
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy vendor_capabilities_delete on public.vendor_capabilities
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy rfqs_select on public.rfqs
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy rfqs_insert on public.rfqs
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy rfqs_update on public.rfqs
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy rfqs_delete on public.rfqs
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy rfq_lines_select on public.rfq_lines
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy rfq_lines_insert on public.rfq_lines
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy rfq_lines_update on public.rfq_lines
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy rfq_lines_delete on public.rfq_lines
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy messages_select on public.messages
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy messages_insert on public.messages
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy messages_update on public.messages
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy messages_delete on public.messages
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy vendor_offers_select on public.vendor_offers
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy vendor_offers_insert on public.vendor_offers
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy vendor_offers_update on public.vendor_offers
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy vendor_offers_delete on public.vendor_offers
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy offer_lines_select on public.offer_lines
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy offer_lines_insert on public.offer_lines
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy offer_lines_update on public.offer_lines
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy offer_lines_delete on public.offer_lines
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy sourcing_selections_select on public.sourcing_selections
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy sourcing_selections_insert on public.sourcing_selections
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy sourcing_selections_update on public.sourcing_selections
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy sourcing_selections_delete on public.sourcing_selections
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy purchases_select on public.purchases
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy purchases_insert on public.purchases
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy purchases_update on public.purchases
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy purchases_delete on public.purchases
  for delete to authenticated
  using (public.is_broker_member(broker_id));

create policy purchase_lines_select on public.purchase_lines
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy purchase_lines_insert on public.purchase_lines
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
create policy purchase_lines_update on public.purchase_lines
  for update to authenticated
  using (public.is_broker_member(broker_id))
  with check (public.is_broker_member(broker_id));
create policy purchase_lines_delete on public.purchase_lines
  for delete to authenticated
  using (public.is_broker_member(broker_id));

-- activity_log: append-only audit trail. Members can read and insert rows for their
-- broker; there is no update or delete policy, and the privileges are revoked as well
-- so a mutation fails outright instead of silently matching zero rows. The admin
-- client (service_role) keeps full access for maintenance.
create policy activity_log_select on public.activity_log
  for select to authenticated
  using (public.is_broker_member(broker_id));
create policy activity_log_insert on public.activity_log
  for insert to authenticated
  with check (public.is_broker_member(broker_id));
revoke update, delete, truncate on public.activity_log from anon, authenticated;

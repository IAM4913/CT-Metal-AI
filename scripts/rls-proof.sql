-- RLS proof for the Anvil schema.
--
-- Self-contained: inserts two users, two brokers, memberships, and a few rows,
-- then switches to the authenticated and anon roles and asserts what each can see
-- and write. Everything runs inside one transaction and is rolled back at the end.
--
-- Run as the postgres user, either through scripts/local-pg/apply.sh or against a
-- real Supabase database:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rls-proof.sql
-- Any failed assertion raises an exception, which aborts the script with a non-zero exit.
--
-- Covered rules
--   tenant rows (customers, vendors, requests, brokers, broker_members): own broker only
--   with check: a row for another broker cannot be inserted or updated
--   catalog_items: shared item master, readable and writable by every authenticated user
--   catalog_aliases: seed rows (broker_id null) readable by everyone, learned rows own broker only
--   activity_log: insert and select only; update and delete fail for app users
--   parent/child tenant consistency: a child row cannot reference another broker's parent
--   anon: sees nothing

begin;

-- ---------------------------------------------------------------------------
-- fixture rows (as postgres, which bypasses RLS)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000a001', 'rls-proof-user-1@example.com'),
  ('00000000-0000-4000-8000-00000000a002', 'rls-proof-user-2@example.com'),
  ('00000000-0000-4000-8000-00000000a003', 'rls-proof-user-3@example.com');

insert into public.brokers (id, name) values
  ('00000000-0000-4000-8000-00000000b001', 'RLS Proof Broker One'),
  ('00000000-0000-4000-8000-00000000b002', 'RLS Proof Broker Two');

-- user 3 is a second member of broker one, so the roster check below is meaningful
insert into public.broker_members (broker_id, user_id, role) values
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a001', 'owner'),
  ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000a002', 'owner'),
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a003', 'member');

insert into public.customers (id, broker_id, name) values
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000b001', 'RLS Proof Customer One'),
  ('00000000-0000-4000-8000-00000000c002', '00000000-0000-4000-8000-00000000b002', 'RLS Proof Customer Two');

insert into public.vendors (id, broker_id, name, vendor_type) values
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000b001', 'RLS Proof Vendor One', 'mill'),
  ('00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-00000000b002', 'RLS Proof Vendor Two', 'service_center');

-- the catalog is a shared item master: no broker_id
insert into public.catalog_items (id, category, designation) values
  ('00000000-0000-4000-8000-00000000e001', 'hss_square', 'RLSPROOF-GLOBAL');

-- a seed alias (broker_id null) that every authenticated user must be able to read
insert into public.catalog_aliases (broker_id, catalog_item_id, alias, source) values
  (null, '00000000-0000-4000-8000-00000000e001', 'rlsproof seed alias', 'seed');

-- one request per broker, and one line on broker one's request, for the parent/child checks
insert into public.requests (id, broker_id, source_type, source_text) values
  ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000b001', 'paste', 'rls proof request one'),
  ('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000b002', 'paste', 'rls proof request two');

insert into public.request_lines (id, broker_id, request_id, line_no, raw_text, description, confidence) values
  ('00000000-0000-4000-8000-00000000f101', '00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000f001', 1, 'rls proof line', 'rls proof line', 1);

-- an audit row for broker one, so user 2's tamper attempt below has a target
insert into public.activity_log (id, broker_id, entity_type, entity_id, action) values
  ('00000000-0000-4000-8000-00000000f201', '00000000-0000-4000-8000-00000000b001', 'request', '00000000-0000-4000-8000-00000000f001', 'rls_proof_fixture');

-- ---------------------------------------------------------------------------
-- user 1 (member of broker one)
-- ---------------------------------------------------------------------------

set local role authenticated;

do $$
declare
  n integer;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true);

  if auth.uid() <> '00000000-0000-4000-8000-00000000a001' then
    raise exception 'user 1: auth.uid() did not pick up the jwt sub claim';
  end if;

  select count(*) into n from public.customers;
  if n <> 1 then
    raise exception 'user 1: expected exactly 1 visible customer, saw %', n;
  end if;
  if not exists (select 1 from public.customers where id = '00000000-0000-4000-8000-00000000c001') then
    raise exception 'user 1: cannot see own customer';
  end if;
  if exists (select 1 from public.customers where id = '00000000-0000-4000-8000-00000000c002') then
    raise exception 'user 1: can see broker two customer';
  end if;

  select count(*) into n from public.vendors;
  if n <> 1 then
    raise exception 'user 1: expected exactly 1 visible vendor, saw %', n;
  end if;
  if not exists (select 1 from public.vendors where id = '00000000-0000-4000-8000-00000000d001') then
    raise exception 'user 1: cannot see own vendor';
  end if;
  if exists (select 1 from public.vendors where id = '00000000-0000-4000-8000-00000000d002') then
    raise exception 'user 1: can see broker two vendor';
  end if;

  select count(*) into n from public.brokers;
  if n <> 1 then
    raise exception 'user 1: expected exactly 1 visible broker, saw %', n;
  end if;

  -- roster: both members of broker one are visible, broker two's member is not
  select count(*) into n from public.broker_members;
  if n <> 2 then
    raise exception 'user 1: expected exactly 2 visible memberships (own broker roster), saw %', n;
  end if;
  if not exists (select 1 from public.broker_members where user_id = '00000000-0000-4000-8000-00000000a003') then
    raise exception 'user 1: cannot see the other member of own broker';
  end if;
  if exists (select 1 from public.broker_members where user_id = '00000000-0000-4000-8000-00000000a002') then
    raise exception 'user 1: can see broker two membership';
  end if;

  -- inserting a row for the other broker must be rejected by the with check clause
  begin
    insert into public.customers (broker_id, name)
      values ('00000000-0000-4000-8000-00000000b002', 'RLS Proof Sneaky Customer');
    raise exception 'user 1: inserted a customer for broker two; rls with check did not fire';
  exception
    when insufficient_privilege or check_violation then
      null;
  end;

  -- inserting a row for the own broker is allowed
  insert into public.customers (broker_id, name)
    values ('00000000-0000-4000-8000-00000000b001', 'RLS Proof Own Customer');
  select count(*) into n from public.customers;
  if n <> 2 then
    raise exception 'user 1: expected 2 visible customers after own insert, saw %', n;
  end if;

  -- catalog: the shared item is visible, and (AC-4.4) a user can add an item
  if not exists (select 1 from public.catalog_items where id = '00000000-0000-4000-8000-00000000e001') then
    raise exception 'user 1: cannot see shared catalog item';
  end if;
  insert into public.catalog_items (category, designation)
    values ('hss_square', 'RLSPROOF-ADDED-BY-USER-ONE');
  select count(*) into n from public.catalog_items where designation like 'RLSPROOF-%';
  if n <> 2 then
    raise exception 'user 1: expected 2 visible catalog items after own insert, saw %', n;
  end if;

  -- seed aliases (broker_id null) are readable by every authenticated user
  if not exists (select 1 from public.catalog_aliases where alias = 'rlsproof seed alias') then
    raise exception 'user 1: cannot see seed alias';
  end if;

  -- a learned alias must carry the broker id; a null broker_id insert is rejected
  begin
    insert into public.catalog_aliases (broker_id, catalog_item_id, alias, source)
      values (null, '00000000-0000-4000-8000-00000000e001', 'rlsproof global alias', 'learned');
    raise exception 'user 1: inserted a global catalog alias; rls with check did not fire';
  exception
    when insufficient_privilege or check_violation then
      null;
  end;
  insert into public.catalog_aliases (broker_id, catalog_item_id, alias, source)
    values ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000e001', 'rlsproof learned alias', 'learned');
  if not exists (select 1 from public.catalog_aliases where alias = 'rlsproof learned alias') then
    raise exception 'user 1: cannot see own learned alias';
  end if;

  -- parent/child: a line on the own request is fine
  insert into public.request_lines (broker_id, request_id, line_no, raw_text, description, confidence)
    values ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000f001', 2, 'rls proof line 2', 'rls proof line 2', 1);
  select count(*) into n from public.request_lines where request_id = '00000000-0000-4000-8000-00000000f001';
  if n <> 2 then
    raise exception 'user 1: expected 2 visible lines on own request, saw %', n;
  end if;

  -- parent/child: a line carrying the own broker_id but pointing at broker two's request
  -- passes the with check and must still be rejected by the composite foreign key
  begin
    insert into public.request_lines (broker_id, request_id, line_no, raw_text, description, confidence)
      values ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000f002', 1, 'x', 'x', 1);
    raise exception 'user 1: attached a line to broker two''s request; composite fk did not fire';
  exception
    when foreign_key_violation then
      null;
  end;

  -- activity_log: insert is allowed, update and delete are not
  insert into public.activity_log (broker_id, entity_type, entity_id, action)
    values ('00000000-0000-4000-8000-00000000b001', 'request', '00000000-0000-4000-8000-00000000f001', 'rls_proof_user_one');
  if not exists (select 1 from public.activity_log where action = 'rls_proof_user_one') then
    raise exception 'user 1: cannot read own audit row';
  end if;
  begin
    update public.activity_log set action = 'tampered' where action = 'rls_proof_user_one';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'user 1: updated % own audit row(s); activity_log is not append-only', n;
    end if;
  exception
    when insufficient_privilege then
      null;
  end;
  begin
    delete from public.activity_log where action = 'rls_proof_user_one';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'user 1: deleted % own audit row(s); activity_log is not append-only', n;
    end if;
  exception
    when insufficient_privilege then
      null;
  end;
  if not exists (select 1 from public.activity_log where action = 'rls_proof_user_one') then
    raise exception 'user 1: own audit row is gone after a delete attempt';
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- user 2 (member of broker two)
-- ---------------------------------------------------------------------------

set local role authenticated;

do $$
declare
  n integer;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a002', true);

  select count(*) into n from public.customers;
  if n <> 1 then
    raise exception 'user 2: expected exactly 1 visible customer, saw %', n;
  end if;
  if not exists (select 1 from public.customers where id = '00000000-0000-4000-8000-00000000c002') then
    raise exception 'user 2: cannot see own customer';
  end if;
  if exists (select 1 from public.customers where id = '00000000-0000-4000-8000-00000000c001') then
    raise exception 'user 2: can see broker one customer';
  end if;

  select count(*) into n from public.vendors;
  if n <> 1 then
    raise exception 'user 2: expected exactly 1 visible vendor, saw %', n;
  end if;
  if not exists (select 1 from public.vendors where id = '00000000-0000-4000-8000-00000000d002') then
    raise exception 'user 2: cannot see own vendor';
  end if;
  if exists (select 1 from public.vendors where id = '00000000-0000-4000-8000-00000000d001') then
    raise exception 'user 2: can see broker one vendor';
  end if;

  select count(*) into n from public.broker_members;
  if n <> 1 then
    raise exception 'user 2: expected exactly 1 visible membership, saw %', n;
  end if;
  if exists (select 1 from public.broker_members where broker_id = '00000000-0000-4000-8000-00000000b001') then
    raise exception 'user 2: can see broker one memberships';
  end if;

  begin
    insert into public.customers (broker_id, name)
      values ('00000000-0000-4000-8000-00000000b001', 'RLS Proof Sneaky Customer');
    raise exception 'user 2: inserted a customer for broker one; rls with check did not fire';
  exception
    when insufficient_privilege or check_violation then
      null;
  end;

  -- updating a row that belongs to broker one must touch nothing
  update public.customers set notes = 'tampered'
    where id = '00000000-0000-4000-8000-00000000c001';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'user 2: updated % row(s) belonging to broker one', n;
  end if;

  -- catalog: the shared master is visible in full, including the item user 1 just added
  select count(*) into n from public.catalog_items where designation like 'RLSPROOF-%';
  if n <> 2 then
    raise exception 'user 2: expected 2 visible catalog items (shared master), saw %', n;
  end if;
  if not exists (select 1 from public.catalog_items where id = '00000000-0000-4000-8000-00000000e001') then
    raise exception 'user 2: cannot see shared catalog item';
  end if;

  -- seed aliases are readable; broker one's learned alias is not
  if not exists (select 1 from public.catalog_aliases where alias = 'rlsproof seed alias') then
    raise exception 'user 2: cannot see seed alias';
  end if;
  if exists (select 1 from public.catalog_aliases where alias = 'rlsproof learned alias') then
    raise exception 'user 2: can see broker one learned alias';
  end if;

  -- parent/child: broker one's request and lines are invisible
  if exists (select 1 from public.requests where id = '00000000-0000-4000-8000-00000000f001') then
    raise exception 'user 2: can see broker one request';
  end if;
  select count(*) into n from public.request_lines;
  if n <> 0 then
    raise exception 'user 2: expected 0 visible request lines, saw %', n;
  end if;

  -- parent/child: a line carrying broker two's id but pointing at broker one's request
  -- passes the with check and must be rejected by the composite foreign key
  begin
    insert into public.request_lines (broker_id, request_id, line_no, raw_text, description, confidence)
      values ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000f001', 1, 'x', 'x', 1);
    raise exception 'user 2: attached a line to broker one''s request; composite fk did not fire';
  exception
    when foreign_key_violation then
      null;
  end;

  -- parent/child: a line carrying broker one's id is rejected by the with check first
  begin
    insert into public.request_lines (broker_id, request_id, line_no, raw_text, description, confidence)
      values ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000f001', 1, 'x', 'x', 1);
    raise exception 'user 2: inserted a line for broker one; rls with check did not fire';
  exception
    when insufficient_privilege or check_violation then
      null;
  end;

  -- parent/child: a line on the own request is fine
  insert into public.request_lines (broker_id, request_id, line_no, raw_text, description, confidence)
    values ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000f002', 1, 'rls proof line', 'rls proof line', 1);
  select count(*) into n from public.request_lines;
  if n <> 1 then
    raise exception 'user 2: expected 1 visible request line after own insert, saw %', n;
  end if;

  -- activity_log: broker one's audit row cannot be rewritten or erased
  begin
    update public.activity_log set action = 'tampered'
      where id = '00000000-0000-4000-8000-00000000f201';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'user 2: updated % audit row(s) belonging to broker one', n;
    end if;
  exception
    when insufficient_privilege then
      null;
  end;
  begin
    delete from public.activity_log where id = '00000000-0000-4000-8000-00000000f201';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'user 2: deleted % audit row(s) belonging to broker one', n;
    end if;
  exception
    when insufficient_privilege then
      null;
  end;
end;
$$;

reset role;

-- the fixture audit row is untouched after both tamper attempts (checked as postgres)
do $$
begin
  if not exists (
    select 1 from public.activity_log
    where id = '00000000-0000-4000-8000-00000000f201' and action = 'rls_proof_fixture'
  ) then
    raise exception 'activity_log fixture row was changed or removed by an app user';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- anon (no policies, must see nothing)
-- ---------------------------------------------------------------------------

set local role anon;

do $$
declare
  n integer;
begin
  perform set_config('request.jwt.claim.sub', '', true);

  select count(*) into n from public.customers;
  if n <> 0 then
    raise exception 'anon: expected 0 visible customers, saw %', n;
  end if;
  select count(*) into n from public.vendors;
  if n <> 0 then
    raise exception 'anon: expected 0 visible vendors, saw %', n;
  end if;
  select count(*) into n from public.brokers;
  if n <> 0 then
    raise exception 'anon: expected 0 visible brokers, saw %', n;
  end if;
  select count(*) into n from public.broker_members;
  if n <> 0 then
    raise exception 'anon: expected 0 visible broker_members, saw %', n;
  end if;
  select count(*) into n from public.catalog_items;
  if n <> 0 then
    raise exception 'anon: expected 0 visible catalog items, saw %', n;
  end if;
  select count(*) into n from public.catalog_aliases;
  if n <> 0 then
    raise exception 'anon: expected 0 visible catalog aliases, saw %', n;
  end if;
  select count(*) into n from public.activity_log;
  if n <> 0 then
    raise exception 'anon: expected 0 visible activity_log rows, saw %', n;
  end if;
end;
$$;

reset role;

do $$
begin
  raise notice 'rls proof: all assertions passed';
end;
$$;

rollback;

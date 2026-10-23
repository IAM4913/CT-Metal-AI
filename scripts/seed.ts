// Seed a Supabase project for the Phase 1 demo.
//
//   npm run seed            (tsx scripts/seed.ts)
//
// Creates, if missing: the broker, the login user and its owner membership,
// the two demo customers with contacts, the example vendors with branches,
// contacts, and capabilities (scripts/seed-data.ts), the catalog items and
// their seed aliases (src/lib/catalog/generate.ts), and the private
// "attachments" storage bucket.
//
// Idempotent: run it twice and the second run inserts nothing new. The only
// rows rewritten on every run are catalog items (upsert by designation, so a
// corrected weight or dims reaches the database) and seed aliases (deleted and
// reinserted as a set, so a removed alias disappears). Learned aliases
// (source = learned) are never touched.
//
// Uses the admin client built directly with @supabase/supabase-js and
// SUPABASE_SECRET_KEY. It does not import src/lib/db/client.ts because that
// module loads next/headers, which cannot run outside Next.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateCatalog } from "@/lib/catalog/generate";
import type { Database, TablesInsert } from "@/lib/db/types";
import { SEED_BROKER_NAME, SEED_CUSTOMERS, SEED_VENDORS } from "./seed-data";
import { placeholderWarning, resolveSeedLogin, type SeedLogin } from "./seed-env";

type Db = SupabaseClient<Database>;

const BUCKET = "attachments";
const ITEM_CHUNK = 200;
const ALIAS_CHUNK = 500;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Failure = {
  message: string;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
};

function describe(step: string, error: Failure): string {
  const extra = [error.code, error.details, error.hint].filter((x) => x).join("; ");
  return `${step}: ${error.message}${extra ? ` (${extra})` : ""}`;
}

/** Throw on an error result; for calls that return no rows (insert, delete). */
function check(step: string, res: { error: Failure | null }): void {
  if (res.error) {
    throw new Error(describe(step, res.error));
  }
}

/** Throw on an error or missing data; returns the data. */
function must<T>(step: string, res: { data: T; error: Failure | null }): NonNullable<T> {
  if (res.error) {
    throw new Error(describe(step, res.error));
  }
  if (res.data === null || res.data === undefined) {
    throw new Error(`${step}: no data returned`);
  }
  return res.data;
}

function lookup<V>(map: Map<string, V>, key: string, what: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`${what} ${JSON.stringify(key)} was not found after insert`);
  }
  return value;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

type Counts = { total: number; created: number };

function fmt(c: Counts): string {
  return `${c.total} (+${c.created})`;
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

type SeedEnv = {
  url: string;
  secretKey: string;
  login: SeedLogin;
};

function loadEnv(): SeedEnv {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local in the working directory. Fine when the variables are
    // already exported (CI, Vercel shell).
  }
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const secretKey = requireEnv("SUPABASE_SECRET_KEY");
  // Unset, blank, or equal to the committed .env.local.example value all count
  // as the placeholder login (scripts/seed-env.ts); main() warns about it.
  return { url, secretKey, login: resolveSeedLogin(process.env) };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.local.example to .env.local and fill it in (see SETUP.md).`,
    );
  }
  return value.trim();
}

// ---------------------------------------------------------------------------
// Broker and user
// ---------------------------------------------------------------------------

async function ensureBroker(db: Db): Promise<{ id: string; created: boolean }> {
  const found = must(
    "select brokers",
    await db.from("brokers").select("id").eq("name", SEED_BROKER_NAME).limit(1),
  );
  if (found.length > 0) {
    return { id: found[0].id, created: false };
  }
  const inserted = must(
    "insert brokers",
    await db.from("brokers").insert({ name: SEED_BROKER_NAME }).select("id").single(),
  );
  return { id: inserted.id, created: true };
}

function isAlreadyRegistered(error: { message: string; status?: number; code?: string }): boolean {
  if (error.code === "email_exists" || error.code === "user_already_exists") {
    return true;
  }
  if (/already (been )?registered|already exists/i.test(error.message)) {
    return true;
  }
  // GoTrue answers 422 for a duplicate email; other 422s (weak password) carry
  // their own code, which the first check would have missed on purpose.
  return error.status === 422 && error.code === undefined;
}

async function findUserIdByEmail(db: Db, email: string): Promise<string | null> {
  const wanted = email.toLowerCase();
  const perPage = 200;
  let page = 1;
  for (;;) {
    const res = await db.auth.admin.listUsers({ page, perPage });
    if (res.error) {
      throw new Error(describe(`auth.admin.listUsers page ${page}`, res.error));
    }
    const hit = res.data.users.find((u) => (u.email ?? "").toLowerCase() === wanted);
    if (hit) {
      return hit.id;
    }
    const next = res.data.nextPage;
    if (next === null || next <= page || res.data.users.length === 0) {
      return null;
    }
    page = next;
  }
}

async function ensureUser(
  db: Db,
  email: string,
  password: string,
): Promise<{ id: string; created: boolean }> {
  const res = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (!res.error) {
    return { id: res.data.user.id, created: true };
  }
  if (!isAlreadyRegistered(res.error)) {
    throw new Error(describe("auth.admin.createUser", res.error));
  }
  const id = await findUserIdByEmail(db, email);
  if (id === null) {
    throw new Error(
      `auth.admin.createUser said ${email} is already registered, but listUsers did not return it`,
    );
  }
  return { id, created: false };
}

async function ensureMembership(db: Db, brokerId: string, userId: string): Promise<void> {
  const row: TablesInsert<"broker_members"> = { broker_id: brokerId, user_id: userId, role: "owner" };
  // unique (broker_id, user_id) in 0001_init.sql
  check(
    "upsert broker_members",
    await db.from("broker_members").upsert(row, { onConflict: "broker_id,user_id" }),
  );
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

async function seedCustomers(
  db: Db,
  brokerId: string,
): Promise<{ customers: Counts; contacts: Counts }> {
  const existing = must(
    "select customers",
    await db.from("customers").select("id,name").eq("broker_id", brokerId),
  );
  const idByName = new Map(existing.map((c) => [c.name, c.id]));

  const missing: TablesInsert<"customers">[] = SEED_CUSTOMERS.filter(
    (c) => !idByName.has(c.name),
  ).map((c) => ({
    broker_id: brokerId,
    name: c.name,
    short_name: c.short_name,
    email_domain: c.email_domain,
    notes: c.notes,
  }));
  if (missing.length > 0) {
    const inserted = must(
      "insert customers",
      await db.from("customers").insert(missing).select("id,name"),
    );
    for (const c of inserted) {
      idByName.set(c.name, c.id);
    }
  }

  const existingContacts = must(
    "select customer_contacts",
    await db.from("customer_contacts").select("customer_id,email").eq("broker_id", brokerId),
  );
  const contactKeys = new Set(existingContacts.map((k) => `${k.customer_id}|${k.email.toLowerCase()}`));
  const contactRows: TablesInsert<"customer_contacts">[] = [];
  let contactTotal = 0;
  for (const c of SEED_CUSTOMERS) {
    const customerId = lookup(idByName, c.name, "customer");
    for (const k of c.contacts) {
      contactTotal += 1;
      if (contactKeys.has(`${customerId}|${k.email.toLowerCase()}`)) {
        continue;
      }
      contactRows.push({
        broker_id: brokerId,
        customer_id: customerId,
        name: k.name,
        email: k.email,
        phone: k.phone,
      });
    }
  }
  if (contactRows.length > 0) {
    check("insert customer_contacts", await db.from("customer_contacts").insert(contactRows));
  }

  return {
    customers: { total: SEED_CUSTOMERS.length, created: missing.length },
    contacts: { total: contactTotal, created: contactRows.length },
  };
}

// ---------------------------------------------------------------------------
// Vendors, branches, contacts, capabilities
// ---------------------------------------------------------------------------

type VendorCounts = {
  vendors: Counts;
  branches: Counts;
  contacts: Counts;
  capabilities: Counts;
};

async function seedVendors(db: Db, brokerId: string): Promise<VendorCounts> {
  // Vendors, matched by (broker_id, name).
  const existingVendors = must(
    "select vendors",
    await db.from("vendors").select("id,name").eq("broker_id", brokerId),
  );
  const vendorIdByName = new Map(existingVendors.map((v) => [v.name, v.id]));
  const vendorRows: TablesInsert<"vendors">[] = SEED_VENDORS.filter(
    (v) => !vendorIdByName.has(v.name),
  ).map((v) => ({
    broker_id: brokerId,
    name: v.name,
    vendor_type: v.vendor_type,
    website: v.website,
    notes: v.notes,
  }));
  if (vendorRows.length > 0) {
    const inserted = must("insert vendors", await db.from("vendors").insert(vendorRows).select("id,name"));
    for (const v of inserted) {
      vendorIdByName.set(v.name, v.id);
    }
  }

  // Branches, matched by (vendor_id, name).
  const existingBranches = must(
    "select vendor_branches",
    await db.from("vendor_branches").select("id,vendor_id,name").eq("broker_id", brokerId),
  );
  const branchKey = (vendorId: string, name: string) => `${vendorId}|${name}`;
  const branchIdByKey = new Map(existingBranches.map((b) => [branchKey(b.vendor_id, b.name), b.id]));
  const branchRows: TablesInsert<"vendor_branches">[] = [];
  let branchTotal = 0;
  for (const v of SEED_VENDORS) {
    const vendorId = lookup(vendorIdByName, v.name, "vendor");
    for (const b of v.branches) {
      branchTotal += 1;
      if (branchIdByKey.has(branchKey(vendorId, b.name))) {
        continue;
      }
      branchRows.push({
        broker_id: brokerId,
        vendor_id: vendorId,
        name: b.name,
        city: b.city,
        state: b.state,
        region: b.region,
        preferred: b.preferred,
        payment_terms: b.payment_terms,
        early_pay_pct: b.early_pay_pct,
        early_pay_days: b.early_pay_days,
        freight_default: b.freight_default,
        notes: b.notes,
      });
    }
  }
  if (branchRows.length > 0) {
    const inserted = must(
      "insert vendor_branches",
      await db.from("vendor_branches").insert(branchRows).select("id,vendor_id,name"),
    );
    for (const b of inserted) {
      branchIdByKey.set(branchKey(b.vendor_id, b.name), b.id);
    }
  }

  // Contacts, matched by (branch_id, email).
  const existingContacts = must(
    "select vendor_contacts",
    await db.from("vendor_contacts").select("branch_id,email").eq("broker_id", brokerId),
  );
  const contactKeys = new Set(existingContacts.map((k) => `${k.branch_id}|${k.email.toLowerCase()}`));
  const contactRows: TablesInsert<"vendor_contacts">[] = [];
  let contactTotal = 0;

  // Capabilities, matched by (branch_id, category).
  const existingCaps = must(
    "select vendor_capabilities",
    await db.from("vendor_capabilities").select("branch_id,category").eq("broker_id", brokerId),
  );
  const capKeys = new Set(existingCaps.map((c) => `${c.branch_id}|${c.category}`));
  const capRows: TablesInsert<"vendor_capabilities">[] = [];
  let capTotal = 0;

  for (const v of SEED_VENDORS) {
    const vendorId = lookup(vendorIdByName, v.name, "vendor");
    for (const b of v.branches) {
      const branchId = lookup(branchIdByKey, branchKey(vendorId, b.name), "branch");
      for (const k of b.contacts) {
        contactTotal += 1;
        if (contactKeys.has(`${branchId}|${k.email.toLowerCase()}`)) {
          continue;
        }
        contactRows.push({
          broker_id: brokerId,
          branch_id: branchId,
          name: k.name,
          email: k.email,
          phone: k.phone,
          is_primary: k.is_primary,
          notes: k.notes,
        });
      }
      for (const category of b.capabilities) {
        capTotal += 1;
        if (capKeys.has(`${branchId}|${category}`)) {
          continue;
        }
        capRows.push({ broker_id: brokerId, branch_id: branchId, category });
      }
    }
  }

  if (contactRows.length > 0) {
    check("insert vendor_contacts", await db.from("vendor_contacts").insert(contactRows));
  }
  if (capRows.length > 0) {
    // unique (branch_id, category) in 0001_init.sql. ignoreDuplicates makes it
    // "on conflict do nothing", so a concurrent or repeated run cannot fail here.
    check(
      "upsert vendor_capabilities",
      await db
        .from("vendor_capabilities")
        .upsert(capRows, { onConflict: "branch_id,category", ignoreDuplicates: true }),
    );
  }

  return {
    vendors: { total: SEED_VENDORS.length, created: vendorRows.length },
    branches: { total: branchTotal, created: branchRows.length },
    contacts: { total: contactTotal, created: contactRows.length },
    capabilities: { total: capTotal, created: capRows.length },
  };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

async function seedCatalog(db: Db): Promise<{ items: number; aliases: number }> {
  const items = generateCatalog();

  const designations = new Set<string>();
  for (const item of items) {
    if (designations.has(item.designation)) {
      throw new Error(`generateCatalog produced a duplicate designation: ${item.designation}`);
    }
    designations.add(item.designation);
  }

  // Items: upsert by designation (unique in 0001_init.sql). Only the reference
  // columns are written; id and timestamps stay with the row.
  const idByDesignation = new Map<string, string>();
  for (const chunk of chunks(items, ITEM_CHUNK)) {
    const rows: TablesInsert<"catalog_items">[] = chunk.map((item) => ({
      category: item.category,
      designation: item.designation,
      dims: item.dims,
      weight_per_ft: item.weight_per_ft,
      default_grade: item.default_grade,
    }));
    const returned = must(
      "upsert catalog_items",
      await db.from("catalog_items").upsert(rows, { onConflict: "designation" }).select("id,designation"),
    );
    for (const row of returned) {
      idByDesignation.set(row.designation, row.id);
    }
  }

  // Aliases: replace the whole seed set. Learned aliases carry source = learned
  // and a broker_id, and are left alone. The unique constraint is
  // (catalog_item_id, alias, broker_id) with nulls not distinct, so the pairs
  // are deduped here before insert.
  check("delete seed catalog_aliases", await db.from("catalog_aliases").delete().eq("source", "seed"));

  const aliasRows: TablesInsert<"catalog_aliases">[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const itemId = lookup(idByDesignation, item.designation, "catalog item");
    for (const alias of item.aliases) {
      if (alias.trim() === "") {
        continue;
      }
      const key = `${itemId}|${alias}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      aliasRows.push({ catalog_item_id: itemId, alias, source: "seed", broker_id: null });
    }
  }
  for (const chunk of chunks(aliasRows, ALIAS_CHUNK)) {
    check("insert catalog_aliases", await db.from("catalog_aliases").insert(chunk));
  }

  return { items: idByDesignation.size, aliases: aliasRows.length };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function ensureBucket(db: Db): Promise<boolean> {
  const buckets = must("storage.listBuckets", await db.storage.listBuckets());
  if (buckets.some((b) => b.name === BUCKET)) {
    return false;
  }
  must("storage.createBucket", await db.storage.createBucket(BUCKET, { public: false }));
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = loadEnv();
  const warning = placeholderWarning(env.login);
  if (warning !== null) {
    console.warn(warning);
  }

  const db: Db = createClient<Database>(env.url, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const broker = await ensureBroker(db);
  const user = await ensureUser(db, env.login.userEmail, env.login.userPassword);
  await ensureMembership(db, broker.id, user.id);
  const customers = await seedCustomers(db, broker.id);
  const vendors = await seedVendors(db, broker.id);
  const catalog = await seedCatalog(db);
  const bucketCreated = await ensureBucket(db);

  const state = (created: boolean) => (created ? "created" : "existing");
  console.log(
    [
      `seed ok:`,
      `broker ${JSON.stringify(SEED_BROKER_NAME)} ${state(broker.created)},`,
      `user ${env.login.userEmail} ${state(user.created)} with owner membership,`,
      `customers ${fmt(customers.customers)}, customer contacts ${fmt(customers.contacts)},`,
      `vendors ${fmt(vendors.vendors)}, branches ${fmt(vendors.branches)},`,
      `vendor contacts ${fmt(vendors.contacts)}, capabilities ${fmt(vendors.capabilities)},`,
      `catalog items ${catalog.items}, seed aliases ${catalog.aliases},`,
      `bucket ${BUCKET} ${state(bucketCreated)}`,
    ].join(" "),
  );
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

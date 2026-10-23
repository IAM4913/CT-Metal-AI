// Checks on the pure seed data in scripts/seed-data.ts. No database needed.
//
// These guard the things scripts/seed.ts and the routing step (PLAN Step 5)
// rely on: one primary contact per branch, placeholder emails only, the
// "verify" marker on every vendor-side note, and enough branch coverage for
// the fixture requests to route to several vendors.

import { describe, expect, it } from "vitest";
import { materialCategoryValues, type MaterialCategory } from "@/lib/db/enums";
import {
  EXAMPLE_NOTE,
  MIXED_LIST_CATEGORIES,
  PDF_LIST_CATEGORIES,
  SEED_BROKER_NAME,
  SEED_CUSTOMERS,
  SEED_VENDORS,
  branchesFor,
  type SeedBranch,
  type SeedContact,
} from "./seed-data";

const allBranches: SeedBranch[] = SEED_VENDORS.flatMap((v) => v.branches);
const allContacts: SeedContact[] = allBranches.flatMap((b) => b.contacts);

/** Every free-text string in the file; used to enforce the no-em-dash rule. */
function allStrings(): string[] {
  const out: string[] = [SEED_BROKER_NAME, EXAMPLE_NOTE];
  for (const c of SEED_CUSTOMERS) {
    out.push(c.name, c.short_name, c.email_domain, c.notes);
    for (const k of c.contacts) out.push(k.name, k.email, k.phone);
  }
  for (const v of SEED_VENDORS) {
    out.push(v.name, v.notes, v.website ?? "");
    for (const b of v.branches) {
      out.push(b.name, b.city, b.state, b.region ?? "", b.payment_terms ?? "", b.notes);
      for (const k of b.contacts) out.push(k.name, k.email, k.phone ?? "", k.notes);
    }
  }
  return out;
}

describe("seed broker and customers", () => {
  it("names the broker per PRD section 14", () => {
    expect(SEED_BROKER_NAME).toBe("Caleb's company (set name)");
  });

  it("has the two fixture customers with their contacts", () => {
    const byName = new Map(SEED_CUSTOMERS.map((c) => [c.name, c]));
    const loneStar = byName.get("Lone Star Fabrication");
    const brazos = byName.get("Brazos Valley Fabricators");
    expect(loneStar?.short_name).toBe("Lone Star");
    expect(loneStar?.email_domain).toBe("lonestarfab.example.com");
    expect(loneStar?.contacts.map((k) => k.email)).toEqual(["dale@lonestarfab.example.com"]);
    expect(brazos?.short_name).toBe("Brazos");
    expect(brazos?.email_domain).toBe("brazosfab.example.com");
    expect(brazos?.contacts.map((k) => k.email)).toEqual(["rita@brazosfab.example.com"]);
  });

  it("uses example.com domains for every customer email", () => {
    for (const c of SEED_CUSTOMERS) {
      expect(c.email_domain.endsWith(".example.com")).toBe(true);
      for (const k of c.contacts) {
        expect(k.email.endsWith(`@${c.email_domain}`)).toBe(true);
      }
    }
  });
});

describe("seed vendors", () => {
  it("covers every vendor named in PRD section 14", () => {
    const names = SEED_VENDORS.map((v) => v.name);
    for (const expected of [
      "Gerdau",
      "Bull Moose",
      "Nucor Tubular",
      "Delta Steel",
      "Morgan Steel",
      "Triad Metals",
      "Norfolk Iron & Metal",
      "Ryerson",
      "Metals USA",
      "Alro",
      "Infra-Metals",
      "JMS / Russel Metals",
      "Phoenix Metals",
      "O'Neal Steel",
    ]) {
      expect(names).toContain(expected);
    }
    expect(SEED_VENDORS.length).toBe(14);
  });

  it("has unique vendor names", () => {
    const names = SEED_VENDORS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("types mills and service centers as in PRD section 14", () => {
    const type = (name: string) => SEED_VENDORS.find((v) => v.name === name)?.vendor_type;
    expect(type("Gerdau")).toBe("mill");
    expect(type("Bull Moose")).toBe("mill");
    expect(type("Nucor Tubular")).toBe("mill");
    expect(type("Delta Steel")).toBe("service_center");
    expect(type("O'Neal Steel")).toBe("service_center");
  });

  it("gives every vendor at least one branch with unique branch names", () => {
    for (const v of SEED_VENDORS) {
      expect(v.branches.length, v.name).toBeGreaterThanOrEqual(1);
      expect(v.branches.length, v.name).toBeLessThanOrEqual(2);
    }
    const branchNames = allBranches.map((b) => b.name);
    expect(new Set(branchNames).size).toBe(branchNames.length);
  });

  it("gives every branch exactly one primary contact and at least one capability", () => {
    for (const b of allBranches) {
      const primaries = b.contacts.filter((k) => k.is_primary);
      expect(primaries.length, b.name).toBe(1);
      expect(b.capabilities.length, b.name).toBeGreaterThanOrEqual(1);
      expect(new Set(b.capabilities).size, b.name).toBe(b.capabilities.length);
    }
  });

  it("uses only @example.com contact emails", () => {
    expect(allContacts.length).toBeGreaterThan(0);
    for (const k of allContacts) {
      expect(k.email.endsWith("@example.com"), k.email).toBe(true);
      expect(k.email).toBe(k.email.toLowerCase());
    }
    const emails = allContacts.map((k) => k.email);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("marks every vendor, branch, and contact note as an example to verify", () => {
    for (const v of SEED_VENDORS) {
      expect(v.notes, v.name).toContain(EXAMPLE_NOTE);
      for (const b of v.branches) {
        expect(b.notes, b.name).toContain(EXAMPLE_NOTE);
        for (const k of b.contacts) {
          expect(k.notes, k.email).toContain(EXAMPLE_NOTE);
        }
      }
    }
  });

  it("carries the two vendor-specific notes from PRD section 14", () => {
    const nucor = SEED_VENDORS.find((v) => v.name === "Nucor Tubular");
    const oneal = SEED_VENDORS.find((v) => v.name === "O'Neal Steel");
    expect(nucor?.notes).toContain("accessed via a partner's account");
    expect(oneal?.notes).toContain("has Pronto portal, pricing access removed");
  });

  it("has Marcus Reed as the primary contact at Delta Steel Houston", () => {
    const houston = allBranches.find((b) => b.name === "Delta Steel Houston");
    expect(houston?.city).toBe("Houston");
    expect(houston?.state).toBe("TX");
    expect(houston?.preferred).toBe(true);
    const primary = houston?.contacts.find((k) => k.is_primary);
    expect(primary?.name).toBe("Marcus Reed");
    expect(primary?.email).toBe("marcus.reed@example.com");
  });

  it("keeps early-pay fields consistent with each other", () => {
    for (const b of allBranches) {
      const hasPct = b.early_pay_pct !== null;
      const hasDays = b.early_pay_days !== null;
      expect(hasPct, b.name).toBe(hasDays);
      if (b.early_pay_pct !== null) {
        expect(b.early_pay_pct).toBeGreaterThan(0);
        expect(b.early_pay_pct).toBeLessThan(10);
      }
      if (b.early_pay_days !== null) {
        expect(b.early_pay_days).toBeGreaterThan(0);
      }
    }
    const withEarlyPay = allBranches.filter((b) => b.early_pay_pct !== null);
    expect(withEarlyPay.length).toBeGreaterThanOrEqual(1);
  });

  it("uses a mix of freight defaults", () => {
    const defaults = new Set(allBranches.map((b) => b.freight_default));
    expect(defaults.has("quoted")).toBe(true);
    expect(defaults.has("arranged")).toBe(true);
    expect(defaults.has("fob")).toBe(true);
  });

  it("uses https URLs for websites when present", () => {
    for (const v of SEED_VENDORS) {
      if (v.website !== null) {
        expect(v.website, v.name).toMatch(/^https:\/\/[a-z0-9.-]+(\/.*)?$/);
      }
    }
  });

  it("has at least one preferred branch", () => {
    expect(allBranches.some((b) => b.preferred)).toBe(true);
  });
});

describe("seed capability coverage", () => {
  it("routes each mixed-list category to at least three distinct branches", () => {
    for (const category of MIXED_LIST_CATEGORIES) {
      const branches = branchesFor(category);
      expect(new Set(branches).size, category).toBeGreaterThanOrEqual(3);
    }
  });

  it("has at least one branch for each pdf-list category", () => {
    for (const category of PDF_LIST_CATEGORIES) {
      expect(branchesFor(category).length, category).toBeGreaterThanOrEqual(1);
    }
  });

  it("covers every material_category enum value with at least one branch", () => {
    for (const category of materialCategoryValues) {
      expect(branchesFor(category).length, category).toBeGreaterThanOrEqual(1);
    }
  });

  it("only uses categories from the enum", () => {
    const allowed = new Set<string>(materialCategoryValues);
    for (const b of allBranches) {
      for (const c of b.capabilities) {
        expect(allowed.has(c), `${b.name}: ${c}`).toBe(true);
      }
    }
  });

  it("keeps the structural mill on long products and the tube mills on HSS", () => {
    const gerdau = branchesFor("rebar");
    expect(gerdau).toEqual(["Gerdau Midlothian"]);
    const hssRound: MaterialCategory = "hss_round";
    for (const name of ["Bull Moose Gerald", "Nucor Tubular Decatur"]) {
      expect(branchesFor(hssRound)).toContain(name);
    }
  });
});

describe("seed text hygiene", () => {
  it("contains no em dashes anywhere", () => {
    for (const s of allStrings()) {
      expect(s.includes(String.fromCharCode(0x2014)), s).toBe(false);
    }
  });

  it("has no empty names, cities, or states", () => {
    for (const v of SEED_VENDORS) {
      expect(v.name.trim()).not.toBe("");
      for (const b of v.branches) {
        expect(b.name.trim()).not.toBe("");
        expect(b.city.trim()).not.toBe("");
        expect(b.state).toMatch(/^[A-Z]{2}$/);
        for (const k of b.contacts) {
          expect(k.name.trim()).not.toBe("");
        }
      }
    }
  });
});

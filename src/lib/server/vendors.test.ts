// Pure parts of the vendor admin: the form schemas that turn posted strings
// into typed input, the list summary, the capability diff, the history counts,
// and the notes excerpt. The database paths are type-checked only.

import { describe, expect, it } from "vitest";
import {
  branchFormSchema,
  capabilitiesFormSchema,
  capabilityDiff,
  contactFormSchema,
  countByBranch,
  excerpt,
  summarizeVendors,
  vendorFormSchema,
  VendorInUseError,
} from "./vendors";

describe("vendorFormSchema", () => {
  it("accepts a filled form and trims the text fields", () => {
    const parsed = vendorFormSchema.parse({
      name: "  Delta Steel  ",
      vendor_type: "service_center",
      website: " https://delta.example ",
      notes: " call before noon ",
    });
    expect(parsed).toEqual({
      name: "Delta Steel",
      vendor_type: "service_center",
      website: "https://delta.example",
      notes: "call before noon",
    });
  });

  it("maps a blank website to null and a missing notes field to an empty string", () => {
    const parsed = vendorFormSchema.parse({ name: "Delta", vendor_type: "mill", website: "", notes: null });
    expect(parsed.website).toBeNull();
    expect(parsed.notes).toBe("");
  });

  it("rejects a blank name and an unknown type", () => {
    expect(vendorFormSchema.safeParse({ name: "   ", vendor_type: "mill", website: null, notes: "" }).success).toBe(false);
    expect(vendorFormSchema.safeParse({ name: "Delta", vendor_type: "warehouse", website: null, notes: "" }).success).toBe(
      false,
    );
    expect(vendorFormSchema.safeParse({ name: null, vendor_type: "mill", website: null, notes: "" }).success).toBe(false);
  });
});

describe("branchFormSchema (plain form values in, typed terms out)", () => {
  const filled = {
    name: "Houston",
    city: "Houston",
    state: "TX",
    region: "Gulf",
    preferred: "on",
    payment_terms: "Net 30",
    early_pay_pct: "2",
    early_pay_days: "10",
    freight_default: "quoted",
    notes: "",
  };

  it("turns the checkbox into a boolean and the numbers into numbers", () => {
    const parsed = branchFormSchema.parse(filled);
    expect(parsed.preferred).toBe(true);
    expect(parsed.early_pay_pct).toBe(2);
    expect(parsed.early_pay_days).toBe(10);
    expect(parsed.freight_default).toBe("quoted");
    expect(parsed.notes).toBe("");
  });

  it("reads a missing checkbox as false and blank optional fields as null, never zero", () => {
    const parsed = branchFormSchema.parse({
      ...filled,
      preferred: null,
      region: "",
      payment_terms: "  ",
      early_pay_pct: "",
      early_pay_days: null,
    });
    expect(parsed.preferred).toBe(false);
    expect(parsed.region).toBeNull();
    expect(parsed.payment_terms).toBeNull();
    expect(parsed.early_pay_pct).toBeNull();
    expect(parsed.early_pay_days).toBeNull();
  });

  it("accepts a decimal percent and rejects values outside 0 to 100", () => {
    expect(branchFormSchema.parse({ ...filled, early_pay_pct: "1.5" }).early_pay_pct).toBe(1.5);
    expect(branchFormSchema.safeParse({ ...filled, early_pay_pct: "150" }).success).toBe(false);
    expect(branchFormSchema.safeParse({ ...filled, early_pay_pct: "-1" }).success).toBe(false);
    expect(branchFormSchema.safeParse({ ...filled, early_pay_pct: "two" }).success).toBe(false);
  });

  it("requires whole days", () => {
    expect(branchFormSchema.safeParse({ ...filled, early_pay_days: "10.5" }).success).toBe(false);
    expect(branchFormSchema.safeParse({ ...filled, early_pay_days: "abc" }).success).toBe(false);
  });

  it("requires name, city, and state and a known freight default", () => {
    expect(branchFormSchema.safeParse({ ...filled, name: "" }).success).toBe(false);
    expect(branchFormSchema.safeParse({ ...filled, city: null }).success).toBe(false);
    expect(branchFormSchema.safeParse({ ...filled, state: " " }).success).toBe(false);
    expect(branchFormSchema.safeParse({ ...filled, freight_default: "free" }).success).toBe(false);
    expect(branchFormSchema.safeParse({ ...filled, freight_default: null }).success).toBe(false);
  });
});

describe("contactFormSchema", () => {
  it("lowercases the email, trims the name, and reads the primary checkbox", () => {
    const parsed = contactFormSchema.parse({
      name: " Marcus Reed ",
      email: " Marcus.Reed@Example.com ",
      phone: "",
      is_primary: "on",
      notes: null,
    });
    expect(parsed).toEqual({
      name: "Marcus Reed",
      email: "marcus.reed@example.com",
      phone: null,
      is_primary: true,
      notes: "",
    });
  });

  it("rejects a blank or malformed email", () => {
    const base = { name: "Marcus", phone: null, is_primary: null, notes: "" };
    expect(contactFormSchema.safeParse({ ...base, email: "" }).success).toBe(false);
    expect(contactFormSchema.safeParse({ ...base, email: "marcus at example" }).success).toBe(false);
    expect(contactFormSchema.safeParse({ ...base, email: "marcus@example.com" }).success).toBe(true);
  });
});

describe("capabilitiesFormSchema", () => {
  it("dedupes the ticked categories and rejects unknown ones", () => {
    expect(capabilitiesFormSchema.parse(["plate", "angle", "plate"])).toEqual(["plate", "angle"]);
    expect(capabilitiesFormSchema.parse([])).toEqual([]);
    expect(capabilitiesFormSchema.safeParse(["plate", "widgets"]).success).toBe(false);
  });
});

describe("summarizeVendors", () => {
  it("counts branches and preferred branches per vendor and keeps the vendor order", () => {
    const vendors = [
      { id: "v1", name: "Alpha", vendor_type: "mill" as const, website: null, notes: "" },
      { id: "v2", name: "Beta", vendor_type: "service_center" as const, website: "https://b.example", notes: "x" },
      { id: "v3", name: "Gamma", vendor_type: "other" as const, website: null, notes: "" },
    ];
    const branches = [
      { vendor_id: "v1", preferred: true },
      { vendor_id: "v1", preferred: false },
      { vendor_id: "v2", preferred: true },
      { vendor_id: "v9", preferred: true },
    ];
    const rows = summarizeVendors(vendors, branches);
    expect(rows.map((row) => row.id)).toEqual(["v1", "v2", "v3"]);
    expect(rows[0]).toMatchObject({ branch_count: 2, preferred_count: 1 });
    expect(rows[1]).toMatchObject({ branch_count: 1, preferred_count: 1, website: "https://b.example" });
    expect(rows[2]).toMatchObject({ branch_count: 0, preferred_count: 0 });
  });
});

describe("capabilityDiff", () => {
  it("inserts what is newly wanted and deletes what is no longer wanted", () => {
    const diff = capabilityDiff(["plate", "angle", "channel"], ["channel", "pipe", "plate"]);
    expect(diff).toEqual({ toInsert: ["pipe"], toDelete: ["angle"] });
  });

  it("is empty when nothing changes, whatever the order", () => {
    expect(capabilityDiff(["plate", "angle"], ["angle", "plate"])).toEqual({ toInsert: [], toDelete: [] });
  });

  it("clears everything for an empty wanted list and adds everything to an empty branch", () => {
    expect(capabilityDiff(["plate", "angle"], [])).toEqual({ toInsert: [], toDelete: ["angle", "plate"] });
    expect(capabilityDiff([], ["w_beam", "angle"])).toEqual({ toInsert: ["angle", "w_beam"], toDelete: [] });
  });
});

describe("countByBranch", () => {
  it("counts rows per branch and reports zero for branches with none", () => {
    const counts = countByBranch(["b1", "b2", "b3"], [{ branch_id: "b1" }, { branch_id: "b1" }, { branch_id: "b3" }]);
    expect(counts.get("b1")).toBe(2);
    expect(counts.get("b2")).toBe(0);
    expect(counts.get("b3")).toBe(1);
  });
});

describe("excerpt", () => {
  it("returns the first non-blank line, cut with an ellipsis past the limit", () => {
    expect(excerpt("")).toBe("");
    expect(excerpt("\n\n  Fast on plate.  \nSecond line")).toBe("Fast on plate.");
    expect(excerpt("abcdefghij", 5)).toBe("abcde...");
    expect(excerpt("abcde", 5)).toBe("abcde");
  });
});

describe("VendorInUseError", () => {
  it("names the count and the kind in plain words", () => {
    expect(new VendorInUseError("vendor", 3).message).toBe(
      "This vendor has 3 RFQs or purchases on its branches and cannot be deleted.",
    );
    expect(new VendorInUseError("branch", 1).message).toBe("This branch has 1 RFQ or purchase and cannot be deleted.");
  });
});

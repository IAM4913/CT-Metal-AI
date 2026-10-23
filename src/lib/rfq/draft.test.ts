import { describe, expect, it } from "vitest";
import {
  assertRecipientIsolation,
  buildDraft,
  buildDrafts,
  firstName,
  idempotencyKey,
  pickRecipient,
  type DraftInput,
  type RfqDraft,
} from "./draft";
import type { RfqLineView } from "./templates";

const REQUEST = "11111111-1111-4111-8111-111111111111";
const NOW = new Date(2026, 9, 23, 9, 0);

function view(overrides: Partial<RfqLineView> = {}): RfqLineView {
  return {
    designation: "W12x26",
    raw_text: "W12x26 x 50' A992 qty 8",
    description: "W12x26",
    qty: 8,
    unit: "pcs",
    length_ft: 50,
    length_text: "50'",
    grade_spec: "A992",
    note: null,
    delivery_notes: null,
    ...overrides,
  };
}

const BEAM = view();
const ANGLE = view({ designation: "L2x2x1/4", qty: 40, length_ft: 20, length_text: "20'", grade_spec: null });
const PLATE = view({
  designation: "PL3/8",
  raw_text: "3/8 plate 48x96 qty 10 A36",
  description: "PL3/8",
  qty: 10,
  length_ft: null,
  length_text: null,
  grade_spec: "A36",
  dims: { t: 0.375, w: 48, l: 96 },
});
const TUBE = view({ designation: "HSS6x6x3/8", qty: 12, length_ft: 40, length_text: "40'", grade_spec: "A500" });

function input(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    request: { id: REQUEST, revision: 1, subject: "Material for Waco job", delivery_requirements: null },
    customer: { name: "Lone Star Fabrication", short_name: "Lone Star" },
    branch: { id: "delta-hou", name: "Delta Steel Houston", vendor_name: "Delta Steel" },
    contacts: [
      { email: "priya.natarajan@example.com", name: "Priya Natarajan", is_primary: false },
      { email: "marcus.reed@example.com", name: "Marcus Reed", is_primary: true },
    ],
    lines: [BEAM, ANGLE],
    includeCustomerName: false,
    senderName: "Caleb",
    now: NOW,
    ...overrides,
  };
}

describe("idempotencyKey (AC-8.2)", () => {
  it("is request id, branch id, revision joined by colons", () => {
    expect(idempotencyKey(REQUEST, "delta-hou", 1)).toBe(`${REQUEST}:delta-hou:1`);
    expect(idempotencyKey(REQUEST, "delta-hou", 2)).not.toBe(idempotencyKey(REQUEST, "delta-hou", 1));
  });
});

describe("pickRecipient and firstName", () => {
  it("picks the primary contact, else the first, else none", () => {
    expect(pickRecipient(input().contacts)?.email).toBe("marcus.reed@example.com");
    expect(pickRecipient([{ is_primary: false, email: "a" }, { is_primary: false, email: "b" }])?.email).toBe("a");
    expect(pickRecipient([])).toBeNull();
  });

  it("takes the first word of a name", () => {
    expect(firstName("Marcus Reed")).toBe("Marcus");
    expect(firstName("  Priya ")).toBe("Priya");
    expect(firstName("")).toBeNull();
    expect(firstName(null)).toBeNull();
  });
});

describe("buildDraft (AC-7.1, AC-7.2)", () => {
  it("addresses the primary contact and greets them by first name", () => {
    const draft = buildDraft(input());
    expect(draft.to_emails).toEqual(["marcus.reed@example.com"]);
    expect(draft.cc_emails).toEqual([]);
    expect(draft.body_text.split("\n")[0]).toBe("Hi Marcus,");
    expect(draft.branch_id).toBe("delta-hou");
    expect(draft.idempotency_key).toBe(`${REQUEST}:delta-hou:1`);
    expect(draft.include_customer_name).toBe(false);
  });

  it("falls back to the first contact when none is primary, and to nobody when there are no contacts", () => {
    const contacts = input().contacts.map((c) => ({ ...c, is_primary: false }));
    expect(buildDraft(input({ contacts })).to_emails).toEqual(["priya.natarajan@example.com"]);
    const empty = buildDraft(input({ contacts: [] }));
    expect(empty.to_emails).toEqual([]);
    expect(empty.body_text.split("\n")[0]).toBe("Hi,");
  });

  it("subject carries the customer short name and the item count", () => {
    expect(buildDraft(input()).subject).toBe("RFQ: Lone Star, 2 items, Oct 23, 2026");
    expect(buildDraft(input({ customer: null, lines: [BEAM] })).subject).toBe("RFQ: Material request, 1 item, Oct 23, 2026");
    expect(buildDraft(input({ customer: { name: "Acme", short_name: "" } })).subject).toBe(
      "RFQ: Material request, 2 items, Oct 23, 2026",
    );
  });

  it("names the customer in the body only when toggled on", () => {
    expect(buildDraft(input()).body_text).not.toContain("Lone Star Fabrication");
    const on = buildDraft(input({ includeCustomerName: true }));
    expect(on.include_customer_name).toBe(true);
    expect(on.body_text).toContain("Need pricing and availability on the below, for Lone Star Fabrication.");
  });

  it("carries only the branch's lines and the request's delivery requirements", () => {
    const draft = buildDraft(
      input({
        lines: [PLATE],
        request: { id: REQUEST, revision: 3, subject: null, delivery_requirements: "Deliver to the Waco job site" },
      }),
    );
    expect(draft.body_text).toContain("10 pcs PL3/8 48x96 A36");
    expect(draft.body_text).not.toContain("W12x26");
    expect(draft.body_text).toContain("Delivery: Deliver to the Waco job site");
    expect(draft.idempotency_key).toBe(`${REQUEST}:delta-hou:3`);
  });
});

describe("recipient isolation (AC-7.5)", () => {
  const branches = [
    {
      branch: { id: "delta-hou", name: "Delta Steel Houston", vendor_name: "Delta Steel" },
      contacts: [
        { email: "marcus.reed@example.com", name: "Marcus Reed", is_primary: true },
        { email: "priya.natarajan@example.com", name: "Priya Natarajan", is_primary: false },
      ],
      lines: [BEAM, ANGLE, PLATE],
    },
    {
      branch: { id: "morgan-tx", name: "Morgan Steel Texas", vendor_name: "Morgan Steel" },
      contacts: [{ email: "tina.lowe@example.com", name: "Tina Lowe", is_primary: true }],
      lines: [BEAM, PLATE],
    },
    {
      branch: { id: "bull-moose", name: "Bull Moose Gerald", vendor_name: "Bull Moose" },
      contacts: [{ email: "ray.ortiz@example.com", name: "Ray Ortiz", is_primary: true }],
      lines: [TUBE],
    },
  ];
  const contactsByBranch = new Map(
    branches.map((b) => [b.branch.id, [...b.contacts.map((c) => c.email), b.branch.vendor_name]]),
  );

  function drafts(): RfqDraft[] {
    return buildDrafts(branches.map((b) => input({ branch: b.branch, contacts: b.contacts, lines: b.lines })));
  }

  it("drafts for three branches with distinct contacts do not leak", () => {
    const built = drafts();
    expect(built).toHaveLength(3);
    expect(built.map((d) => d.to_emails)).toEqual([
      ["marcus.reed@example.com"],
      ["tina.lowe@example.com"],
      ["ray.ortiz@example.com"],
    ]);
    expect(assertRecipientIsolation(built, contactsByBranch)).toEqual({ ok: true, leaks: [] });
    // Each body holds only its own lines.
    expect(built[2].body_text).toContain("HSS6x6x3/8");
    expect(built[2].body_text).not.toContain("W12x26");
    expect(built[1].body_text).not.toContain("L2x2x1/4");
  });

  it("reports a draft that carries another branch's address", () => {
    const built = drafts();
    built[0] = { ...built[0], cc_emails: ["Tina.Lowe@example.com"] };
    const result = assertRecipientIsolation(built, contactsByBranch);
    expect(result.ok).toBe(false);
    expect(result.leaks).toHaveLength(1);
    // The leak names the registered contact, matched case-insensitively against the draft's spelling.
    expect(result.leaks[0]).toBe("RFQ for branch delta-hou addresses tina.lowe@example.com, which belongs to branch morgan-tx");
  });

  it("reports a draft whose body names another vendor", () => {
    const built = drafts();
    built[1] = { ...built[1], body_text: `${built[1].body_text}\nDelta Steel quoted lower last time.` };
    const result = assertRecipientIsolation(built, contactsByBranch);
    expect(result.ok).toBe(false);
    expect(result.leaks).toEqual([
      "RFQ for branch morgan-tx mentions Delta Steel, which belongs to branch delta-hou",
    ]);
  });

  it("does not count a vendor name two branches share as a leak", () => {
    const fortWorth = input({
      branch: { id: "delta-fw", name: "Delta Steel Fort Worth", vendor_name: "Delta Steel" },
      contacts: [{ email: "lee.park@example.com", name: "Lee Park", is_primary: true }],
      lines: [ANGLE],
    });
    const built = [...drafts(), buildDraft(fortWorth)];
    built[3] = { ...built[3], body_text: `${built[3].body_text}\nDelta Steel account 4417` };
    const map = new Map(contactsByBranch);
    map.set("delta-fw", ["lee.park@example.com", "Delta Steel"]);
    expect(assertRecipientIsolation(built, map).ok).toBe(true);
  });
});

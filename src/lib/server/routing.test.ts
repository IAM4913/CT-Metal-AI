import { describe, expect, it } from "vitest";
import type { Tables } from "@/lib/db/client";
import { rfqStatusValues } from "@/lib/db/enums";
import {
  DEFAULT_SENDER_NAME,
  EDITABLE_RFQ_STATUSES,
  groupLinksByRfq,
  pickGreetingContacts,
  RFQS_TAB_STATUSES,
  sameText,
  senderNameFor,
  SENT_RFQ_STATUSES,
  toRfqLineView,
} from "./routing";

describe("RFQS_TAB_STATUSES (the RFQs tab shows every RFQ of the revision)", () => {
  it("loads every RFQ that went out, so a history link to an answered RFQ lands on its card (AC-11.3)", () => {
    for (const status of SENT_RFQ_STATUSES) expect(RFQS_TAB_STATUSES).toContain(status);
    expect(RFQS_TAB_STATUSES).toContain("responded");
    expect(RFQS_TAB_STATUSES).toContain("declined");
    expect(RFQS_TAB_STATUSES).toContain("closed");
  });

  it("loads every editable draft", () => {
    for (const status of EDITABLE_RFQ_STATUSES) expect(RFQS_TAB_STATUSES).toContain(status);
  });

  it("covers every rfq status exactly once", () => {
    expect([...RFQS_TAB_STATUSES].sort()).toEqual([...rfqStatusValues].sort());
  });

  it("splits the statuses into editable and sent with none in both", () => {
    for (const status of EDITABLE_RFQ_STATUSES) expect(SENT_RFQ_STATUSES).not.toContain(status);
    for (const status of SENT_RFQ_STATUSES) expect(EDITABLE_RFQ_STATUSES).not.toContain(status);
  });
});

describe("senderNameFor (AC-7.2, the sign-off is a person)", () => {
  it("signs with the signed-in person's display name", () => {
    expect(senderNameFor("Caleb Reyes")).toBe("Caleb Reyes");
    expect(senderNameFor("  Caleb  ")).toBe("Caleb");
  });

  it("falls back to Caleb when the account carries no name", () => {
    expect(DEFAULT_SENDER_NAME).toBe("Caleb");
    expect(senderNameFor(null)).toBe("Caleb");
    expect(senderNameFor(undefined)).toBe("Caleb");
    expect(senderNameFor("")).toBe("Caleb");
    expect(senderNameFor("   ")).toBe("Caleb");
  });
});

describe("pickGreetingContacts (the greeting follows an edited To)", () => {
  const contacts = [
    { email: "marcus.reed@example.com", name: "Marcus Reed", is_primary: true },
    { email: "priya.natarajan@example.com", name: "Priya Natarajan", is_primary: false },
  ];

  it("puts the contact matching the first To address first, as the primary", () => {
    const picked = pickGreetingContacts(contacts, ["priya.natarajan@example.com"]);
    expect(picked.map((c) => c.email)).toEqual(["priya.natarajan@example.com", "marcus.reed@example.com"]);
    expect(picked.map((c) => c.is_primary)).toEqual([true, false]);
    expect(picked[0].name).toBe("Priya Natarajan");
  });

  it("matches case-insensitively and ignores surrounding whitespace and blank entries", () => {
    const picked = pickGreetingContacts(contacts, ["  ", " Priya.Natarajan@Example.com "]);
    expect(picked[0].email).toBe("priya.natarajan@example.com");
    expect(picked[0].is_primary).toBe(true);
  });

  it("leaves the stored contacts alone when To is empty", () => {
    expect(pickGreetingContacts(contacts, [])).toBe(contacts);
    expect(pickGreetingContacts(contacts, ["", "  "])).toBe(contacts);
  });

  it("falls back to the stored contacts when the To address is not a stored contact", () => {
    expect(pickGreetingContacts(contacts, ["orders@delta.example"])).toBe(contacts);
  });

  it("keeps the primary first when To is already the primary", () => {
    const picked = pickGreetingContacts(contacts, ["marcus.reed@example.com"]);
    expect(picked.map((c) => c.email)).toEqual(["marcus.reed@example.com", "priya.natarajan@example.com"]);
    expect(picked.map((c) => c.is_primary)).toEqual([true, false]);
  });

  it("does not mutate the input", () => {
    const copy = contacts.map((c) => ({ ...c }));
    pickGreetingContacts(contacts, ["priya.natarajan@example.com"]);
    expect(contacts).toEqual(copy);
  });
});

describe("groupLinksByRfq (unrouting the lines a re-parse replaces)", () => {
  const links = [
    { rfq_id: "rfq-a", request_line_id: "l1" },
    { rfq_id: "rfq-b", request_line_id: "l1" },
    { rfq_id: "rfq-a", request_line_id: "l2" },
    { rfq_id: "rfq-c", request_line_id: "l9" },
  ];

  it("groups the wanted lines by rfq in first-seen order and skips other lines", () => {
    const grouped = groupLinksByRfq(links, ["l1", "l2", "l3"]);
    expect(Array.from(grouped.entries())).toEqual([
      ["rfq-a", ["l1", "l2"]],
      ["rfq-b", ["l1"]],
    ]);
  });

  it("is empty when no wanted line is linked", () => {
    expect(groupLinksByRfq(links, ["l3"]).size).toBe(0);
    expect(groupLinksByRfq([], ["l1"]).size).toBe(0);
    expect(groupLinksByRfq(links, []).size).toBe(0);
  });

  it("lists a line once per rfq even when the links repeat", () => {
    const grouped = groupLinksByRfq([...links, { rfq_id: "rfq-a", request_line_id: "l1" }], ["l1"]);
    expect(grouped.get("rfq-a")).toEqual(["l1"]);
  });
});

describe("sameText (was the body edited by hand?)", () => {
  const body = "Hi Marcus,\nNeed pricing and availability on the below.\n\n8 pcs W12x26 x 50' A992\n\nLet me know what you can do.\n\nCaleb";

  it("ignores line endings and trailing whitespace", () => {
    expect(sameText(body, body)).toBe(true);
    expect(sameText(body, body.replace(/\n/g, "\r\n"))).toBe(true);
    expect(sameText(body, `${body}\n\n`)).toBe(true);
    expect(sameText(body, body.replace("A992\n", "A992   \n"))).toBe(true);
  });

  it("sees any change to the words", () => {
    expect(sameText(body, body.replace("8 pcs", "12 pcs"))).toBe(false);
    expect(sameText(body, body.replace("Hi Marcus,", "Hi Marcus, thanks for the quick turn last time."))).toBe(false);
    expect(sameText(body, body.replace("\n8 pcs W12x26 x 50' A992", ""))).toBe(false);
  });
});

describe("toRfqLineView", () => {
  const row: Tables<"request_lines"> = {
    id: "l1",
    broker_id: "b",
    request_id: "r",
    line_no: 1,
    raw_text: "W12x26 x 50' qty 8",
    catalog_item_id: "item-1",
    category: "w_beam",
    description: "W12x26",
    dims: { d: 12, wt: 26 },
    grade_spec: "A992",
    qty: 8,
    unit: "pcs",
    length_ft: 50,
    length_text: "50'",
    cut_to_length: false,
    delivery_notes: null,
    flags: [],
    confidence: 0.9,
    source_span: { kind: "text", start: 0, end: 10 },
    status: "confirmed",
    created_at: "2026-10-23T10:00:00Z",
    updated_at: "2026-10-23T10:00:00Z",
  };

  it("takes the designation from the linked item and the note from the rfq line", () => {
    const view = toRfqLineView(row, new Map([["item-1", "W12x26"]]), "cut to 20'");
    expect(view).toMatchObject({ designation: "W12x26", qty: 8, unit: "pcs", length_ft: 50, grade_spec: "A992", note: "cut to 20'", dims: { d: 12, wt: 26 } });
  });

  it("has no designation for a custom line or an item the catalog no longer lists", () => {
    expect(toRfqLineView({ ...row, catalog_item_id: null }, new Map(), null).designation).toBeNull();
    expect(toRfqLineView(row, new Map(), null).designation).toBeNull();
  });

  it("reads dims as an object and treats anything else as none", () => {
    expect(toRfqLineView({ ...row, dims: [] }, new Map(), null).dims).toBeNull();
    expect(toRfqLineView({ ...row, dims: "x" }, new Map(), null).dims).toBeNull();
    expect(toRfqLineView({ ...row, dims: {} }, new Map(), null).dims).toEqual({});
  });
});

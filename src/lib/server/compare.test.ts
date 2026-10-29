// The pure parts of the Compare server module: the Zod schemas the actions
// share, the alternate confirmation guard (PRD section 8 rule 3), and the
// difference text an alternate confirmation names. The database paths are
// exercised against a live Supabase (SESSION_NOTES.md, Needs a live database).

import { describe, expect, it } from "vitest";
import {
  ALL_PURCHASED_ERROR,
  AlternateConfirmationError,
  alternateDifference,
  assertAlternateConfirmed,
  NO_SELECTIONS_ERROR,
  purchaseInputSchema,
  SELECTION_CLOSED_STATUSES,
  selectionQtySchema,
  selectOfferLineInputSchema,
} from "./compare";

const EM_DASH = String.fromCharCode(0x2014);
const LINE_ID = "11111111-1111-4111-8111-000000000001";
const OFFER_LINE_ID = "22222222-2222-4222-8222-000000000002";

describe("schemas", () => {
  it("selectionQtySchema takes a positive quantity only, fractions included", () => {
    expect(selectionQtySchema.parse(20)).toBe(20);
    expect(selectionQtySchema.parse(0.5)).toBe(0.5);
    expect(selectionQtySchema.safeParse(0).success).toBe(false);
    expect(selectionQtySchema.safeParse(-3).success).toBe(false);
    expect(selectionQtySchema.safeParse(Number.NaN).success).toBe(false);
    expect(selectionQtySchema.safeParse("20").success).toBe(false);
  });

  it("selectOfferLineInputSchema accepts the UI payload and trims the note", () => {
    const parsed = selectOfferLineInputSchema.parse({
      requestLineId: LINE_ID,
      offerLineId: OFFER_LINE_ID,
      qty: 12,
      note: "  customer approved 1/2 wall  ",
      confirmAlternate: true,
    });
    expect(parsed).toEqual({ requestLineId: LINE_ID, offerLineId: OFFER_LINE_ID, qty: 12, note: "customer approved 1/2 wall", confirmAlternate: true });
    expect(selectOfferLineInputSchema.parse({ requestLineId: LINE_ID, offerLineId: OFFER_LINE_ID, qty: 1, note: null, confirmAlternate: false }).note).toBeNull();
    expect(selectOfferLineInputSchema.parse({ requestLineId: LINE_ID, offerLineId: OFFER_LINE_ID, qty: 1, note: "   ", confirmAlternate: false }).note).toBeNull();
    expect(selectOfferLineInputSchema.parse({ requestLineId: LINE_ID, offerLineId: OFFER_LINE_ID, qty: 1, confirmAlternate: false }).note).toBeNull();
  });

  it("selectOfferLineInputSchema refuses a zero or negative quantity, a missing confirmAlternate, and a bad id", () => {
    const base = { requestLineId: LINE_ID, offerLineId: OFFER_LINE_ID, qty: 1, note: null, confirmAlternate: false };
    expect(selectOfferLineInputSchema.safeParse({ ...base, qty: 0 }).success).toBe(false);
    expect(selectOfferLineInputSchema.safeParse({ ...base, qty: -1 }).success).toBe(false);
    expect(selectOfferLineInputSchema.safeParse({ ...base, confirmAlternate: undefined }).success).toBe(false);
    expect(selectOfferLineInputSchema.safeParse({ ...base, confirmAlternate: "yes" }).success).toBe(false);
    expect(selectOfferLineInputSchema.safeParse({ ...base, offerLineId: "not-a-uuid" }).success).toBe(false);
  });

  it("purchaseInputSchema turns blank and whitespace PO numbers and notes into null", () => {
    expect(purchaseInputSchema.parse({ poNumber: "", notes: "" })).toEqual({ poNumber: null, notes: null });
    expect(purchaseInputSchema.parse({ poNumber: "   ", notes: " \n " })).toEqual({ poNumber: null, notes: null });
    expect(purchaseInputSchema.parse({ poNumber: null, notes: null })).toEqual({ poNumber: null, notes: null });
    expect(purchaseInputSchema.parse({})).toEqual({ poNumber: null, notes: null });
    expect(purchaseInputSchema.parse({ poNumber: " PO-4471 ", notes: " ship to the yard " })).toEqual({ poNumber: "PO-4471", notes: "ship to the yard" });
    expect(purchaseInputSchema.safeParse({ poNumber: "x".repeat(81), notes: null }).success).toBe(false);
  });
});

describe("assertAlternateConfirmed (PRD section 8 rule 3)", () => {
  it("lets an exact line through with or without a confirmation", () => {
    expect(() => assertAlternateConfirmed(false, false, [])).not.toThrow();
    expect(() => assertAlternateConfirmed(false, true, [])).not.toThrow();
  });

  it("lets a confirmed alternate through", () => {
    expect(() => assertAlternateConfirmed(true, true, ["wall 3/8 to 1/2"])).not.toThrow();
  });

  it("refuses an unconfirmed alternate with an error that names the difference", () => {
    let caught: unknown = null;
    try {
      assertAlternateConfirmed(true, false, ["wall 3/8 to 1/2", "length 40' to 50'"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AlternateConfirmationError);
    const error = caught as AlternateConfirmationError;
    expect(error.name).toBe("AlternateConfirmationError");
    expect(error.changed).toEqual(["wall 3/8 to 1/2", "length 40' to 50'"]);
    expect(error.message).toBe("This offer is an alternate (wall 3/8 to 1/2; length 40' to 50'). Confirm the difference to select it.");
    expect(error.message).not.toContain(EM_DASH);
  });

  it("refuses an alternate the reply did not explain, saying so", () => {
    expect(() => assertAlternateConfirmed(true, false, [])).toThrow("This offer is an alternate (differs from the request). Confirm the difference to select it.");
  });
});

describe("alternateDifference", () => {
  it("joins the changes with a semicolon and falls back to a plain statement", () => {
    expect(alternateDifference(["wall 3/8 to 1/2"])).toBe("wall 3/8 to 1/2");
    expect(alternateDifference(["weight 26 to 22", "length 50' to 40'"])).toBe("weight 26 to 22; length 50' to 40'");
    expect(alternateDifference([])).toBe("differs from the request");
  });
});

describe("constants", () => {
  it("close selections once the purchase is on record, and write no em dash", () => {
    expect(SELECTION_CLOSED_STATUSES).toEqual(["sourced", "closed"]);
    for (const text of [NO_SELECTIONS_ERROR, ALL_PURCHASED_ERROR]) {
      expect(text).not.toContain(EM_DASH);
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

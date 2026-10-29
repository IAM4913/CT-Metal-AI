// The pure rules of parseRequest (parse-request.ts): when a parse may start,
// and the status a failed parse leaves. The parse itself needs a database and
// the model; the fixture-driven tests of the extraction live in
// src/lib/parsing/fixtures.test.ts.

import { describe, expect, it } from "vitest";
import { requestLineStatusValues, requestStatusValues } from "@/lib/db/enums";
import { reparseBlockedReason, statusAfterFailedParse } from "./parse-request";

const EM_DASH = String.fromCharCode(0x2014);

describe("reparseBlockedReason", () => {
  it("lets a request before Confirm be parsed when it has no lines yet, or removed lines only", () => {
    for (const status of ["new", "parsing", "needs_review"] as const) {
      expect(reparseBlockedReason(status, []), status).toBeNull();
      expect(reparseBlockedReason(status, ["removed", "removed"]), status).toBeNull();
    }
  });

  it("lets a request before Confirm be re-parsed while a parsed line is there to replace", () => {
    expect(reparseBlockedReason("needs_review", ["parsed", "parsed"])).toBeNull();
    expect(reparseBlockedReason("needs_review", ["confirmed", "custom", "parsed", "removed"])).toBeNull();
    expect(reparseBlockedReason("new", ["parsed"])).toBeNull();
  });

  it("refuses a confirmed request whatever its lines say, since every confirmed line would be kept and doubled", () => {
    for (const status of ["reviewed", "rfqs_drafted", "rfqs_sent", "collecting", "comparing", "sourced", "closed"] as const) {
      const reason = reparseBlockedReason(status, ["confirmed", "confirmed"]);
      expect(reason, status).toContain("confirmed");
      expect(reason, status).toContain("second copy");
      expect(reparseBlockedReason(status, []), status).not.toBeNull();
      expect(reparseBlockedReason(status, ["parsed"]), status).not.toBeNull();
    }
  });

  it("refuses a request before Confirm whose live lines are all confirmed or custom", () => {
    const reason = reparseBlockedReason("needs_review", ["confirmed", "custom", "removed"]);
    expect(reason).toContain("second copy");
    expect(reason).toContain("Remove the lines");
    expect(reparseBlockedReason("needs_review", ["custom"])).not.toBeNull();
    expect(reparseBlockedReason("needs_review", ["confirmed"])).not.toBeNull();
  });

  it("decides every request status and every line status the database knows, without an em dash", () => {
    for (const status of requestStatusValues) {
      for (const lineStatus of requestLineStatusValues) {
        const reason = reparseBlockedReason(status, [lineStatus]);
        expect(reason === null || typeof reason === "string").toBe(true);
        if (reason !== null) expect(reason).not.toContain(EM_DASH);
      }
    }
  });
});

describe("statusAfterFailedParse", () => {
  it("resets a request before Confirm to new, where the next Parse replaces every parsed line again", () => {
    for (const status of ["new", "parsing", "needs_review"] as const) {
      expect(statusAfterFailedParse(status), status).toBe("new");
    }
  });

  it("keeps the status of a request that was past needs_review, never dropping it into the New queue group", () => {
    for (const status of ["reviewed", "rfqs_drafted", "rfqs_sent", "collecting", "comparing", "sourced", "closed"] as const) {
      expect(statusAfterFailedParse(status), status).toBe(status);
    }
  });

  it("answers every request status the database knows with one of them", () => {
    for (const status of requestStatusValues) {
      expect(requestStatusValues).toContain(statusAfterFailedParse(status));
    }
  });
});

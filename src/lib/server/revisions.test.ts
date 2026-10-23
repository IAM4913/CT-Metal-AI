import { describe, expect, it } from "vitest";
import { newestRevision, SupersededError, supersededMessage, type RevisionRow } from "./revisions";

function row(id: string, revision: number, created_at: string): RevisionRow {
  return { id, revision, created_at };
}

describe("newestRevision (AC-8.4 superseded guard)", () => {
  it("is null when the request has no child revision", () => {
    expect(newestRevision([])).toBeNull();
  });

  it("picks the highest revision number", () => {
    const rows = [row("r2", 2, "2026-10-23T10:00:00Z"), row("r3", 3, "2026-10-22T10:00:00Z")];
    expect(newestRevision(rows)?.id).toBe("r3");
    expect(newestRevision([...rows].reverse())?.id).toBe("r3");
  });

  it("breaks a tie on revision number by the newest created_at, so two siblings never tie", () => {
    const rows = [row("older", 2, "2026-10-23T10:00:00Z"), row("newer", 2, "2026-10-23T10:05:00Z")];
    expect(newestRevision(rows)?.id).toBe("newer");
    expect(newestRevision([...rows].reverse())?.id).toBe("newer");
  });

  it("returns the row itself, extra fields included", () => {
    const rows = [{ ...row("r2", 2, "2026-10-23T10:00:00Z"), status: "needs_review" }];
    expect(newestRevision(rows)).toEqual(rows[0]);
  });
});

describe("SupersededError", () => {
  it("names the newer revision and points at it", () => {
    const error = new SupersededError({ id: "11111111-1111-4111-8111-111111111111", revision: 2 });
    expect(error.message).toBe("This revision has been superseded by revision 2. Make the change there instead.");
    expect(error.message).toBe(supersededMessage({ revision: 2 }));
    expect(error.redirectTo).toBe("/requests/11111111-1111-4111-8111-111111111111");
    expect(error.childRequestId).toBe("11111111-1111-4111-8111-111111111111");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SupersededError");
  });

  it("writes no em dash", () => {
    expect(supersededMessage({ revision: 3 })).not.toContain(String.fromCharCode(0x2014));
  });
});

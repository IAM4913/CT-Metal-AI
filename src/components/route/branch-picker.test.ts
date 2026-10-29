// pickerRows (branch-picker.tsx), the pure part of the Route tab's per-line
// picker: the ranked suggestions keep the matcher's order with their past-buy
// counts, the branches the broker added by hand follow sorted by vendor and
// branch name and are marked as added, a branch whose RFQ is sent is checked
// and locked, and an id no branch answers to is skipped. Rendering is not
// exercised here (no browser in this session).

import { describe, expect, it } from "vitest";
import type { BranchForRouting } from "@/lib/routing/match";
import { pickerRows } from "./branch-picker";

function branch(id: string, vendor: string, name: string): BranchForRouting {
  return {
    branch_id: id,
    branch_name: name,
    vendor_id: `vendor-${vendor}`,
    vendor_name: vendor,
    preferred: false,
    categories: ["angle"],
    primary_contact_email: `${id}@example.com`,
  };
}

const DELTA_HOUSTON = branch("delta-hou", "Delta Steel", "Houston");
const DELTA_FW = branch("delta-fw", "Delta Steel", "Fort Worth");
const ALAMO = branch("alamo", "Alamo Metals", "San Antonio");
const TRIPLE_S = branch("triple-s", "Triple-S Steel", "Houston");
const BRANCHES = [DELTA_HOUSTON, DELTA_FW, ALAMO, TRIPLE_S];

describe("pickerRows", () => {
  it("keeps the suggestions in matcher order with their past buys, unchecked until picked", () => {
    const rows = pickerRows(
      BRANCHES,
      [
        { branch_id: "triple-s", past_buys: 3 },
        { branch_id: "alamo", past_buys: 0 },
      ],
      ["alamo"],
      [],
    );
    expect(rows.map((row) => row.branch.branch_id)).toEqual(["triple-s", "alamo"]);
    expect(rows.map((row) => row.pastBuys)).toEqual([3, 0]);
    expect(rows.map((row) => row.suggested)).toEqual([true, true]);
    expect(rows.map((row) => row.checked)).toEqual([false, true]);
    expect(rows.map((row) => row.locked)).toEqual([false, false]);
  });

  it("appends a selected branch that was not suggested, checked, marked added by hand, sorted by vendor then branch", () => {
    const rows = pickerRows(BRANCHES, [{ branch_id: "triple-s", past_buys: 1 }], ["delta-hou", "alamo", "delta-fw"], []);
    expect(rows.map((row) => row.branch.branch_id)).toEqual(["triple-s", "alamo", "delta-fw", "delta-hou"]);
    const added = rows.slice(1);
    expect(added.every((row) => !row.suggested && row.checked && row.pastBuys === 0)).toBe(true);
  });

  it("marks a branch whose RFQ is sent checked and locked, suggested or added by hand", () => {
    const rows = pickerRows(BRANCHES, [{ branch_id: "triple-s", past_buys: 0 }], ["triple-s", "alamo"], ["triple-s", "alamo"]);
    expect(rows.map((row) => [row.branch.branch_id, row.checked, row.locked])).toEqual([
      ["triple-s", true, true],
      ["alamo", true, true],
    ]);
  });

  it("skips an id no branch answers to, suggested or selected", () => {
    const rows = pickerRows(BRANCHES, [{ branch_id: "gone", past_buys: 5 }, { branch_id: "alamo", past_buys: 0 }], ["gone-too", "alamo"], []);
    expect(rows.map((row) => row.branch.branch_id)).toEqual(["alamo"]);
  });

  it("shows a branch suggested twice once, and never lists a selected branch twice", () => {
    const rows = pickerRows(
      BRANCHES,
      [
        { branch_id: "alamo", past_buys: 2 },
        { branch_id: "alamo", past_buys: 2 },
      ],
      ["alamo", "alamo"],
      [],
    );
    expect(rows.map((row) => row.branch.branch_id)).toEqual(["alamo"]);
    expect(rows[0].pastBuys).toBe(2);
  });

  it("is empty with no suggestions and nothing selected", () => {
    expect(pickerRows(BRANCHES, [], [], [])).toEqual([]);
  });
});

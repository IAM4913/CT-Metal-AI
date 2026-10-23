import { describe, expect, it } from "vitest";
import {
  buildBranchesForRouting,
  consolidateRecipients,
  linesForBranch,
  suggestBranchesForLine,
  tallyCategoryPurchases,
  type BranchForRouting,
  type CategoryPurchaseCount,
} from "./match";

function branch(overrides: Partial<BranchForRouting> & { branch_id: string }): BranchForRouting {
  return {
    branch_name: overrides.branch_id,
    vendor_id: `vendor-${overrides.branch_id}`,
    vendor_name: overrides.branch_id,
    preferred: false,
    categories: ["w_beam"],
    primary_contact_email: `${overrides.branch_id}@example.com`,
    ...overrides,
  };
}

const delta = branch({
  branch_id: "delta-hou",
  branch_name: "Delta Steel Houston",
  vendor_id: "delta",
  vendor_name: "Delta Steel",
  preferred: true,
  categories: ["w_beam", "channel", "angle", "plate"],
});
const deltaFw = branch({
  branch_id: "delta-fw",
  branch_name: "Delta Steel Fort Worth",
  vendor_id: "delta",
  vendor_name: "Delta Steel",
  categories: ["w_beam", "channel"],
});
const morgan = branch({
  branch_id: "morgan",
  branch_name: "Morgan Steel Texas",
  vendor_id: "morgan",
  vendor_name: "Morgan Steel",
  categories: ["w_beam", "angle", "plate"],
});
const alro = branch({
  branch_id: "alro",
  branch_name: "Alro Houston",
  vendor_id: "alro",
  vendor_name: "alro",
  categories: ["plate", "flat_bar"],
});
const bullMoose = branch({
  branch_id: "bull-moose",
  branch_name: "Bull Moose Gerald",
  vendor_id: "bull-moose",
  vendor_name: "Bull Moose",
  categories: ["hss_square", "hss_rectangular"],
});
const ALL = [morgan, deltaFw, delta, alro, bullMoose];

describe("suggestBranchesForLine (AC-6.1)", () => {
  it("returns nothing for a line with no category", () => {
    expect(suggestBranchesForLine(null, ALL, [])).toEqual([]);
  });

  it("returns only branches whose capabilities include the category", () => {
    const ids = suggestBranchesForLine("hss_square", ALL, []).map((b) => b.branch_id);
    expect(ids).toEqual(["bull-moose"]);
    expect(suggestBranchesForLine("rebar", ALL, [])).toEqual([]);
  });

  it("puts preferred branches first, then alphabetical by vendor then branch", () => {
    const ids = suggestBranchesForLine("w_beam", ALL, []).map((b) => b.branch_id);
    expect(ids).toEqual(["delta-hou", "delta-fw", "morgan"]);
  });

  it("breaks ties within a preference group by past purchases of that category", () => {
    const history: CategoryPurchaseCount[] = [
      { branch_id: "morgan", category: "w_beam", count: 3 },
      { branch_id: "delta-fw", category: "w_beam", count: 1 },
      // Purchases of another category do not count.
      { branch_id: "delta-fw", category: "channel", count: 9 },
    ];
    const ids = suggestBranchesForLine("w_beam", ALL, history).map((b) => b.branch_id);
    expect(ids).toEqual(["delta-hou", "morgan", "delta-fw"]);
  });

  it("sums several history rows for the same branch and category", () => {
    const history: CategoryPurchaseCount[] = [
      { branch_id: "delta-fw", category: "w_beam", count: 2 },
      { branch_id: "delta-fw", category: "w_beam", count: 2 },
      { branch_id: "morgan", category: "w_beam", count: 3 },
    ];
    const ids = suggestBranchesForLine("w_beam", ALL, history).map((b) => b.branch_id);
    expect(ids).toEqual(["delta-hou", "delta-fw", "morgan"]);
  });

  it("history never outranks the preferred flag", () => {
    const history: CategoryPurchaseCount[] = [{ branch_id: "morgan", category: "w_beam", count: 50 }];
    const ids = suggestBranchesForLine("w_beam", ALL, history).map((b) => b.branch_id);
    expect(ids[0]).toBe("delta-hou");
  });

  it("sorts names case-insensitively", () => {
    const ids = suggestBranchesForLine("plate", ALL, []).map((b) => b.branch_id);
    // "alro" (lowercase) sorts before "Delta Steel" and "Morgan Steel"; delta-hou is preferred so it leads.
    expect(ids).toEqual(["delta-hou", "alro", "morgan"]);
  });

  it("is stable for branches that tie on every key", () => {
    const a = branch({ branch_id: "a", vendor_name: "Same", branch_name: "Same" });
    const b = branch({ branch_id: "b", vendor_name: "same", branch_name: "same" });
    const c = branch({ branch_id: "c", vendor_name: "Same", branch_name: "Same" });
    expect(suggestBranchesForLine("w_beam", [a, b, c], []).map((x) => x.branch_id)).toEqual(["a", "b", "c"]);
    expect(suggestBranchesForLine("w_beam", [c, a, b], []).map((x) => x.branch_id)).toEqual(["c", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [...ALL];
    suggestBranchesForLine("w_beam", input, []);
    expect(input).toEqual(ALL);
  });
});

describe("consolidateRecipients (AC-6.2)", () => {
  it("lists each branch once, sorted by vendor then branch name", () => {
    const perLine = [
      { lineId: "l1", branchIds: ["morgan", "delta-hou"] },
      { lineId: "l2", branchIds: ["delta-hou", "delta-fw"] },
      { lineId: "l3", branchIds: [] },
    ];
    expect(consolidateRecipients(perLine, ALL).map((b) => b.branch_id)).toEqual(["delta-fw", "delta-hou", "morgan"]);
  });

  it("skips branch ids that are not in the directory and handles no routing", () => {
    expect(consolidateRecipients([{ lineId: "l1", branchIds: ["ghost"] }], ALL)).toEqual([]);
    expect(consolidateRecipients([], ALL)).toEqual([]);
  });
});

describe("linesForBranch", () => {
  const perLine = [
    { lineId: "l1", branchIds: ["morgan", "delta-hou"] },
    { lineId: "l2", branchIds: ["delta-hou"] },
    { lineId: "l3", branchIds: ["morgan"] },
  ];

  it("returns the line ids routed to the branch in line order", () => {
    expect(linesForBranch(perLine, "delta-hou")).toEqual(["l1", "l2"]);
    expect(linesForBranch(perLine, "morgan")).toEqual(["l1", "l3"]);
    expect(linesForBranch(perLine, "alro")).toEqual([]);
  });
});

describe("tallyCategoryPurchases", () => {
  it("counts purchased lines per branch and category and skips null categories", () => {
    const rows = [
      { branch_id: "delta-hou", category: "w_beam" as const },
      { branch_id: "delta-hou", category: "w_beam" as const },
      { branch_id: "delta-hou", category: "plate" as const },
      { branch_id: "morgan", category: "w_beam" as const },
      { branch_id: "morgan", category: null },
    ];
    expect(tallyCategoryPurchases(rows)).toEqual([
      { branch_id: "delta-hou", category: "w_beam", count: 2 },
      { branch_id: "delta-hou", category: "plate", count: 1 },
      { branch_id: "morgan", category: "w_beam", count: 1 },
    ]);
    expect(tallyCategoryPurchases([])).toEqual([]);
  });
});

describe("buildBranchesForRouting", () => {
  it("joins vendors, branches, capabilities, and the primary contact", () => {
    const out = buildBranchesForRouting(
      [
        { id: "v-delta", name: "Delta Steel" },
        { id: "v-alro", name: "Alro" },
      ],
      [
        { id: "b-hou", vendor_id: "v-delta", name: "Delta Steel Houston", preferred: true },
        { id: "b-alro", vendor_id: "v-alro", name: "Alro Houston", preferred: false },
        { id: "b-orphan", vendor_id: "v-missing", name: "No vendor", preferred: false },
      ],
      [
        { branch_id: "b-hou", category: "w_beam" },
        { branch_id: "b-hou", category: "plate" },
        { branch_id: "b-hou", category: "plate" },
      ],
      [
        { branch_id: "b-hou", email: "priya@example.com", is_primary: false },
        { branch_id: "b-hou", email: "marcus@example.com", is_primary: true },
        { branch_id: "b-alro", email: "first@example.com", is_primary: false },
        { branch_id: "b-alro", email: "second@example.com", is_primary: false },
      ],
    );
    expect(out).toEqual([
      {
        branch_id: "b-alro",
        branch_name: "Alro Houston",
        vendor_id: "v-alro",
        vendor_name: "Alro",
        preferred: false,
        categories: [],
        primary_contact_email: "first@example.com",
      },
      {
        branch_id: "b-hou",
        branch_name: "Delta Steel Houston",
        vendor_id: "v-delta",
        vendor_name: "Delta Steel",
        preferred: true,
        categories: ["w_beam", "plate"],
        primary_contact_email: "marcus@example.com",
      },
    ]);
  });

  it("gives null when a branch has no contacts", () => {
    const out = buildBranchesForRouting([{ id: "v", name: "V" }], [{ id: "b", vendor_id: "v", name: "B", preferred: false }], [], []);
    expect(out[0].primary_contact_email).toBeNull();
  });
});

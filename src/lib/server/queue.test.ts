// The pure half of the queue loader: which requests a newer revision hides,
// how many live lines each request has, and which RFQs belong to each
// request's current revision. The database reads in loadQueue are type-checked
// only (no database in this session).

import { describe, expect, it } from "vitest";
import { countLiveLines, rfqsByRequest, supersededIds } from "./queue";

type LineRows = Parameters<typeof countLiveLines>[0];
type RfqRows = Parameters<typeof rfqsByRequest>[1];

describe("supersededIds", () => {
  it("hides every request another revision points back at, through a chain", () => {
    // g <- p <- c: g and p each have a child revision; c is the newest and stays.
    const requests = [
      { id: "g", parent_request_id: null },
      { id: "p", parent_request_id: "g" },
      { id: "c", parent_request_id: "p" },
      { id: "solo", parent_request_id: null },
    ];
    const hidden = supersededIds(requests);
    expect([...hidden].sort()).toEqual(["g", "p"]);
    expect(hidden.has("c")).toBe(false);
    expect(hidden.has("solo")).toBe(false);
  });

  it("is empty when there are no requests or no revisions", () => {
    expect(supersededIds([])).toEqual(new Set());
    expect(supersededIds([{ parent_request_id: null }])).toEqual(new Set());
  });

  it("names a parent even when its row is not in the list", () => {
    expect(supersededIds([{ parent_request_id: "gone" }])).toEqual(new Set(["gone"]));
  });
});

describe("countLiveLines", () => {
  it("counts the non-removed lines per request and leaves a request with only removed lines out", () => {
    const lines: LineRows = [
      { request_id: "a", status: "confirmed" },
      { request_id: "a", status: "parsed" },
      { request_id: "a", status: "removed" },
      { request_id: "b", status: "removed" },
      { request_id: "c", status: "custom" },
    ];
    const counts = countLiveLines(lines);
    expect(counts.get("a")).toBe(2);
    expect(counts.has("b")).toBe(false);
    expect(counts.get("c")).toBe(1);
  });

  it("is empty for no lines", () => {
    expect(countLiveLines([])).toEqual(new Map());
  });
});

describe("rfqsByRequest", () => {
  const requests = [
    { id: "r1", revision: 2 },
    { id: "r2", revision: 1 },
  ];
  const names = new Map([["b-houston", { branch: "Houston", vendor: "Delta Steel" }]]);

  it("keeps only the RFQs of each request's current revision, with names", () => {
    const rfqs: RfqRows = [
      { id: "x", request_id: "r1", branch_id: "b-houston", revision: 2, status: "sent", sent_at: "2026-10-27T10:00:00.000Z" },
      { id: "old", request_id: "r1", branch_id: "b-houston", revision: 1, status: "responded", sent_at: "2026-10-20T10:00:00.000Z" },
    ];
    const byRequest = rfqsByRequest(requests, rfqs, names);
    expect(byRequest.get("r1")).toEqual([
      { id: "x", branch_name: "Houston", vendor_name: "Delta Steel", status: "sent", sent_at: "2026-10-27T10:00:00.000Z" },
    ]);
    expect(byRequest.has("r2")).toBe(false);
  });

  it("drops an RFQ whose request is not in the set", () => {
    const rfqs: RfqRows = [{ id: "stray", request_id: "r9", branch_id: "b-houston", revision: 1, status: "draft", sent_at: null }];
    expect(rfqsByRequest(requests, rfqs, names).size).toBe(0);
  });

  it("falls back to Unknown branch and Unknown vendor for a branch id the names map lacks", () => {
    const rfqs: RfqRows = [{ id: "y", request_id: "r2", branch_id: "b-missing", revision: 1, status: "draft", sent_at: null }];
    expect(rfqsByRequest(requests, rfqs, names).get("r2")).toEqual([
      { id: "y", branch_name: "Unknown branch", vendor_name: "Unknown vendor", status: "draft", sent_at: null },
    ]);
  });

  it("keeps RFQ order within a request and is empty for no RFQs", () => {
    const rfqs: RfqRows = [
      { id: "b", request_id: "r2", branch_id: "b-houston", revision: 1, status: "sent", sent_at: "2026-10-27T10:00:00.000Z" },
      { id: "a", request_id: "r2", branch_id: "b-houston", revision: 1, status: "draft", sent_at: null },
    ];
    expect(rfqsByRequest(requests, rfqs, names).get("r2")?.map((rfq) => rfq.id)).toEqual(["b", "a"]);
    expect(rfqsByRequest(requests, [], names)).toEqual(new Map());
    expect(rfqsByRequest([], rfqs, names)).toEqual(new Map());
  });
});

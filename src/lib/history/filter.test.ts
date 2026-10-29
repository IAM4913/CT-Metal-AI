import { describe, expect, it } from "vitest";
import { materialCategoryValues } from "@/lib/db/enums";
import {
  applyClientFilters,
  confirmedDayText,
  countPurchases,
  designationMatches,
  flattenPurchases,
  hasAnyFilter,
  HISTORY_FILTER_KEYS,
  historyFilterSchema,
  inDateRange,
  parseHistoryFilter,
  rowItemText,
  rowMatches,
  searchableText,
  textMatches,
  utcDayOf,
  type HistoryRow,
  type RawHistoryPurchase,
} from "./filter";

// ---------------------------------------------------------------------------
// Fixture: two purchases from the mixed-list request. Delta Steel got the
// channel (linked to C12x30) and the angle; Alamo got a custom clip plate that
// is not in the catalog. A third purchase a month earlier for another customer.
// ---------------------------------------------------------------------------

function rawPurchases(): RawHistoryPurchase[] {
  return [
    {
      id: "p-delta",
      confirmed_at: "2026-10-27T21:30:00.000Z",
      po_number: "PO-4471",
      request_id: "req-1",
      branch_id: "br-delta-houston",
      vendor_branches: { name: "Houston", vendors: { name: "Delta Steel" } },
      requests: { subject: "Material for the Baytown job", customers: { name: "Acme Fabrication" } },
      purchase_lines: [
        {
          id: "pl-2",
          sourcing_selections: {
            id: "sel-2",
            request_line_id: "line-angle",
            qty: 40,
            offer_lines: {
              id: "ol-2",
              offer_id: "offer-delta",
              offered_desc: "L2x2x1/4 A36",
              unit_price: 0.62,
              price_basis: "per_lb",
              unit: "pcs",
              vendor_offers: { id: "offer-delta", rfq_id: "rfq-delta", message_id: "msg-delta", attachment_id: null, branch_id: "br-delta-houston" },
              request_lines: {
                id: "line-angle",
                description: "2x2x1/4 angle",
                category: "angle",
                catalog_item_id: "item-l2",
                unit: "pcs",
                catalog_items: { designation: "L2x2x1/4" },
              },
            },
          },
        },
        {
          id: "pl-1",
          sourcing_selections: {
            id: "sel-1",
            request_line_id: "line-channel",
            qty: 12,
            offer_lines: {
              id: "ol-1",
              offer_id: "offer-delta",
              offered_desc: "C12x30 A36 40 ft",
              unit_price: 58.5,
              price_basis: "per_cwt",
              unit: "pcs",
              vendor_offers: { id: "offer-delta", rfq_id: "rfq-delta", message_id: "msg-delta", attachment_id: null, branch_id: "br-delta-houston" },
              request_lines: {
                id: "line-channel",
                description: "12 inch channel 30#",
                category: "channel",
                catalog_item_id: "item-c12x30",
                unit: "pcs",
                catalog_items: { designation: "C12x30" },
              },
            },
          },
        },
      ],
    },
    {
      id: "p-alamo",
      confirmed_at: "2026-10-27T21:30:00.000Z",
      po_number: null,
      request_id: "req-1",
      branch_id: "br-alamo-sa",
      vendor_branches: { name: "San Antonio", vendors: { name: "Alamo Iron Works" } },
      requests: { subject: "Material for the Baytown job", customers: { name: "Acme Fabrication" } },
      purchase_lines: [
        {
          id: "pl-3",
          sourcing_selections: {
            id: "sel-3",
            request_line_id: "line-clip",
            qty: 6,
            offer_lines: {
              id: "ol-3",
              offer_id: "offer-alamo",
              offered_desc: "clip plates per drawing, 3/8 A36",
              unit_price: 48,
              price_basis: "per_pc",
              unit: "pcs",
              vendor_offers: { id: "offer-alamo", rfq_id: "rfq-alamo", message_id: null, attachment_id: "att-quote-pdf", branch_id: "br-alamo-sa" },
              request_lines: {
                id: "line-clip",
                description: "clip plates 3/8 per drawing",
                category: null,
                catalog_item_id: null,
                unit: "pcs",
                catalog_items: null,
              },
            },
          },
        },
      ],
    },
    {
      id: "p-sept",
      confirmed_at: "2026-09-15T15:00:00.000Z",
      po_number: "PO-4402",
      request_id: "req-0",
      branch_id: "br-coastal",
      vendor_branches: { name: "Beaumont", vendors: { name: "Coastal Steel" } },
      requests: { subject: "", customers: { name: "Gulf Erectors" } },
      purchase_lines: [
        {
          id: "pl-4",
          sourcing_selections: {
            id: "sel-4",
            request_line_id: "line-beam",
            qty: 8,
            offer_lines: {
              id: "ol-4",
              offer_id: "offer-coastal",
              offered_desc: "W12x26 A992",
              unit_price: 61,
              price_basis: "per_cwt",
              unit: "pcs",
              vendor_offers: { id: "offer-coastal", rfq_id: "rfq-coastal", message_id: "msg-coastal", attachment_id: null, branch_id: "br-coastal" },
              request_lines: {
                id: "line-beam",
                description: "W12x26 beam",
                category: "w_beam",
                catalog_item_id: "item-w12x26",
                unit: "pcs",
                catalog_items: { designation: "W12x26" },
              },
            },
          },
        },
      ],
    },
  ];
}

function rows(): HistoryRow[] {
  return flattenPurchases(rawPurchases());
}

function ids(result: HistoryRow[]): string[] {
  return result.map((row) => row.request_line_id);
}

// ---------------------------------------------------------------------------
// parseHistoryFilter
// ---------------------------------------------------------------------------

describe("parseHistoryFilter", () => {
  it("returns an empty filter for no params", () => {
    expect(parseHistoryFilter({})).toEqual({});
    expect(hasAnyFilter(parseHistoryFilter({}))).toBe(false);
  });

  it("reads every field and trims text", () => {
    const filter = parseHistoryFilter({
      customer: "  Acme ",
      vendor: "Delta",
      category: "channel",
      designation: " C12x30",
      from: "2026-10-01",
      to: "2026-10-31",
      q: " 4471 ",
    });
    expect(filter).toEqual({
      customer: "Acme",
      vendor: "Delta",
      category: "channel",
      designation: "C12x30",
      from: "2026-10-01",
      to: "2026-10-31",
      q: "4471",
    });
    expect(hasAnyFilter(filter)).toBe(true);
  });

  it("treats empty and blank strings as absent", () => {
    expect(parseHistoryFilter({ customer: "", vendor: "   ", category: "", from: "", to: "", q: "", designation: "" })).toEqual({});
  });

  it("drops junk values and keeps the valid ones beside them", () => {
    const filter = parseHistoryFilter({
      customer: "Acme",
      category: "unobtainium",
      from: "10/01/2026",
      to: "2026-13-40",
      q: "channel",
    });
    expect(filter).toEqual({ customer: "Acme", q: "channel" });
  });

  it("takes the first value of a repeated key", () => {
    expect(parseHistoryFilter({ vendor: ["Delta", "Alamo"], category: ["angle", "plate"] })).toEqual({ vendor: "Delta", category: "angle" });
  });

  it("ignores keys it does not know and an undefined value", () => {
    expect(parseHistoryFilter({ page: "3", sort: "price", customer: undefined })).toEqual({});
  });

  it("turns a backwards date range around", () => {
    expect(parseHistoryFilter({ from: "2026-10-31", to: "2026-10-01" })).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("accepts every material category", () => {
    for (const category of materialCategoryValues) {
      expect(parseHistoryFilter({ category })).toEqual({ category });
    }
  });

  it("never throws on hostile input", () => {
    expect(() => parseHistoryFilter({ q: "' or 1=1 --", from: "DROP TABLE", category: ["a", "b"] })).not.toThrow();
    expect(parseHistoryFilter({ q: "' or 1=1 --", from: "DROP TABLE" })).toEqual({ q: "' or 1=1 --" });
  });

  it("exposes the same keys the schema has", () => {
    expect([...HISTORY_FILTER_KEYS].sort()).toEqual(Object.keys(historyFilterSchema.shape).sort());
  });
});

// ---------------------------------------------------------------------------
// flattenPurchases
// ---------------------------------------------------------------------------

describe("flattenPurchases", () => {
  it("makes one row per purchase line, purchases in query order, lines by item text", () => {
    const result = rows();
    expect(result).toHaveLength(4);
    expect(result.map((row) => row.purchase_id)).toEqual(["p-delta", "p-delta", "p-alamo", "p-sept"]);
    // Inside the Delta purchase: C12x30 sorts before L2x2x1/4.
    expect(ids(result.slice(0, 2))).toEqual(["line-channel", "line-angle"]);
  });

  it("carries every field the table and the links need", () => {
    const channel = rows().find((row) => row.request_line_id === "line-channel");
    expect(channel).toEqual({
      purchase_id: "p-delta",
      confirmed_at: "2026-10-27T21:30:00.000Z",
      po_number: "PO-4471",
      request_id: "req-1",
      request_subject: "Material for the Baytown job",
      customer_name: "Acme Fabrication",
      vendor_name: "Delta Steel",
      branch_name: "Houston",
      branch_id: "br-delta-houston",
      rfq_id: "rfq-delta",
      offer_id: "offer-delta",
      message_id: "msg-delta",
      attachment_id: null,
      request_line_id: "line-channel",
      line_description: "12 inch channel 30#",
      designation: "C12x30",
      category: "channel",
      qty: 12,
      unit: "pcs",
      unit_price: 58.5,
      price_basis: "per_cwt",
      offered_desc: "C12x30 A36 40 ft",
    });
  });

  it("leaves designation and category null for a custom line and keeps the quote attachment", () => {
    const clip = rows().find((row) => row.request_line_id === "line-clip");
    expect(clip?.designation).toBeNull();
    expect(clip?.category).toBeNull();
    expect(clip?.po_number).toBeNull();
    expect(clip?.attachment_id).toBe("att-quote-pdf");
    expect(clip?.message_id).toBeNull();
    expect(rowItemText(clip as HistoryRow)).toBe("clip plates 3/8 per drawing");
  });

  it("reads a blank subject as null", () => {
    const beam = rows().find((row) => row.request_line_id === "line-beam");
    expect(beam?.request_subject).toBeNull();
    expect(beam?.customer_name).toBe("Gulf Erectors");
  });

  it("does not throw when embedded rows are missing, and skips a line with no selection", () => {
    const raw: RawHistoryPurchase[] = [
      {
        id: "p-bare",
        confirmed_at: "2026-10-01T12:00:00.000Z",
        po_number: "  ",
        request_id: "req-9",
        branch_id: "br-9",
        vendor_branches: null,
        requests: null,
        purchase_lines: [
          { id: "pl-none", sourcing_selections: null },
          {
            id: "pl-thin",
            sourcing_selections: { id: "sel-thin", request_line_id: "line-thin", qty: 2, offer_lines: null },
          },
        ],
      },
    ];
    const result = flattenPurchases(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      purchase_id: "p-bare",
      po_number: null,
      request_subject: null,
      customer_name: null,
      vendor_name: "Unknown vendor",
      branch_name: "Unknown branch",
      rfq_id: null,
      offer_id: null,
      message_id: null,
      attachment_id: null,
      request_line_id: "line-thin",
      line_description: "",
      designation: null,
      category: null,
      qty: 2,
      unit: null,
      unit_price: null,
      price_basis: null,
      offered_desc: "",
    });
  });

  it("leaves the unit unknown when the request line is not visible, never the vendor's unit (40 pcs is not 40 ft)", () => {
    const raw = rawPurchases();
    const offerLine = raw[0].purchase_lines[0].sourcing_selections?.offer_lines;
    if (!offerLine) throw new Error("fixture");
    offerLine.request_lines = null;
    offerLine.unit = "ft";
    const row = flattenPurchases([raw[0]]).find((r) => r.request_line_id === "line-angle");
    expect(row?.qty).toBe(40);
    expect(row?.unit).toBeNull();
    expect(row?.line_description).toBe("");
  });

  it("leaves the unit unknown when the request line carries none, whatever the vendor quoted in", () => {
    const raw = rawPurchases();
    const offerLine = raw[0].purchase_lines[0].sourcing_selections?.offer_lines;
    if (!offerLine?.request_lines) throw new Error("fixture");
    offerLine.request_lines.unit = null;
    offerLine.unit = "ft";
    const row = flattenPurchases([raw[0]]).find((r) => r.request_line_id === "line-angle");
    expect(row?.unit).toBeNull();
  });

  it("counts distinct purchases", () => {
    expect(countPurchases(rows())).toBe(3);
    expect(countPurchases([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

describe("textMatches", () => {
  it("is a case-insensitive substring match that never matches null", () => {
    expect(textMatches("Delta Steel", "delta")).toBe(true);
    expect(textMatches("Delta Steel", "STEEL")).toBe(true);
    expect(textMatches("Delta Steel", "Alamo")).toBe(false);
    expect(textMatches(null, "")).toBe(false);
  });
});

describe("designationMatches", () => {
  it("ignores case and whitespace on both sides, the way the item search and normalizeAlias do", () => {
    expect(designationMatches("C12x30", "c12 x 30")).toBe(true);
    expect(designationMatches("C12x30", "C12X30")).toBe(true);
    expect(designationMatches("C12x30", " 12x3 ")).toBe(true);
    expect(designationMatches("HSS6x6x3/8", "hss 6 x 6 x 3/8")).toBe(true);
    expect(designationMatches("C12x30", "C12x20")).toBe(false);
  });

  it("never matches a custom line or a blank needle", () => {
    expect(designationMatches(null, "c12")).toBe(false);
    expect(designationMatches("C12x30", "   ")).toBe(false);
    expect(designationMatches("C12x30", "")).toBe(false);
  });
});

describe("confirmedDayText", () => {
  it("shows the UTC day the filter compares on, so a row is found on the date it shows", () => {
    // 00:30Z is the evening before in every US zone; the row shows Oct 29 and from=to=2026-10-29 finds it.
    const at = "2026-10-29T00:30:00.000Z";
    expect(confirmedDayText(at)).toBe("Oct 29, 2026");
    expect(utcDayOf(at)).toBe("2026-10-29");
    expect(inDateRange(at, "2026-10-29", "2026-10-29")).toBe(true);
    expect(inDateRange(at, "2026-10-28", "2026-10-28")).toBe(false);
    expect(confirmedDayText("2026-10-27T21:30:00.000Z")).toBe("Oct 27, 2026");
  });

  it("says unknown date for an instant it cannot read", () => {
    expect(confirmedDayText("garbage")).toBe("unknown date");
  });
});

describe("utcDayOf and inDateRange", () => {
  it("reads the UTC day of an instant", () => {
    expect(utcDayOf("2026-10-27T21:30:00.000Z")).toBe("2026-10-27");
    expect(utcDayOf("2026-10-27T23:59:59.999Z")).toBe("2026-10-27");
    expect(utcDayOf("2026-10-28T00:00:00.000Z")).toBe("2026-10-28");
    expect(utcDayOf("garbage")).toBeNull();
  });

  it("is inclusive on both ends and open when unset", () => {
    const at = "2026-10-27T21:30:00.000Z";
    expect(inDateRange(at, undefined, undefined)).toBe(true);
    expect(inDateRange(at, "2026-10-27", "2026-10-27")).toBe(true);
    expect(inDateRange(at, "2026-10-28", undefined)).toBe(false);
    expect(inDateRange(at, undefined, "2026-10-26")).toBe(false);
    expect(inDateRange(at, "2026-10-01", undefined)).toBe(true);
    expect(inDateRange(at, undefined, "2026-10-31")).toBe(true);
    expect(inDateRange("garbage", "2026-10-01", undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyClientFilters
// ---------------------------------------------------------------------------

describe("applyClientFilters", () => {
  it("returns every row for an empty filter", () => {
    expect(applyClientFilters(rows(), {})).toHaveLength(4);
  });

  it("filters by customer", () => {
    expect(ids(applyClientFilters(rows(), { customer: "acme" }))).toEqual(["line-channel", "line-angle", "line-clip"]);
    expect(ids(applyClientFilters(rows(), { customer: "gulf" }))).toEqual(["line-beam"]);
    expect(applyClientFilters(rows(), { customer: "nobody" })).toEqual([]);
  });

  it("filters by vendor on the vendor or the branch name", () => {
    expect(ids(applyClientFilters(rows(), { vendor: "delta" }))).toEqual(["line-channel", "line-angle"]);
    expect(ids(applyClientFilters(rows(), { vendor: "san antonio" }))).toEqual(["line-clip"]);
  });

  it("filters by category exactly", () => {
    expect(ids(applyClientFilters(rows(), { category: "channel" }))).toEqual(["line-channel"]);
    expect(ids(applyClientFilters(rows(), { category: "w_beam" }))).toEqual(["line-beam"]);
    expect(applyClientFilters(rows(), { category: "plate" })).toEqual([]);
  });

  it("filters by designation, case-insensitive, and never matches a custom line", () => {
    expect(ids(applyClientFilters(rows(), { designation: "c12X30" }))).toEqual(["line-channel"]);
    expect(ids(applyClientFilters(rows(), { designation: "12x" }))).toEqual(["line-channel", "line-beam"]);
    expect(applyClientFilters(rows(), { designation: "clip" })).toEqual([]);
  });

  it("finds a designation typed with spaces, the way brokers write sizes", () => {
    expect(ids(applyClientFilters(rows(), { designation: "c12 x 30" }))).toEqual(["line-channel"]);
    expect(ids(applyClientFilters(rows(), { designation: "C12 X 30" }))).toEqual(["line-channel"]);
    expect(ids(applyClientFilters(rows(), { q: "C12 x 30" }))).toEqual(["line-channel"]);
    expect(ids(applyClientFilters(rows(), { q: "w12 x 26" }))).toEqual(["line-beam"]);
    // Free text through the other fields is still a plain substring match.
    expect(ids(applyClientFilters(rows(), { q: "Delta Steel" }))).toEqual(["line-channel", "line-angle"]);
    expect(applyClientFilters(rows(), { q: "DeltaSteel" })).toEqual([]);
  });

  it("filters by date range on the confirmed day", () => {
    expect(ids(applyClientFilters(rows(), { from: "2026-10-01" }))).toEqual(["line-channel", "line-angle", "line-clip"]);
    expect(ids(applyClientFilters(rows(), { to: "2026-09-30" }))).toEqual(["line-beam"]);
    expect(ids(applyClientFilters(rows(), { from: "2026-09-15", to: "2026-09-15" }))).toEqual(["line-beam"]);
    expect(applyClientFilters(rows(), { from: "2026-11-01" })).toEqual([]);
  });

  it("finds C12x30 by free text through the designation when the description says it another way", () => {
    const result = applyClientFilters(rows(), { q: "C12x30" });
    expect(ids(result)).toEqual(["line-channel"]);
    expect(result[0].line_description).toBe("12 inch channel 30#");
    expect(result[0].designation).toBe("C12x30");
    expect(ids(applyClientFilters(rows(), { q: "c12x30" }))).toEqual(["line-channel"]);
  });

  it("matches free text against description, offered description, PO, vendor, customer, and subject", () => {
    expect(ids(applyClientFilters(rows(), { q: "30#" }))).toEqual(["line-channel"]);
    expect(ids(applyClientFilters(rows(), { q: "per drawing" }))).toEqual(["line-clip"]);
    expect(ids(applyClientFilters(rows(), { q: "4402" }))).toEqual(["line-beam"]);
    expect(ids(applyClientFilters(rows(), { q: "coastal" }))).toEqual(["line-beam"]);
    expect(ids(applyClientFilters(rows(), { q: "gulf" }))).toEqual(["line-beam"]);
    expect(ids(applyClientFilters(rows(), { q: "baytown" }))).toEqual(["line-channel", "line-angle", "line-clip"]);
    expect(applyClientFilters(rows(), { q: "unobtainium" })).toEqual([]);
  });

  it("requires every set field to match", () => {
    expect(ids(applyClientFilters(rows(), { customer: "acme", vendor: "delta", category: "angle" }))).toEqual(["line-angle"]);
    expect(applyClientFilters(rows(), { customer: "acme", vendor: "coastal" })).toEqual([]);
    expect(ids(applyClientFilters(rows(), { q: "A36", from: "2026-10-27", to: "2026-10-27", vendor: "alamo" }))).toEqual(["line-clip"]);
  });

  it("rowMatches lists the searchable fields in a stable order", () => {
    const channel = rows()[0];
    expect(searchableText(channel)).toEqual([
      "C12x30",
      "12 inch channel 30#",
      "C12x30 A36 40 ft",
      "PO-4471",
      "Delta Steel",
      "Houston",
      "Acme Fabrication",
      "Material for the Baytown job",
    ]);
    expect(rowMatches(channel, { q: "houston" })).toBe(true);
  });
});

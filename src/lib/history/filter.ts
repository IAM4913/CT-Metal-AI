// Purchase history search (PRD FR-11, AC-11.2 and AC-11.3). Pure: the filter
// read from the URL, the flattening of the nested purchase rows the server
// query returns into one row per purchase line, and the matching of those rows
// against the filter. The database applies only the date range (searchHistory
// in src/lib/server/history.ts); everything else is matched here so it is
// testable without a database. Phase 1 volumes are tiny. The trigram indexes
// from 0002_search.sql are in place for a server-side ilike later.

import { z } from "zod";
import { materialCategorySchema, type LineUnit, type MaterialCategory, type PriceBasis } from "@/lib/db/enums";
import { formatIsoDay } from "@/lib/parsing/money";

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

const fieldSchemas = {
  customer: z.string().trim().optional(),
  vendor: z.string().trim().optional(),
  category: materialCategorySchema.optional(),
  designation: z.string().trim().optional(),
  /** Inclusive calendar day, yyyy-mm-dd (zod v4: z.iso.date()). */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Free text, matched against the row's text fields. */
  q: z.string().trim().optional(),
};

export const historyFilterSchema = z.object(fieldSchemas);

export type HistoryFilter = z.infer<typeof historyFilterSchema>;

export const HISTORY_FILTER_KEYS = Object.keys(fieldSchemas) as Array<keyof HistoryFilter>;

/** The first value of a repeated query key; an empty or blank string reads as absent. */
function firstValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  return raw.trim() === "" ? undefined : raw;
}

/**
 * The filter from a page's searchParams. Never throws: a value that fails its
 * field schema (a category that is not one, a date that is not yyyy-mm-dd) is
 * dropped and the other fields are kept. Empty strings are absent. A date
 * range given backwards is turned around so it still returns something.
 */
export function parseHistoryFilter(searchParams: Record<string, string | string[] | undefined>): HistoryFilter {
  const candidate: Record<string, string> = {};
  for (const key of HISTORY_FILTER_KEYS) {
    const raw = firstValue(searchParams[key]);
    if (raw !== undefined) candidate[key] = raw;
  }

  // Parse once; on failure drop exactly the fields that failed and parse again.
  let result = historyFilterSchema.safeParse(candidate);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string") delete candidate[key];
    }
    result = historyFilterSchema.safeParse(candidate);
    if (!result.success) return {};
  }

  const filter: HistoryFilter = {};
  for (const key of HISTORY_FILTER_KEYS) {
    const value = result.data[key];
    if (value === undefined || value === "") continue;
    Object.assign(filter, { [key]: value });
  }
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) {
    const from = filter.to;
    filter.to = filter.from;
    filter.from = from;
  }
  return filter;
}

/** True when any field is set. */
export function hasAnyFilter(filter: HistoryFilter): boolean {
  return HISTORY_FILTER_KEYS.some((key) => filter[key] !== undefined);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One purchase line, flattened from the purchase it belongs to and the selection, offer, and request line behind it. */
export type HistoryRow = {
  purchase_id: string;
  confirmed_at: string;
  po_number: string | null;
  request_id: string;
  request_subject: string | null;
  customer_name: string | null;
  vendor_name: string;
  branch_name: string;
  branch_id: string;
  /** The RFQ the offer answered; null when the offer line behind the selection is gone. */
  rfq_id: string | null;
  offer_id: string | null;
  /** The reply message that produced the offer, when it came in as mail. */
  message_id: string | null;
  /** The quote file (PDF) the offer came from, when there is one. */
  attachment_id: string | null;
  request_line_id: string;
  line_description: string;
  /** Canonical designation of the linked catalog item; null for a custom line. */
  designation: string | null;
  category: MaterialCategory | null;
  /** The quantity bought, in the request line's unit (sourcing_selections.qty). */
  qty: number;
  unit: LineUnit | null;
  unit_price: number | null;
  price_basis: PriceBasis | null;
  offered_desc: string;
};

// The nested shape searchHistory selects. Every embedded object may be null:
// PostgREST returns null for a to-one embed whose row is not visible, and the
// flattener must not throw on a row the broker can still see.

export type RawHistoryRequestLine = {
  id: string;
  description: string;
  category: MaterialCategory | null;
  catalog_item_id: string | null;
  unit: LineUnit | null;
  catalog_items: { designation: string } | null;
};

export type RawHistoryOffer = {
  id: string;
  rfq_id: string;
  message_id: string | null;
  attachment_id: string | null;
  branch_id: string;
};

export type RawHistoryOfferLine = {
  id: string;
  offer_id: string;
  offered_desc: string;
  unit_price: number | null;
  price_basis: PriceBasis | null;
  unit: LineUnit | null;
  vendor_offers: RawHistoryOffer | null;
  request_lines: RawHistoryRequestLine | null;
};

export type RawHistorySelection = {
  id: string;
  request_line_id: string;
  qty: number;
  offer_lines: RawHistoryOfferLine | null;
};

export type RawHistoryPurchaseLine = {
  id: string;
  sourcing_selections: RawHistorySelection | null;
};

export type RawHistoryPurchase = {
  id: string;
  confirmed_at: string;
  po_number: string | null;
  request_id: string;
  branch_id: string;
  vendor_branches: { name: string; vendors: { name: string } | null } | null;
  requests: { subject: string; customers: { name: string } | null } | null;
  purchase_lines: RawHistoryPurchaseLine[];
};

function blankToNull(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return text.trim() === "" ? null : text;
}

/**
 * One HistoryRow per purchase line. The purchases keep the order they came in
 * (confirmed_at desc from the query); lines inside a purchase are ordered by
 * designation or description so the table is stable. A purchase line whose
 * selection is not visible is skipped: there is nothing to show for it.
 */
export function flattenPurchases(raw: readonly RawHistoryPurchase[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const purchase of raw) {
    const purchaseRows: HistoryRow[] = [];
    for (const line of purchase.purchase_lines) {
      const selection = line.sourcing_selections;
      if (selection === null) continue;
      const offerLine = selection.offer_lines;
      const offer = offerLine?.vendor_offers ?? null;
      const requestLine = offerLine?.request_lines ?? null;
      purchaseRows.push({
        purchase_id: purchase.id,
        confirmed_at: purchase.confirmed_at,
        po_number: blankToNull(purchase.po_number),
        request_id: purchase.request_id,
        request_subject: blankToNull(purchase.requests?.subject),
        customer_name: blankToNull(purchase.requests?.customers?.name),
        vendor_name: purchase.vendor_branches?.vendors?.name ?? "Unknown vendor",
        branch_name: purchase.vendor_branches?.name ?? "Unknown branch",
        branch_id: purchase.branch_id,
        rfq_id: offer?.rfq_id ?? null,
        offer_id: offer?.id ?? null,
        message_id: offer?.message_id ?? null,
        attachment_id: offer?.attachment_id ?? null,
        request_line_id: selection.request_line_id,
        line_description: requestLine?.description ?? "",
        designation: blankToNull(requestLine?.catalog_items?.designation),
        category: requestLine?.category ?? null,
        qty: selection.qty,
        // The selection counts in the request line's unit. The offer line's unit is
        // the vendor's and may differ (8 pcs is not 8 ft), so it is never used as a label.
        unit: requestLine?.unit ?? null,
        unit_price: offerLine?.unit_price ?? null,
        price_basis: offerLine?.price_basis ?? null,
        offered_desc: offerLine?.offered_desc ?? "",
      });
    }
    purchaseRows.sort((a, b) => compareText(rowItemText(a), rowItemText(b)) || compareText(a.request_line_id, b.request_line_id));
    rows.push(...purchaseRows);
  }
  return rows;
}

/** What the table shows in the item column: the designation when linked, else the description. */
export function rowItemText(row: Pick<HistoryRow, "designation" | "line_description">): string {
  return row.designation ?? row.line_description;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Case-insensitive substring match; a null field never matches. */
export function textMatches(field: string | null, needle: string): boolean {
  if (field === null) return false;
  return field.toLowerCase().includes(needle.toLowerCase());
}

/**
 * A designation match ignores case and whitespace on both sides, so "C12 x 30"
 * and "c12x30" both find C12x30 (the same folding normalizeAlias and the item
 * search apply). A null designation (a custom line) never matches.
 */
export function designationMatches(designation: string | null, needle: string): boolean {
  if (designation === null) return false;
  const folded = needle.replace(/\s+/g, "").toLowerCase();
  if (folded === "") return false;
  return designation.replace(/\s+/g, "").toLowerCase().includes(folded);
}

/**
 * The UTC calendar day of a confirmed_at instant, formatted for the table
 * ("Oct 28, 2026"). The filter compares on the UTC day (inDateRange, and the
 * query bounds in src/lib/server/history.ts), so the day shown is the day a
 * search finds, whatever zone the server runs in. "unknown date" when the
 * instant cannot be read.
 */
export function confirmedDayText(confirmedAt: string): string {
  const day = utcDayOf(confirmedAt);
  return (day === null ? null : formatIsoDay(day)) ?? "unknown date";
}

/** The UTC calendar day (yyyy-mm-dd) of an instant; null when it cannot be read. */
export function utcDayOf(iso: string): string | null {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/** Inclusive on both ends, compared on the UTC day (the same boundary the server query applies). */
export function inDateRange(confirmedAt: string, from: string | undefined, to: string | undefined): boolean {
  if (from === undefined && to === undefined) return true;
  const day = utcDayOf(confirmedAt);
  if (day === null) return false;
  if (from !== undefined && day < from) return false;
  if (to !== undefined && day > to) return false;
  return true;
}

/** The fields free text is matched against (AC-11.2). */
export function searchableText(row: HistoryRow): Array<string | null> {
  return [
    row.designation,
    row.line_description,
    row.offered_desc,
    row.po_number,
    row.vendor_name,
    row.branch_name,
    row.customer_name,
    row.request_subject,
  ];
}

/** Whether one row passes every set field of the filter. */
export function rowMatches(row: HistoryRow, filter: HistoryFilter): boolean {
  if (filter.customer !== undefined && !textMatches(row.customer_name, filter.customer)) return false;
  if (filter.vendor !== undefined && !textMatches(row.vendor_name, filter.vendor) && !textMatches(row.branch_name, filter.vendor)) {
    return false;
  }
  if (filter.category !== undefined && row.category !== filter.category) return false;
  if (filter.designation !== undefined && !designationMatches(row.designation, filter.designation)) return false;
  if (!inDateRange(row.confirmed_at, filter.from, filter.to)) return false;
  if (filter.q !== undefined) {
    const needle = filter.q;
    if (!designationMatches(row.designation, needle) && !searchableText(row).some((field) => textMatches(field, needle))) return false;
  }
  return true;
}

/**
 * The rows that pass the filter, in their incoming order. Customer, vendor
 * (vendor or branch name), and free text are case-insensitive substring
 * matches; designation also ignores whitespace ("C12 x 30" finds C12x30);
 * category is exact; the date range is inclusive on the UTC day. Free text
 * looks at the designation (whitespace ignored), the request line description,
 * the offered description, the PO number, the vendor and branch names, the
 * customer name, and the request subject.
 */
export function applyClientFilters(rows: readonly HistoryRow[], filter: HistoryFilter): HistoryRow[] {
  return rows.filter((row) => rowMatches(row, filter));
}

/** Distinct purchase ids among the rows, for the "n lines from m purchases" summary. */
export function countPurchases(rows: readonly HistoryRow[]): number {
  return new Set(rows.map((row) => row.purchase_id)).size;
}

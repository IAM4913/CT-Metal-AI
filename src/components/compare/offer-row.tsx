"use client";

// One offer row of the per-line comparison table (PRD section 8, AC-10.1 to
// AC-10.5): the TanStack column model, the cell renderers, and the text rules
// for values the vendor did not give.
//
// Text rules, applied in every cell here and reused by the dialog and chips:
//   - A missing price, freight, quantity, date, or term renders as the word
//     "unknown". Never 0, never $0.00 (PRD section 8 rule 1).
//   - An extended cost the lib could not compute renders as
//     "cannot compute: <reason>" (AC-10.4); a per-foot price it could not
//     normalize renders as "not comparable: <reason>" (rule 2).
//   - Early pay is a scenario, "if paid in N days: $X", never folded into the
//     price (AC-10.5, rule 4).
//   - Freight the vendor folded into the price renders as "included in price"
//     (the lib counts it as known, at nothing extra); a missing amount on any
//     other basis is "unknown" with the basis beside it.
//   - The Available cell nets the vendor's quantity against the requested one
//     only when both are in one unit (OfferCell.same_unit); otherwise it says
//     so, with both quantities, rather than calling either unknown.
//   - A request line is named by its catalog designation, else the customer's
//     own words (PRD section 8: "canonical or raw"), never the parser's word
//     alone (requestedItemTitle).
// Every number shown comes from the ComparisonModel built in
// src/lib/compare/build.ts; nothing is computed in this file beyond picking a
// default quantity for the select input (the smaller of requested and
// available when both are known in one unit, the requested quantity when the
// vendor counts in another unit, blank when either is unknown).
//
// Selecting: an exact row has a quantity input and a Select button that writes
// at once. An alternate row has only a button that opens the confirm dialog
// (select-dialog.tsx), which names every changed attribute before anything is
// written (rule 3). A row on an offer the vendor declined has no control at all
// (selectionBlockedReason; the server refuses it too). readOnly (the request is
// already sourced) hides every control.

import { createColumnHelper, tableFeatures, type CellContext } from "@tanstack/react-table";
import { format, isValid, parseISO } from "date-fns";
import Link from "next/link";
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { selectionBlockedReason, type LineComparison, type OfferCell } from "@/lib/compare/build";
import { hasValue, type CostResult } from "@/lib/compare/cost";
import type { AlternateType, Availability, FreightBasis, LineUnit, PriceBasis } from "@/lib/db/enums";
import { formatIsoDay, isoDayOf } from "@/lib/parsing/money";

// ---------------------------------------------------------------------------
// Text rules
// ---------------------------------------------------------------------------

/** The one word for a value the vendor did not give. */
export const UNKNOWN = "unknown";

/** Marker for optional free text that was simply not written (delivery estimate). */
const EMPTY = "-";

export const PRICE_BASIS_LABELS: Record<PriceBasis, string> = {
  per_cwt: "/cwt",
  per_lb: "/lb",
  per_ft: "/ft",
  per_pc: "/pc",
  per_ton: "/ton",
  per_sqft: "/sqft",
};

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  stock: "In stock",
  rolling: "Rolling",
  unknown: "Unknown",
};

export const FREIGHT_BASIS_LABELS: Record<FreightBasis, string> = {
  included: "included",
  separate: "separate",
  unknown: "basis unknown",
};

export const ALTERNATE_LABELS: Record<AlternateType, string> = {
  grade: "grade differs",
  dimension: "dimension differs",
  wall: "wall differs",
  length: "length differs",
};

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Whole dollars and cents: $1,234.56. */
export function formatMoney(value: number): string {
  return money.format(value);
}

/** A unit price keeps up to four decimals ($0.6250/lb is a real quote). */
export function formatUnitPrice(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/** "20 pcs", "20" when the unit is unknown, or "unknown" when the quantity is. */
export function formatQty(qty: number | null, unit: LineUnit | null): string {
  if (qty === null) return UNKNOWN;
  return unit === null ? formatNumber(qty) : `${formatNumber(qty)} ${unit}`;
}

/** Extended material cost (AC-10.4). */
export function extendedText(result: CostResult): string {
  return hasValue(result) ? formatMoney(result.value) : `cannot compute: ${result.reason}`;
}

/** Per-foot price for the comparability column (PRD section 8 rule 2). */
export function perFootText(result: CostResult): string {
  return hasValue(result) ? `${formatUnitPrice(result.value)}/ft` : `not comparable: ${result.reason}`;
}

/** Unit price with its native basis, or "unknown". */
export function unitPriceText(unitPrice: number | null, basis: PriceBasis | null): string {
  if (unitPrice === null) return UNKNOWN;
  return basis === null ? `${formatUnitPrice(unitPrice)} (no basis)` : `${formatUnitPrice(unitPrice)}${PRICE_BASIS_LABELS[basis]}`;
}

/**
 * Freight amount; "included in price" when the vendor folded it into the price
 * (the lib counts that as known freight at nothing extra, freightKnown); else
 * "unknown" (PRD section 8 rule 1). The cell shows the basis beside an amount.
 */
export function freightText(amount: number | null, basis: FreightBasis): string {
  if (amount !== null) return formatMoney(amount);
  return basis === "included" ? "included in price" : UNKNOWN;
}

/** The early-pay scenario line (AC-10.5): "if paid in 10 days: $123.45", or "n/a" when no terms were given. */
export function earlyPayText(early: OfferCell["early_pay"]): string {
  if (early.pct === null) return "n/a";
  const when = early.days === null ? "if paid early" : `if paid in ${early.days} days`;
  if (hasValue(early.savings)) return `${when}: ${formatMoney(early.savings.value)}`;
  return `${when} (${early.pct}%): ${UNKNOWN}, ${early.savings.reason}`;
}

/**
 * A date-only string (offer_lines.ready_date) as "Nov 5, 2026"; "unknown" when
 * null; the raw text when it does not parse. parseISO reads a date-only string
 * as local midnight, so the day shown is the day stored. Not for the quote
 * expiry, a timestamp: see expiryText.
 */
export function formatDay(iso: string | null): string {
  if (iso === null) return UNKNOWN;
  const parsed = parseISO(iso);
  return isValid(parsed) ? format(parsed, "MMM d, yyyy") : iso;
}

/**
 * The quote expiry as "Nov 30, 2026" from its stored UTC day. The expiry is a
 * calendar day stored at 00:00 UTC (toExpiryTimestamp, parseQuoteExpiry), which
 * is the evening before in every US zone, so it is never formatted through the
 * browser's zone; the Offers tab shows it the same way (offer-card.tsx).
 * "unknown" when null.
 */
export function expiryText(iso: string | null): string {
  if (iso === null) return UNKNOWN;
  const day = isoDayOf(iso);
  return formatIsoDay(day) ?? day ?? UNKNOWN;
}

/** What changed on an alternate: the lib's text per changed attribute, else the alternate type names. */
export function changedList(cell: Pick<OfferCell, "is_exact_match" | "changed" | "alternate_types">): string[] {
  if (cell.is_exact_match) return [];
  if (cell.changed.length > 0) return cell.changed;
  if (cell.alternate_types.length > 0) return cell.alternate_types.map((type) => ALTERNATE_LABELS[type]);
  return ["differs from the request (the reply did not say how)"];
}

/** "800 ft", or "10 (unit unknown)" when no unit was given with the number. */
function qtyUnitText(qty: number, unit: LineUnit | null): string {
  return unit === null ? `${formatNumber(qty)} (unit unknown)` : `${formatNumber(qty)} ${unit}`;
}

/**
 * The unfilled balance against the requested quantity, as text for the
 * Available cell: "balance unknown" when the vendor named no quantity,
 * "requested qty unknown" when the request has none, "not compared" with both
 * quantities when they are not in one unit (the lib nets nothing then), else
 * the shortfall or "covers the request".
 */
export function unfilledText(
  cell: Pick<OfferCell, "available_qty" | "unit" | "same_unit" | "unfilled">,
  requestedQty: number | null,
  requestedUnit: LineUnit | null,
): string {
  if (cell.available_qty === null) return `balance ${UNKNOWN}`;
  if (requestedQty === null) return `requested qty ${UNKNOWN}`;
  if (!cell.same_unit) return `not compared: ${qtyUnitText(cell.available_qty, cell.unit)} offered, ${qtyUnitText(requestedQty, requestedUnit)} requested`;
  if (cell.unfilled === null) return `balance ${UNKNOWN}`;
  if (cell.unfilled > 0) return `${formatQty(cell.unfilled, requestedUnit)} short`;
  return "covers the request";
}

/**
 * The default quantity for the select input, in the request's unit: the
 * smaller of requested and available when both are known in one unit; the
 * requested quantity when the vendor counts in another unit (the row's
 * extended cost is priced for it, fillableQty in build.ts, and the two numbers
 * cannot be compared); null when the requested quantity is unknown or the
 * available one is unknown in the same unit (the input stays blank and the
 * broker types the number). Never a number in the vendor's unit.
 */
export function defaultSelectQty(requested: number | null, available: number | null, sameUnit: boolean): number | null {
  if (requested === null || requested <= 0) return null;
  if (!sameUnit) return requested;
  if (available === null) return null;
  const qty = Math.min(requested, available);
  return qty > 0 ? qty : null;
}

/**
 * How a request line is named on the Compare tab (PRD section 8, "requested
 * item (canonical or raw)"): the catalog designation when the line is linked,
 * else the customer's own words (raw_text), else the parser's description. The
 * secondary line is the description when it says something the title does not.
 */
export function requestedItemTitle(line: Pick<LineComparison["line"], "designation" | "raw_text" | "description">): {
  title: string;
  secondary: string | null;
} {
  const raw = line.raw_text.trim();
  const description = line.description.trim();
  const title = line.designation ?? (raw !== "" ? raw : description !== "" ? description : "(no text)");
  const secondary = description !== "" && description !== title ? description : null;
  return { title, secondary };
}

/** A typed quantity: a positive finite number, or an error message. */
export function parseQty(raw: string): { value: number } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "Enter a quantity." };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return { error: "Enter a positive number." };
  return { value: n };
}

// ---------------------------------------------------------------------------
// Table meta shared with line-comparison.tsx
// ---------------------------------------------------------------------------

export type OfferRowMeta = {
  requestId: string;
  requestedQty: number | null;
  requestedUnit: LineUnit | null;
  /** Selected quantity on this request line, by offer line id. */
  selectedQty: ReadonlyMap<string, number>;
  /** The request is sourced or closed: no selection changes. */
  readOnly: boolean;
  /** Exact rows write at once. Resolves to an error message, or null when saved. */
  onSelectExact: (cell: OfferCell, qty: number) => Promise<string | null>;
  /** Alternate rows open the confirm dialog; nothing is written until it confirms. */
  onOpenAlternate: (cell: OfferCell) => void;
};

export const offerFeatures = tableFeatures({ tableMeta: {} as OfferRowMeta });
const helper = createColumnHelper<typeof offerFeatures, OfferCell>();
type Ctx<TValue> = CellContext<typeof offerFeatures, OfferCell, TValue>;

// Structural parameter: CellContext is invariant in its value type, so a
// Ctx<string> would not pass where Ctx<unknown> is asked for.
function metaOf(info: { table: { options: { meta?: OfferRowMeta } } }): OfferRowMeta {
  const meta = info.table.options.meta;
  if (!meta) throw new Error("Offer table: meta was not provided");
  return meta;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

const badgeBase = "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium";
export const EXACT_BADGE = `${badgeBase} border-emerald-200 bg-emerald-50 text-emerald-800`;
export const ALTERNATE_BADGE = `${badgeBase} border-amber-300 bg-amber-100 text-amber-900`;
const INCOMPLETE_BADGE = `${badgeBase} border-amber-200 bg-amber-50 text-amber-800`;
const DECLINED_BADGE = `${badgeBase} border-zinc-300 bg-zinc-100 text-zinc-700`;

function Unknown({ text = UNKNOWN }: { text?: string }) {
  return <span className="italic text-zinc-500">{text}</span>;
}

function VendorCell(info: Ctx<string>) {
  const cell = info.row.original;
  return (
    <div className="flex min-w-[9rem] flex-col gap-1">
      <span className="font-medium text-zinc-900">{cell.vendor_name}</span>
      <span className="text-xs text-zinc-600">{cell.branch_name}</span>
      {cell.offer_status === "declined" ? (
        <span className={DECLINED_BADGE} title="The vendor declined this RFQ. The line is kept for the record.">
          declined
        </span>
      ) : null}
      {cell.incomplete ? (
        <span className={INCOMPLETE_BADGE} title="A price, the freight, or the extended cost is unknown, so this offer is left out of totals.">
          incomplete
        </span>
      ) : null}
    </div>
  );
}

function OfferedCell(info: Ctx<unknown>) {
  const cell = info.row.original;
  const changed = changedList(cell);
  return (
    <div className="flex min-w-[12rem] flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {cell.is_exact_match ? <span className={EXACT_BADGE}>exact</span> : <span className={ALTERNATE_BADGE}>alternate</span>}
        <span className="font-medium text-zinc-900">{cell.offered_designation ?? cell.offered_desc}</span>
      </div>
      {cell.offered_designation !== null && cell.offered_designation !== cell.offered_desc ? (
        <span className="text-xs text-zinc-500">{cell.offered_desc}</span>
      ) : null}
      {changed.length > 0 ? (
        <ul className="list-disc pl-4 text-xs text-amber-900">
          {changed.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
      {cell.flags.length > 0 ? <span className="text-xs text-zinc-500">flags: {cell.flags.join(", ")}</span> : null}
    </div>
  );
}

function AvailableCell(info: Ctx<number | null>) {
  const meta = metaOf(info);
  const cell = info.row.original;
  const balance = unfilledText(cell, meta.requestedQty, meta.requestedUnit);
  const short = cell.unfilled !== null && cell.unfilled > 0;
  return (
    <div className="flex flex-col gap-0.5 tabular-nums">
      {cell.available_qty === null ? <Unknown /> : <span className="whitespace-nowrap">{formatQty(cell.available_qty, cell.unit)}</span>}
      <span className={short ? "text-xs font-medium text-amber-800" : "max-w-[12rem] text-xs text-zinc-500"}>{balance}</span>
    </div>
  );
}

function AvailabilityCell(info: Ctx<Availability>) {
  const value = info.getValue();
  if (value === "unknown") return <Unknown />;
  return <span className="whitespace-nowrap">{AVAILABILITY_LABELS[value]}</span>;
}

function ReadyDateCell(info: Ctx<string | null>) {
  const value = info.getValue();
  if (value === null) return <Unknown />;
  return <span className="whitespace-nowrap tabular-nums">{formatDay(value)}</span>;
}

function DeliveryCell(info: Ctx<string | null>) {
  const value = info.getValue();
  if (value === null || value.trim() === "") return <span className="text-zinc-400">{EMPTY}</span>;
  return <span className="block max-w-[12rem] text-xs text-zinc-700">{value}</span>;
}

function PriceCell(info: Ctx<number | null>) {
  const cell = info.row.original;
  if (cell.unit_price === null) return <Unknown />;
  return <span className="whitespace-nowrap tabular-nums">{unitPriceText(cell.unit_price, cell.price_basis)}</span>;
}

function PerFootCell(info: Ctx<unknown>) {
  const cell = info.row.original;
  if (hasValue(cell.per_ft)) return <span className="whitespace-nowrap tabular-nums">{perFootText(cell.per_ft)}</span>;
  return <span className="block max-w-[10rem] text-xs italic text-zinc-500">{perFootText(cell.per_ft)}</span>;
}

function ExtendedCell(info: Ctx<unknown>) {
  const cell = info.row.original;
  if (hasValue(cell.extended)) {
    return <span className="whitespace-nowrap font-medium tabular-nums text-zinc-900">{extendedText(cell.extended)}</span>;
  }
  return <span className="block max-w-[10rem] text-xs italic text-zinc-500">{extendedText(cell.extended)}</span>;
}

function FreightCell(info: Ctx<number | null>) {
  const cell = info.row.original;
  const included = cell.freight_amount === null && cell.freight_basis === "included";
  const text = freightText(cell.freight_amount, cell.freight_basis);
  return (
    <div className="flex flex-col gap-0.5 whitespace-nowrap">
      {cell.freight_amount !== null ? <span className="tabular-nums">{text}</span> : included ? <span className="text-xs text-zinc-700">{text}</span> : <Unknown />}
      {included ? null : <span className="text-xs text-zinc-500">{FREIGHT_BASIS_LABELS[cell.freight_basis]}</span>}
    </div>
  );
}

function TermsCell(info: Ctx<string | null>) {
  const value = info.getValue();
  if (value === null || value.trim() === "") return <Unknown />;
  return <span className="block max-w-[9rem] text-xs text-zinc-700">{value}</span>;
}

function EarlyPayCell(info: Ctx<unknown>) {
  const cell = info.row.original;
  const text = earlyPayText(cell.early_pay);
  if (cell.early_pay.pct === null) return <span className="text-zinc-400">{text}</span>;
  const known = hasValue(cell.early_pay.savings);
  return (
    <span className={known ? "block max-w-[11rem] text-xs text-emerald-900" : "block max-w-[11rem] text-xs italic text-zinc-500"}>
      {text}
    </span>
  );
}

function ExpiresCell(info: Ctx<string | null>) {
  const value = info.getValue();
  if (value === null) return <Unknown />;
  return <span className="whitespace-nowrap tabular-nums">{expiryText(value)}</span>;
}

const linkClass = "font-medium text-zinc-700 underline hover:text-zinc-900";

function SourceCell(info: Ctx<unknown>) {
  const meta = metaOf(info);
  const cell = info.row.original;
  const hasAny = cell.source.message_id !== null || cell.source.attachment_id !== null;
  if (!hasAny) return <span className="text-xs text-zinc-500">phone or manual quote</span>;
  return (
    <div className="flex flex-col gap-0.5 whitespace-nowrap text-xs">
      {cell.source.message_id !== null ? (
        <Link href={`/requests/${meta.requestId}/offers#offer-${cell.offer_id}-heading`} className={linkClass}>
          reply
        </Link>
      ) : null}
      {cell.source.attachment_id !== null ? (
        <a href={`/attachments/${cell.source.attachment_id}`} target="_blank" rel="noopener noreferrer" className={linkClass}>
          quote file
        </a>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select control
// ---------------------------------------------------------------------------

const selectButton =
  "rounded bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400";
const alternateButton =
  "rounded border border-amber-400 bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50";
const qtyInput =
  "w-20 rounded border bg-white px-1.5 py-1 text-right text-sm tabular-nums text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50 disabled:text-zinc-400";

type SelectControlProps = {
  cell: OfferCell;
  meta: OfferRowMeta;
  /** Quantity already selected from this offer line, or null. */
  existing: number | null;
};

function SelectControl({ cell, meta, existing }: SelectControlProps) {
  const initial = existing ?? defaultSelectQty(meta.requestedQty, cell.available_qty, cell.same_unit);
  const [draft, setDraft] = useState(initial === null ? "" : String(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unit = meta.requestedUnit;

  if (meta.readOnly) {
    return existing === null ? (
      <span className="text-xs text-zinc-400">{EMPTY}</span>
    ) : (
      <span className="whitespace-nowrap text-xs font-medium text-emerald-800">Selected {formatQty(existing, unit)}</span>
    );
  }

  // A declined offer's line is kept for the record and cannot be selected.
  const blocked = selectionBlockedReason(cell.offer_status);
  if (blocked !== null) {
    return (
      <div className="flex flex-col items-start gap-1" title={blocked}>
        {existing !== null ? (
          <span className="whitespace-nowrap text-xs font-medium text-amber-900">Selected {formatQty(existing, unit)} (vendor declined)</span>
        ) : null}
        <span className="text-xs text-zinc-400">{EMPTY}</span>
      </div>
    );
  }

  if (!cell.is_exact_match) {
    return (
      <div className="flex flex-col items-start gap-1">
        {existing !== null ? (
          <span className="whitespace-nowrap text-xs font-medium text-amber-900">Selected {formatQty(existing, unit)}</span>
        ) : null}
        <button
          type="button"
          onClick={() => meta.onOpenAlternate(cell)}
          className={alternateButton}
          title="This is an alternate. Selecting it asks you to confirm what changed."
        >
          {existing === null ? "Select alternate..." : "Change..."}
        </button>
      </div>
    );
  }

  async function select() {
    const parsed = parseQty(draft);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    const message = await meta.onSelectExact(cell, parsed.value);
    setSaving(false);
    setError(message);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void select();
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="decimal"
          aria-label={`Quantity to select from ${cell.vendor_name} ${cell.branch_name}`}
          value={draft}
          placeholder="qty"
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          className={`${qtyInput} ${error ? "border-red-400" : "border-zinc-300"}`}
        />
        <button type="button" disabled={saving || draft.trim() === ""} onClick={() => void select()} className={selectButton}>
          {saving ? "Saving..." : existing === null ? "Select" : "Update"}
        </button>
      </div>
      {existing !== null ? (
        <span className="whitespace-nowrap text-xs font-medium text-emerald-800">Selected {formatQty(existing, unit)}</span>
      ) : initial === null ? (
        <span className="text-xs text-zinc-500">type a quantity</span>
      ) : null}
      {error ? (
        <p role="alert" className="max-w-[12rem] text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SelectCell(info: Ctx<unknown>) {
  const meta = metaOf(info);
  const cell = info.row.original;
  const existing = meta.selectedQty.get(cell.offer_line_id) ?? null;
  // Keyed by the saved quantity so a refresh after a successful save remounts
  // the input with the stored value, while a failed save keeps what was typed.
  return <SelectControl key={`${existing ?? "none"}:${meta.readOnly ? "ro" : "rw"}:${cell.offer_status}`} cell={cell} meta={meta} existing={existing} />;
}

// ---------------------------------------------------------------------------
// Column model (module scope so it stays stable between renders)
// ---------------------------------------------------------------------------

export const offerColumns = helper.columns([
  helper.accessor("vendor_name", { header: "Vendor", cell: VendorCell }),
  helper.display({ id: "offered", header: "Offered", cell: OfferedCell }),
  helper.accessor("available_qty", { header: "Available", cell: AvailableCell }),
  helper.accessor("availability", { header: "Availability", cell: AvailabilityCell }),
  helper.accessor("ready_date", { header: "Ready", cell: ReadyDateCell }),
  helper.accessor("delivery_estimate_text", { header: "Delivery", cell: DeliveryCell }),
  helper.accessor("unit_price", { header: "Unit price", cell: PriceCell }),
  helper.display({ id: "per_ft", header: "Per ft", cell: PerFootCell }),
  helper.display({ id: "extended", header: "Extended", cell: ExtendedCell }),
  helper.accessor("freight_amount", { header: "Freight", cell: FreightCell }),
  helper.accessor("payment_terms", { header: "Terms", cell: TermsCell }),
  helper.display({ id: "early_pay", header: "Early pay", cell: EarlyPayCell }),
  helper.accessor("quote_expires_at", { header: "Expires", cell: ExpiresCell }),
  helper.display({ id: "source", header: "Reply", cell: SourceCell }),
  helper.display({ id: "select", header: "Select", cell: SelectCell }),
]);

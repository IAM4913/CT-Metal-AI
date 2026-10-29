"use client";

// The editable offer lines grid (PRD AC-9.3): the same TanStack Table v9
// pattern as the Review tab's lines grid (src/components/review/lines-grid.tsx)
// applied to offer_lines. Every cell commits a one-field patch on blur or Enter
// (text, numbers, dates) or on change (selects, checkboxes). The server action
// writes the row, recomputes the flags, and logs before/after; the workspace
// then refreshes the page, so the value shown is always what the database has.
// A cell that failed to save keeps the typed value and shows the error under it.
// As on the Review tab a row can be removed (a spurious extraction) and a line
// added by hand below the table (one the model could not tie and left in the
// offer notes, or one the extraction missed), so a fix never needs Re-extract,
// which replaces every line.
//
// The extractor never fills a blank and neither does this grid: a missing
// price, quantity, or date stays blank with its flag until the broker types it.
//
// The review grid's cell components are module-private and its FlagChips is
// typed to the request line flags, so the cells and chips here mirror those
// files rather than importing them.

import { createColumnHelper, tableFeatures, useTable, type CellContext } from "@tanstack/react-table";
import { useMemo, useRef, useState, useTransition, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  alternateTypeValues,
  availabilityValues,
  lineUnitValues,
  priceBasisValues,
  type AlternateType,
  type Availability,
  type LineUnit,
  type PriceBasis,
} from "@/lib/db/enums";
import type { SourceSpan } from "@/lib/parsing/document";
import type { OfferFlag } from "@/lib/parsing/offers-schema";

// ---------------------------------------------------------------------------
// Row and patch types shared with the card, the workspace, and the page
// ---------------------------------------------------------------------------

/** One request line as the grid's "request line" select and the manual form show it. */
export type OfferRequestLine = {
  id: string;
  line_no: number;
  description: string;
  qty: number | null;
  unit: LineUnit | null;
};

/** One offer_lines row, serialized for the client, plus the offered item's designation. */
export type OfferLineRow = {
  id: string;
  offer_id: string;
  request_line_id: string | null;
  offered_desc: string;
  offered_catalog_item_id: string | null;
  offered_designation: string | null;
  is_exact_match: boolean;
  alternate_types: AlternateType[];
  available_qty: number | null;
  unit: LineUnit | null;
  availability: Availability;
  /** ISO date, yyyy-MM-dd. */
  ready_date: string | null;
  delivery_estimate_text: string | null;
  unit_price: number | null;
  price_basis: PriceBasis | null;
  flags: OfferFlag[];
  confidence: number;
  source_span: SourceSpan | null;
};

/** The fields a broker can change from the grid; mirrors the offer line patch accepted by updateOfferLine. */
export type OfferLinePatch = Partial<{
  request_line_id: string;
  offered_desc: string;
  is_exact_match: boolean;
  alternate_types: AlternateType[];
  available_qty: number | null;
  unit: LineUnit | null;
  availability: Availability;
  ready_date: string | null;
  delivery_estimate_text: string | null;
  unit_price: number | null;
  price_basis: PriceBasis | null;
}>;

/** A line typed into the add row: the shape addOfferLine and createManualOffer take (manualOfferLineSchema in src/lib/server/offers.ts). */
export type OfferLineAddInput = {
  requestLineId: string;
  offeredDesc: string;
  isExactMatch: boolean;
  alternateTypes: AlternateType[];
  availableQty: number | null;
  unit: LineUnit | null;
  availability: Availability;
  /** yyyy-MM-dd */
  readyDate: string | null;
  deliveryEstimateText: string | null;
  unitPrice: number | null;
  priceBasis: PriceBasis | null;
};

type GridMeta = {
  requestLines: OfferRequestLine[];
  selectedLineId: string | null;
  onSelect: (lineId: string) => void;
  /** Resolves to an error message, or null when the write succeeded. */
  onEdit: (lineId: string, patch: OfferLinePatch) => Promise<string | null>;
  onRemove: (lineId: string) => Promise<string | null>;
  readOnly: boolean;
};

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  stock: "In stock",
  rolling: "Rolling",
  unknown: "Unknown",
};

export const PRICE_BASIS_LABELS: Record<PriceBasis, string> = {
  per_cwt: "/cwt",
  per_lb: "/lb",
  per_ft: "/ft",
  per_pc: "/pc",
  per_ton: "/ton",
  per_sqft: "/sqft",
};

const AVAILABILITY_OPTIONS = availabilityValues.map((value) => ({ value, label: AVAILABILITY_LABELS[value] }));
const PRICE_BASIS_OPTIONS = priceBasisValues.map((value) => ({ value, label: PRICE_BASIS_LABELS[value] }));
const UNIT_OPTIONS = lineUnitValues.map((value) => ({ value, label: value }));

/** ASCII hyphen as the empty-cell marker. The flags column says why a cell is empty. */
const EMPTY = "-";

/** "3. HSS8x8x3/8 (20 pcs)" for the request line select and the manual form. */
export function requestLineLabel(line: OfferRequestLine): string {
  const qty = line.qty === null ? "" : ` (${line.qty}${line.unit ? ` ${line.unit}` : ""})`;
  return `${line.line_no}. ${line.description}${qty}`;
}

// ---------------------------------------------------------------------------
// Flag chips (offer_lines.flags, the app's closed list in offers-schema.ts)
// ---------------------------------------------------------------------------

const FLAG_CLASSES: Record<OfferFlag, string> = {
  missing_price: "border-amber-200 bg-amber-50 text-amber-800",
  missing_qty: "border-amber-200 bg-amber-50 text-amber-800",
  missing_availability: "border-amber-200 bg-amber-50 text-amber-800",
  ambiguous_unit: "border-violet-200 bg-violet-50 text-violet-800",
  ambiguous_basis: "border-violet-200 bg-violet-50 text-violet-800",
  unmatched_line: "border-rose-200 bg-rose-50 text-rose-800",
  possible_duplicate: "border-sky-200 bg-sky-50 text-sky-800",
};

const FLAG_TITLES: Record<OfferFlag, string> = {
  missing_price: "No price in the reply. Shown as unknown on the comparison, never zero.",
  missing_qty: "No available quantity in the reply.",
  missing_availability: "The reply does not say whether this is stock or rolling.",
  ambiguous_unit: "A quantity with no unit, or a unit that could mean two things.",
  ambiguous_basis: "The price could be read against more than one basis (cwt, ft, lb, pc).",
  unmatched_line: "This offer line could not be tied to a line in the RFQ. Pick the request line.",
  possible_duplicate: "Another line in this offer quotes the same request line and item.",
};

export function offerFlagLabel(flag: OfferFlag): string {
  return flag.replace(/_/g, " ");
}

export function OfferFlagChip({ flag }: { flag: OfferFlag }) {
  return (
    <span
      title={FLAG_TITLES[flag]}
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${FLAG_CLASSES[flag]}`}
    >
      {offerFlagLabel(flag)}
    </span>
  );
}

export function OfferFlagChips({ flags, emptyText = EMPTY }: { flags: OfferFlag[]; emptyText?: string }) {
  if (flags.length === 0) {
    return <span className="text-zinc-400">{emptyText}</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <li key={flag}>
          <OfferFlagChip flag={flag} />
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Table definition (module scope so the column model stays stable)
// ---------------------------------------------------------------------------

const features = tableFeatures({ tableMeta: {} as GridMeta });
const helper = createColumnHelper<typeof features, OfferLineRow>();
type Ctx<TValue> = CellContext<typeof features, OfferLineRow, TValue>;

// Structural parameter: CellContext is invariant in its value type, so a
// Ctx<string> would not pass where Ctx<unknown> is asked for.
function metaOf(info: { table: { options: { meta?: GridMeta } } }): GridMeta {
  const meta = info.table.options.meta;
  if (!meta) throw new Error("OfferLinesGrid: table meta was not provided");
  return meta;
}

// ---------------------------------------------------------------------------
// Editable cells
// ---------------------------------------------------------------------------

type CommitState = { saving: boolean; error: string | null };

function useCommit<T>(commit: (value: T) => Promise<string | null>) {
  const [state, setState] = useState<CommitState>({ saving: false, error: null });
  async function run(value: T) {
    setState({ saving: true, error: null });
    const message = await commit(value);
    setState({ saving: false, error: message });
  }
  return { ...state, run };
}

function CellError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="mt-1 max-w-[14rem] text-xs text-red-700">
      {message}
    </p>
  );
}

const inputBase =
  "w-full rounded border bg-white px-1.5 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50 disabled:text-zinc-400";

function inputClass(state: CommitState, extra = ""): string {
  const border = state.error ? "border-red-400" : "border-zinc-300";
  const saving = state.saving ? "opacity-60" : "";
  return `${inputBase} ${border} ${saving} ${extra}`.trim();
}

type TextInputCellProps = {
  value: string;
  mode: "text" | "number" | "date";
  disabled: boolean;
  label: string;
  placeholder?: string;
  widthClass?: string;
  hint?: string | null;
  /** Receives the raw typed text (trimmed). Returns an error message or null. */
  onCommit: (raw: string) => Promise<string | null>;
};

/**
 * A text, number, or date input that commits on blur or Enter when the value
 * changed. Escape restores the saved value. The parent keys this component by
 * the saved value, so a refresh after a successful save remounts it with the
 * new value while a failed save keeps what was typed next to the error.
 */
function TextInputCell({ value, mode, disabled, label, placeholder, widthClass, hint, onCommit }: TextInputCellProps) {
  const [draft, setDraft] = useState(value);
  const skipNextBlur = useRef(false);
  const commit = useCommit(onCommit);

  function handleBlur() {
    if (skipNextBlur.current) {
      skipNextBlur.current = false;
      return;
    }
    const trimmed = draft.trim();
    if (trimmed === value.trim()) return;
    void commit.run(trimmed);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(value);
      skipNextBlur.current = true;
      event.currentTarget.blur();
    }
  }

  return (
    <div className={widthClass ?? "min-w-[8rem]"}>
      <input
        type={mode === "date" ? "date" : "text"}
        inputMode={mode === "number" ? "decimal" : undefined}
        aria-label={label}
        value={draft}
        disabled={disabled || commit.saving}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        title={commit.saving ? "Saving" : undefined}
        className={inputClass(commit, mode === "number" ? "text-right tabular-nums" : mode === "date" ? "tabular-nums" : "")}
      />
      {hint ? <p className="mt-0.5 text-xs text-zinc-500">{hint}</p> : null}
      <CellError message={commit.error} />
    </div>
  );
}

type SelectCellProps = {
  value: string | null;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled: boolean;
  label: string;
  /** Hide the blank option (for columns whose database value is never null). */
  required?: boolean;
  widthClass?: string;
  onCommit: (value: string | null) => Promise<string | null>;
};

function SelectCell({ value, options, disabled, label, required = false, widthClass, onCommit }: SelectCellProps) {
  const commit = useCommit(onCommit);
  return (
    <div className={widthClass ?? "min-w-[7rem]"}>
      <select
        aria-label={label}
        value={value ?? ""}
        disabled={disabled || commit.saving}
        onChange={(event) => void commit.run(event.target.value === "" ? null : event.target.value)}
        title={commit.saving ? "Saving" : undefined}
        className={inputClass(commit)}
      >
        {required && value !== null ? null : <option value="">{EMPTY}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <CellError message={commit.error} />
    </div>
  );
}

/** Blank text becomes null; anything else is the trimmed string. */
function textOrNull(raw: string): string | null {
  return raw.trim() === "" ? null : raw.trim();
}

/** Blank becomes null; otherwise a positive finite number, or an error message. */
export function parsePositiveNumber(raw: string): { value: number | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  const n = Number(trimmed.replace(/^\$/, "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return { error: "Enter a positive number, or leave blank." };
  return { value: n };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Blank becomes null; otherwise a yyyy-MM-dd date, or an error message. */
export function parseIsoDate(raw: string): { value: string | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  if (!ISO_DATE.test(trimmed) || Number.isNaN(new Date(`${trimmed}T00:00:00Z`).getTime())) {
    return { error: "Enter a date as yyyy-mm-dd, or leave blank." };
  }
  return { value: trimmed };
}

/** Toggle one alternate type, keeping the enum's order. */
export function toggleAlternateType(current: AlternateType[], type: AlternateType): AlternateType[] {
  const next = new Set(current);
  if (next.has(type)) next.delete(type);
  else next.add(type);
  return alternateTypeValues.filter((value) => next.has(value));
}

// ---------------------------------------------------------------------------
// Cell components (one per column; rendered by table.FlexRender)
// ---------------------------------------------------------------------------

function RequestLineCell(info: Ctx<string | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const options = meta.requestLines.map((request) => ({ value: request.id, label: requestLineLabel(request) }));
  return (
    <SelectCell
      value={line.request_line_id}
      options={options}
      disabled={meta.readOnly}
      label="Request line"
      required
      widthClass="min-w-[12rem]"
      onCommit={(value) => {
        if (value === null) return Promise.resolve("Pick the request line this offer answers.");
        return meta.onEdit(line.id, { request_line_id: value });
      }}
    />
  );
}

function OfferedDescCell(info: Ctx<string>) {
  const meta = metaOf(info);
  const line = info.row.original;
  return (
    <TextInputCell
      key={line.offered_desc}
      value={line.offered_desc}
      mode="text"
      disabled={meta.readOnly}
      label="Offered item"
      widthClass="min-w-[12rem]"
      hint={line.offered_designation}
      onCommit={async (raw) => {
        if (raw === "") return "The offered item cannot be blank.";
        return meta.onEdit(line.id, { offered_desc: raw });
      }}
    />
  );
}

const chipOn = "rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-xs text-teal-900";
const chipOff = "rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50";

function MatchCell(info: Ctx<boolean>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const exactCommit = useCommit((exact: boolean) =>
    meta.onEdit(line.id, exact ? { is_exact_match: true, alternate_types: [] } : { is_exact_match: false }),
  );
  const altCommit = useCommit((types: AlternateType[]) =>
    meta.onEdit(line.id, { is_exact_match: false, alternate_types: types }),
  );
  const saving = exactCommit.saving || altCommit.saving;

  return (
    <div className="flex min-w-[9rem] flex-col gap-1">
      <label className="flex items-center gap-1.5 text-xs text-zinc-700">
        <input
          type="checkbox"
          checked={line.is_exact_match}
          disabled={meta.readOnly || saving}
          onChange={(event) => void exactCommit.run(event.target.checked)}
          className={`h-4 w-4 accent-zinc-900 ${saving ? "opacity-60" : ""}`}
        />
        {line.is_exact_match ? "Exact" : "Alternate"}
      </label>
      {line.is_exact_match ? null : (
        <div className="flex flex-wrap gap-1" aria-label="What differs from the request">
          {alternateTypeValues.map((type) => {
            const on = line.alternate_types.includes(type);
            return (
              <button
                key={type}
                type="button"
                aria-pressed={on}
                disabled={meta.readOnly || saving}
                onClick={() => void altCommit.run(toggleAlternateType(line.alternate_types, type))}
                className={`${on ? chipOn : chipOff} disabled:cursor-not-allowed disabled:opacity-60`}
                title={on ? `The offered ${type} differs from the request` : `Mark the ${type} as different`}
              >
                {type}
              </button>
            );
          })}
        </div>
      )}
      <CellError message={exactCommit.error ?? altCommit.error} />
    </div>
  );
}

function AvailableQtyCell(info: Ctx<number | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const shown = line.available_qty === null ? "" : String(line.available_qty);
  return (
    <TextInputCell
      key={shown}
      value={shown}
      mode="number"
      disabled={meta.readOnly}
      label="Available quantity"
      widthClass="w-20"
      onCommit={async (raw) => {
        const parsed = parsePositiveNumber(raw);
        if ("error" in parsed) return parsed.error;
        return meta.onEdit(line.id, { available_qty: parsed.value });
      }}
    />
  );
}

function UnitCell(info: Ctx<LineUnit | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  return (
    <SelectCell
      value={line.unit}
      options={UNIT_OPTIONS}
      disabled={meta.readOnly}
      label="Unit"
      widthClass="w-20"
      onCommit={(value) => meta.onEdit(line.id, { unit: value === null ? null : (value as LineUnit) })}
    />
  );
}

function AvailabilityCell(info: Ctx<Availability>) {
  const meta = metaOf(info);
  const line = info.row.original;
  return (
    <SelectCell
      value={line.availability}
      options={AVAILABILITY_OPTIONS}
      disabled={meta.readOnly}
      label="Availability"
      required
      widthClass="w-28"
      onCommit={(value) => meta.onEdit(line.id, { availability: (value ?? "unknown") as Availability })}
    />
  );
}

function ReadyDateCell(info: Ctx<string | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const shown = line.ready_date ?? "";
  return (
    <TextInputCell
      key={shown}
      value={shown}
      mode="date"
      disabled={meta.readOnly}
      label="Ready date"
      widthClass="w-36"
      onCommit={async (raw) => {
        const parsed = parseIsoDate(raw);
        if ("error" in parsed) return parsed.error;
        return meta.onEdit(line.id, { ready_date: parsed.value });
      }}
    />
  );
}

function DeliveryEstimateCell(info: Ctx<string | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const shown = line.delivery_estimate_text ?? "";
  return (
    <TextInputCell
      key={shown}
      value={shown}
      mode="text"
      disabled={meta.readOnly}
      label="Delivery estimate"
      widthClass="min-w-[10rem]"
      placeholder="week of Nov 17, 5 loads"
      onCommit={(raw) => meta.onEdit(line.id, { delivery_estimate_text: textOrNull(raw) })}
    />
  );
}

function UnitPriceCell(info: Ctx<number | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const shown = line.unit_price === null ? "" : String(line.unit_price);
  return (
    <TextInputCell
      key={shown}
      value={shown}
      mode="number"
      disabled={meta.readOnly}
      label="Unit price"
      widthClass="w-24"
      placeholder="unknown"
      onCommit={async (raw) => {
        const parsed = parsePositiveNumber(raw);
        if ("error" in parsed) return parsed.error;
        return meta.onEdit(line.id, { unit_price: parsed.value });
      }}
    />
  );
}

function PriceBasisCell(info: Ctx<PriceBasis | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  return (
    <SelectCell
      value={line.price_basis}
      options={PRICE_BASIS_OPTIONS}
      disabled={meta.readOnly}
      label="Price basis"
      widthClass="w-24"
      onCommit={(value) => meta.onEdit(line.id, { price_basis: value === null ? null : (value as PriceBasis) })}
    />
  );
}

function FlagsCell(info: Ctx<unknown>) {
  const line = info.row.original;
  return <OfferFlagChips flags={line.flags} />;
}

function ConfidenceCell(info: Ctx<number>) {
  const value = info.getValue();
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  const tone = percent >= 80 ? "text-zinc-700" : percent >= 50 ? "text-amber-700" : "text-red-700";
  return <span className={`tabular-nums ${tone}`}>{percent}%</span>;
}

const smallButton =
  "rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

function ActionsCell(info: Ctx<unknown>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const commit = useCommit(() => meta.onRemove(line.id));
  if (meta.readOnly) return null;
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={commit.saving}
        onClick={(event) => {
          event.stopPropagation();
          void commit.run(undefined);
        }}
        className={`${smallButton} text-red-700 hover:bg-red-50`}
        title="Remove this line from the offer. The vendor's words stay in the reply text below."
      >
        {commit.saving ? "Removing..." : "Remove"}
      </button>
      <CellError message={commit.error} />
    </div>
  );
}

const columns = helper.columns([
  helper.accessor("request_line_id", { header: "Request line", cell: RequestLineCell }),
  helper.accessor("offered_desc", { header: "Offered", cell: OfferedDescCell }),
  helper.accessor("is_exact_match", { header: "Match", cell: MatchCell }),
  helper.accessor("available_qty", { header: "Avail. qty", cell: AvailableQtyCell }),
  helper.accessor("unit", { header: "Unit", cell: UnitCell }),
  helper.accessor("availability", { header: "Availability", cell: AvailabilityCell }),
  helper.accessor("ready_date", { header: "Ready", cell: ReadyDateCell }),
  helper.accessor("delivery_estimate_text", { header: "Delivery", cell: DeliveryEstimateCell }),
  helper.accessor("unit_price", { header: "Price", cell: UnitPriceCell }),
  helper.accessor("price_basis", { header: "Basis", cell: PriceBasisCell }),
  helper.display({ id: "flags", header: "Flags", cell: FlagsCell }),
  helper.accessor("confidence", { header: "Conf.", cell: ConfidenceCell }),
  helper.display({ id: "actions", header: () => <span className="sr-only">Actions</span>, cell: ActionsCell }),
]);

// ---------------------------------------------------------------------------
// Add row (a line typed by the broker; same fields as the manual quote form)
// ---------------------------------------------------------------------------

/** The add row's raw field values, as the form posts them. */
export type OfferLineAddFields = {
  requestLineId: string;
  offeredDesc: string;
  availableQty: string;
  unit: string;
  availability: string;
  readyDate: string;
  deliveryEstimateText: string;
  unitPrice: string;
  priceBasis: string;
};

/**
 * Turn the add row's text into an OfferLineAddInput, or the first problem. The
 * request line and the offered item are required; everything else may be blank
 * and is then null (the server flags it, never fills it). An exact line carries
 * no alternate types.
 */
export function readOfferLineAddInput(
  fields: OfferLineAddFields,
  requestLines: OfferRequestLine[],
  exact: boolean,
  alternates: AlternateType[],
): { value: OfferLineAddInput } | { error: string } {
  const requestLineId = fields.requestLineId.trim();
  if (requestLineId === "" || !requestLines.some((line) => line.id === requestLineId)) {
    return { error: "Pick the request line this offer answers." };
  }
  const offeredDesc = fields.offeredDesc.trim();
  if (offeredDesc === "") return { error: "The offered item cannot be blank." };
  const qty = parsePositiveNumber(fields.availableQty);
  if ("error" in qty) return { error: `Available quantity: ${qty.error}` };
  const price = parsePositiveNumber(fields.unitPrice);
  if ("error" in price) return { error: `Unit price: ${price.error}` };
  const ready = parseIsoDate(fields.readyDate);
  if ("error" in ready) return { error: `Ready date: ${ready.error}` };
  const unit = lineUnitValues.find((value) => value === fields.unit.trim()) ?? null;
  const availability = availabilityValues.find((value) => value === fields.availability.trim()) ?? "unknown";
  const priceBasis = priceBasisValues.find((value) => value === fields.priceBasis.trim()) ?? null;
  return {
    value: {
      requestLineId,
      offeredDesc,
      isExactMatch: exact,
      alternateTypes: exact ? [] : alternateTypeValues.filter((value) => alternates.includes(value)),
      availableQty: qty.value,
      unit,
      availability,
      readyDate: ready.value,
      deliveryEstimateText: textOrNull(fields.deliveryEstimateText),
      unitPrice: price.value,
      priceBasis,
    },
  };
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

const addInputClass =
  "rounded border border-zinc-300 bg-white px-1.5 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50";

type AddOfferLineRowProps = {
  requestLines: OfferRequestLine[];
  disabled: boolean;
  /** Resolves to an error message, or null when the line was added (the form then clears). */
  onAdd: (input: OfferLineAddInput) => Promise<string | null>;
};

function AddOfferLineRow({ requestLines, disabled, onAdd }: AddOfferLineRowProps) {
  const [pending, startAdd] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [exact, setExact] = useState(true);
  const [alternates, setAlternates] = useState<AlternateType[]>([]);
  const locked = disabled || pending;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = readOfferLineAddInput(
      {
        requestLineId: formText(data, "requestLineId"),
        offeredDesc: formText(data, "offeredDesc"),
        availableQty: formText(data, "availableQty"),
        unit: formText(data, "unit"),
        availability: formText(data, "availability"),
        readyDate: formText(data, "readyDate"),
        deliveryEstimateText: formText(data, "deliveryEstimateText"),
        unitPrice: formText(data, "unitPrice"),
        priceBasis: formText(data, "priceBasis"),
      },
      requestLines,
      exact,
      alternates,
    );
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    startAdd(async () => {
      const message = await onAdd(parsed.value);
      if (message !== null) {
        setError(message);
        return;
      }
      setFormKey((k) => k + 1);
      setExact(true);
      setAlternates([]);
    });
  }

  return (
    <form key={formKey} onSubmit={handleSubmit} aria-label="Add an offer line" className="rounded border border-dashed border-zinc-300 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[12rem] flex-col gap-1 text-xs text-zinc-600">
          Add a line for
          <select name="requestLineId" defaultValue="" required disabled={locked} className={addInputClass}>
            <option value="">request line</option>
            {requestLines.map((line) => (
              <option key={line.id} value={line.id}>
                {requestLineLabel(line)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-zinc-600">
          Offered item
          <input type="text" name="offeredDesc" required placeholder="as the vendor wrote it" spellCheck={false} disabled={locked} className={addInputClass} />
        </label>
        <div className="flex min-w-[9rem] flex-col gap-1 text-xs text-zinc-600">
          Match
          <label className="flex items-center gap-1.5 text-xs text-zinc-700">
            <input type="checkbox" checked={exact} disabled={locked} onChange={(event) => setExact(event.target.checked)} className="h-4 w-4 accent-zinc-900" />
            {exact ? "Exact" : "Alternate"}
          </label>
          {exact ? null : (
            <div className="flex flex-wrap gap-1" aria-label="What differs from the request">
              {alternateTypeValues.map((type) => {
                const on = alternates.includes(type);
                return (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={on}
                    disabled={locked}
                    onClick={() => setAlternates((current) => toggleAlternateType(current, type))}
                    className={`${on ? chipOn : chipOff} disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    {type}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <label className="flex w-20 flex-col gap-1 text-xs text-zinc-600">
          Avail. qty
          <input type="text" name="availableQty" inputMode="decimal" disabled={locked} className={`${addInputClass} text-right tabular-nums`} />
        </label>
        <label className="flex w-20 flex-col gap-1 text-xs text-zinc-600">
          Unit
          <select name="unit" defaultValue="" disabled={locked} className={addInputClass}>
            <option value="">{EMPTY}</option>
            {UNIT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-28 flex-col gap-1 text-xs text-zinc-600">
          Availability
          <select name="availability" defaultValue="unknown" disabled={locked} className={addInputClass}>
            {AVAILABILITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-36 flex-col gap-1 text-xs text-zinc-600">
          Ready
          <input type="date" name="readyDate" disabled={locked} className={`${addInputClass} tabular-nums`} />
        </label>
        <label className="flex min-w-[10rem] flex-col gap-1 text-xs text-zinc-600">
          Delivery
          <input type="text" name="deliveryEstimateText" placeholder="week of Nov 17, 5 loads" disabled={locked} className={addInputClass} />
        </label>
        <label className="flex w-24 flex-col gap-1 text-xs text-zinc-600">
          Price
          <input type="text" name="unitPrice" inputMode="decimal" placeholder="unknown" disabled={locked} className={`${addInputClass} text-right tabular-nums`} />
        </label>
        <label className="flex w-24 flex-col gap-1 text-xs text-zinc-600">
          Basis
          <select name="priceBasis" defaultValue="" disabled={locked} className={addInputClass}>
            <option value="">{EMPTY}</option>
            {PRICE_BASIS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={locked}
          className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Adding..." : "Add line"}
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">A blank price, quantity, or date stays blank and is flagged. Typed lines carry confidence 100% and no source span.</p>
      <CellError message={error} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export type OfferLinesGridProps = {
  /** Must be referentially stable between renders. */
  lines: OfferLineRow[];
  requestLines: OfferRequestLine[];
  selectedLineId: string | null;
  onSelect: (lineId: string) => void;
  onEdit: (lineId: string, patch: OfferLinePatch) => Promise<string | null>;
  /** Remove one line (refused by the server while a Compare selection points at it). */
  onRemove: (lineId: string) => Promise<string | null>;
  /** Add a line typed into the row below the table. */
  onAdd: (input: OfferLineAddInput) => Promise<string | null>;
  /** Lock every cell and hide the row actions and the add row. */
  readOnly?: boolean;
  /** Shown instead of the table when there are no lines. */
  emptyText: string;
};

export function OfferLinesGrid({
  lines,
  requestLines,
  selectedLineId,
  onSelect,
  onEdit,
  onRemove,
  onAdd,
  readOnly = false,
  emptyText,
}: OfferLinesGridProps) {
  const meta = useMemo<GridMeta>(
    () => ({ requestLines, selectedLineId, onSelect, onEdit, onRemove, readOnly }),
    [requestLines, selectedLineId, onSelect, onEdit, onRemove, readOnly],
  );

  const table = useTable({
    features,
    columns,
    data: lines,
    getRowId: (row) => row.id,
    meta,
  });

  const addRow = readOnly ? null : <AddOfferLineRow requestLines={requestLines} disabled={false} onAdd={onAdd} />;

  if (lines.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="rounded border border-dashed border-zinc-300 px-3 py-4 text-center text-sm text-zinc-500">
          {emptyText}
        </p>
        {addRow}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded border border-zinc-200">
        <table className="w-full min-w-[90rem] border-collapse text-left text-sm">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                {group.headers.map((header) => (
                  <th key={header.id} scope="col" className="px-2 py-2 font-medium">
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-zinc-200">
            {table.getRowModel().rows.map((row) => {
              const line = row.original;
              const selected = line.id === selectedLineId;
              return (
                <tr
                  key={row.id}
                  onClick={() => onSelect(line.id)}
                  aria-selected={selected}
                  className={`cursor-pointer align-top ${selected ? "bg-amber-50" : "hover:bg-zinc-50"}`}
                >
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} className="px-2 py-2">
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {addRow}
    </div>
  );
}

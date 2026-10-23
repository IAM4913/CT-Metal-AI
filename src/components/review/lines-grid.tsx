"use client";

// The editable lines grid for the Review tab (AC-3.1, AC-3.2). TanStack Table
// v9 owns the row and column model; the markup, inputs, and saving states are
// plain React and Tailwind.
//
// Every editable cell commits on blur or Enter (text and numbers) or on change
// (selects and checkboxes) by calling onEdit with a one-field patch. The server
// action writes the row and logs before/after (AC-3.4); the workspace then
// refreshes the page, so the value shown is always what the database has. A
// cell that failed to save keeps the typed value and shows the error under it.
//
// The parser never fills a blank; neither does this grid. A blank cell stays
// blank until the broker types a value.
//
// readOnly (a superseded revision, AC-8.4) locks every cell and hides the row
// actions the same way a removed line is locked; isLocked() is the one rule.

import { createColumnHelper, tableFeatures, useTable, type CellContext } from "@tanstack/react-table";
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { FlagChips } from "@/components/review/flag-chips";
import {
  lineUnitValues,
  materialCategoryValues,
  type LineUnit,
  type MaterialCategory,
  type RequestLineFlag,
  type RequestLineStatus,
} from "@/lib/db/enums";

// ---------------------------------------------------------------------------
// Row and patch types shared with the page and the workspace
// ---------------------------------------------------------------------------

export type SourceSpan =
  | { kind: "text"; start: number; end: number }
  | { kind: "attachment"; attachment_id: string; page: number; start: number; end: number };

/** One request_lines row, serialized for the client, plus the linked item's designation. */
export type ReviewLine = {
  id: string;
  line_no: number;
  raw_text: string;
  description: string;
  category: MaterialCategory | null;
  catalog_item_id: string | null;
  catalog_designation: string | null;
  dims: Record<string, unknown>;
  grade_spec: string | null;
  qty: number | null;
  unit: LineUnit | null;
  length_ft: number | null;
  length_text: string | null;
  cut_to_length: boolean;
  delivery_notes: string | null;
  flags: RequestLineFlag[];
  confidence: number;
  source_span: SourceSpan | null;
  status: RequestLineStatus;
};

/** The fields a broker can change from the grid; mirrors lineEditSchema in src/lib/server/review.ts. */
export type LinePatch = Partial<{
  description: string;
  category: MaterialCategory | null;
  grade_spec: string | null;
  qty: number | null;
  unit: LineUnit | null;
  length_text: string | null;
  cut_to_length: boolean;
  delivery_notes: string | null;
  catalog_item_id: string | null;
  status: Exclude<RequestLineStatus, "removed">;
}>;

/** Each callback resolves to an error message, or null when the write succeeded. */
export type LineActions = {
  onEdit: (lineId: string, patch: LinePatch) => Promise<string | null>;
  onRemove: (lineId: string) => Promise<string | null>;
  onClearFlags: (lineId: string) => Promise<string | null>;
  onSetCustom: (lineId: string, custom: boolean) => Promise<string | null>;
  onLink: (line: ReviewLine) => void;
};

type GridMeta = LineActions & {
  selectedLineId: string | null;
  checkedIds: ReadonlySet<string>;
  onSelect: (lineId: string) => void;
  onToggleChecked: (lineId: string) => void;
  readOnly: boolean;
};

/** A cell is locked when the grid is read-only or the line is removed. */
function isLocked(meta: GridMeta, line: Pick<ReviewLine, "status">): boolean {
  return meta.readOnly || line.status === "removed";
}

export const CATEGORY_LABELS: Record<MaterialCategory, string> = {
  hss_square: "HSS square",
  hss_rectangular: "HSS rectangular",
  hss_round: "HSS round",
  pipe: "Pipe",
  w_beam: "W beam",
  s_beam: "S beam",
  channel: "Channel",
  angle: "Angle",
  flat_bar: "Flat bar",
  round_bar: "Round bar",
  square_bar: "Square bar",
  plate: "Plate",
  sheet: "Sheet",
  rebar: "Rebar",
};

const CATEGORY_OPTIONS = materialCategoryValues.map((value) => ({ value, label: CATEGORY_LABELS[value] }));
const UNIT_OPTIONS = lineUnitValues.map((value) => ({ value, label: value }));

const STATUS_LABELS: Record<RequestLineStatus, string> = {
  parsed: "parsed",
  confirmed: "confirmed",
  custom: "custom item",
  removed: "removed",
};

/** ASCII hyphen as the empty-cell marker. The flags column says why a cell is empty. */
const EMPTY = "-";

// ---------------------------------------------------------------------------
// Table definition (module scope so the column model stays stable)
// ---------------------------------------------------------------------------

const features = tableFeatures({ tableMeta: {} as GridMeta });
const helper = createColumnHelper<typeof features, ReviewLine>();
type Ctx<TValue> = CellContext<typeof features, ReviewLine, TValue>;

// Structural parameter: CellContext is invariant in its value type, so a
// Ctx<string> would not pass where Ctx<unknown> is asked for.
function metaOf(info: { table: { options: { meta?: GridMeta } } }): GridMeta {
  const meta = info.table.options.meta;
  if (!meta) throw new Error("LinesGrid: table meta was not provided");
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
  mode: "text" | "number";
  disabled: boolean;
  label: string;
  placeholder?: string;
  widthClass?: string;
  hint?: string | null;
  /** Receives the raw typed text (trimmed). Returns an error message or null. */
  onCommit: (raw: string) => Promise<string | null>;
};

/**
 * A text or number input that commits on blur or Enter when the value changed.
 * Escape restores the saved value. The parent keys this component by the saved
 * value, so a refresh after a successful save remounts it with the new value
 * while a failed save keeps what was typed next to the error.
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
        type="text"
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
        className={inputClass(commit, mode === "number" ? "text-right tabular-nums" : "")}
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
  onCommit: (value: string | null) => Promise<string | null>;
};

function SelectCell({ value, options, disabled, label, onCommit }: SelectCellProps) {
  const commit = useCommit(onCommit);
  return (
    <div className="min-w-[7rem]">
      <select
        aria-label={label}
        value={value ?? ""}
        disabled={disabled || commit.saving}
        onChange={(event) => void commit.run(event.target.value === "" ? null : event.target.value)}
        title={commit.saving ? "Saving" : undefined}
        className={inputClass(commit)}
      >
        <option value="">{EMPTY}</option>
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

type CheckboxCellProps = {
  checked: boolean;
  disabled: boolean;
  label: string;
  onCommit: (checked: boolean) => Promise<string | null>;
};

function CheckboxCell({ checked, disabled, label, onCommit }: CheckboxCellProps) {
  const commit = useCommit(onCommit);
  return (
    <div className="flex flex-col items-center">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled || commit.saving}
        onChange={(event) => void commit.run(event.target.checked)}
        className={`h-4 w-4 accent-zinc-900 ${commit.saving ? "opacity-60" : ""}`}
      />
      <CellError message={commit.error} />
    </div>
  );
}

/** Blank text becomes null; anything else is the trimmed string. */
function textOrNull(raw: string): string | null {
  return raw.trim() === "" ? null : raw.trim();
}

/** Blank becomes null; otherwise a positive finite number, or an error message. */
function parseQty(raw: string): { value: number | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return { error: "Enter a positive number, or leave blank." };
  return { value: n };
}

// ---------------------------------------------------------------------------
// Cell components (one per column; rendered by table.FlexRender)
// ---------------------------------------------------------------------------

function CheckCell(info: Ctx<unknown>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const removed = isLocked(meta, line);
  return (
    <input
      type="checkbox"
      aria-label={`Select line ${line.line_no} for merge`}
      checked={meta.checkedIds.has(line.id)}
      disabled={removed}
      onChange={() => meta.onToggleChecked(line.id)}
      className="h-4 w-4 accent-zinc-900"
    />
  );
}

function LineNoCell(info: Ctx<number>) {
  const line = info.row.original;
  return (
    <div className="tabular-nums text-zinc-600">
      <div>{info.getValue()}</div>
      {line.status !== "parsed" ? (
        <div className="mt-0.5 whitespace-nowrap text-[10px] uppercase tracking-wide text-zinc-400">
          {STATUS_LABELS[line.status]}
        </div>
      ) : null}
    </div>
  );
}

function DescriptionCell(info: Ctx<string>) {
  const meta = metaOf(info);
  const line = info.row.original;
  return (
    <TextInputCell
      key={line.description}
      value={line.description}
      mode="text"
      disabled={isLocked(meta, line)}
      label={`Description, line ${line.line_no}`}
      widthClass="min-w-[14rem]"
      hint={line.raw_text.trim() !== "" && line.raw_text.trim() !== line.description ? line.raw_text.trim() : null}
      onCommit={async (raw) => {
        if (raw === "") return "Description cannot be blank.";
        return meta.onEdit(line.id, { description: raw });
      }}
    />
  );
}

function CategoryCell(info: Ctx<MaterialCategory | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  return (
    <SelectCell
      value={line.category}
      options={CATEGORY_OPTIONS}
      disabled={isLocked(meta, line)}
      label={`Category, line ${line.line_no}`}
      onCommit={(value) => meta.onEdit(line.id, { category: value === null ? null : (value as MaterialCategory) })}
    />
  );
}

function QtyCell(info: Ctx<number | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const shown = line.qty === null ? "" : String(line.qty);
  return (
    <TextInputCell
      key={shown}
      value={shown}
      mode="number"
      disabled={isLocked(meta, line)}
      label={`Quantity, line ${line.line_no}`}
      widthClass="w-20"
      onCommit={async (raw) => {
        const parsed = parseQty(raw);
        if ("error" in parsed) return parsed.error;
        return meta.onEdit(line.id, { qty: parsed.value });
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
      disabled={isLocked(meta, line)}
      label={`Unit, line ${line.line_no}`}
      onCommit={(value) => meta.onEdit(line.id, { unit: value === null ? null : (value as LineUnit) })}
    />
  );
}

function LengthCell(info: Ctx<string | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const shown = line.length_text ?? "";
  const hint = line.length_ft !== null ? `= ${line.length_ft} ft` : line.length_text ? "not read as feet" : null;
  return (
    <TextInputCell
      key={shown}
      value={shown}
      mode="text"
      disabled={isLocked(meta, line)}
      label={`Length, line ${line.line_no}`}
      placeholder="40' or 480&quot;"
      widthClass="w-28"
      hint={hint}
      onCommit={(raw) => meta.onEdit(line.id, { length_text: textOrNull(raw) })}
    />
  );
}

function GradeCell(info: Ctx<string | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const shown = line.grade_spec ?? "";
  return (
    <TextInputCell
      key={shown}
      value={shown}
      mode="text"
      disabled={isLocked(meta, line)}
      label={`Grade or spec, line ${line.line_no}`}
      widthClass="w-28"
      onCommit={(raw) => meta.onEdit(line.id, { grade_spec: textOrNull(raw) })}
    />
  );
}

function CutToLengthCell(info: Ctx<boolean>) {
  const meta = metaOf(info);
  const line = info.row.original;
  return (
    <CheckboxCell
      checked={line.cut_to_length}
      disabled={isLocked(meta, line)}
      label={`Cut to length, line ${line.line_no}`}
      onCommit={(checked) => meta.onEdit(line.id, { cut_to_length: checked })}
    />
  );
}

function NotesCell(info: Ctx<string | null>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const shown = line.delivery_notes ?? "";
  return (
    <TextInputCell
      key={shown}
      value={shown}
      mode="text"
      disabled={isLocked(meta, line)}
      label={`Delivery notes, line ${line.line_no}`}
      widthClass="min-w-[10rem]"
      onCommit={(raw) => meta.onEdit(line.id, { delivery_notes: textOrNull(raw) })}
    />
  );
}

const smallButton =
  "rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

function CatalogCell(info: Ctx<unknown>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const commit = useCommit((custom: boolean) => meta.onSetCustom(line.id, custom));
  const removed = isLocked(meta, line);

  if (line.catalog_item_id !== null) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-900">{line.catalog_designation ?? "linked item"}</span>
        <button type="button" disabled={removed} onClick={() => meta.onLink(line)} className={smallButton}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {line.status === "custom" ? (
          <span className="rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">
            custom item
          </span>
        ) : (
          <span className="text-xs text-zinc-500">not linked</span>
        )}
        <button type="button" disabled={removed} onClick={() => meta.onLink(line)} className={smallButton}>
          Link
        </button>
        <button
          type="button"
          disabled={removed || commit.saving}
          onClick={() => void commit.run(line.status !== "custom")}
          className={smallButton}
          title={
            line.status === "custom"
              ? "Put the line back to parsed so it needs a catalog link"
              : "Confirm this is a custom, fabricated, or one-off item that has no catalog entry"
          }
        >
          {line.status === "custom" ? "Undo custom" : "Mark custom"}
        </button>
      </div>
      <CellError message={commit.error} />
    </div>
  );
}

function FlagsCell(info: Ctx<unknown>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const commit = useCommit(() => meta.onClearFlags(line.id));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <FlagChips flags={line.flags} />
        {line.flags.length > 0 && !isLocked(meta, line) ? (
          <button
            type="button"
            disabled={commit.saving}
            onClick={() => void commit.run(undefined)}
            className={smallButton}
            title="Clear every flag on this line. Blank values stay blank."
          >
            Clear
          </button>
        ) : null}
      </div>
      <CellError message={commit.error} />
    </div>
  );
}

function ConfidenceCell(info: Ctx<number>) {
  const value = info.getValue();
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  const tone = percent >= 80 ? "text-zinc-700" : percent >= 50 ? "text-amber-700" : "text-red-700";
  return <span className={`tabular-nums ${tone}`}>{percent}%</span>;
}

function ActionsCell(info: Ctx<unknown>) {
  const meta = metaOf(info);
  const line = info.row.original;
  const commit = useCommit(() => meta.onRemove(line.id));
  if (line.status === "removed") {
    return <span className="text-xs text-zinc-400">removed</span>;
  }
  if (meta.readOnly) return null;
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={commit.saving}
        onClick={() => void commit.run(undefined)}
        className={`${smallButton} text-red-700 hover:bg-red-50`}
      >
        {commit.saving ? "Removing..." : "Remove"}
      </button>
      <CellError message={commit.error} />
    </div>
  );
}

const columns = helper.columns([
  helper.display({ id: "check", header: () => <span className="sr-only">Select for merge</span>, cell: CheckCell }),
  helper.accessor("line_no", { header: "#", cell: LineNoCell }),
  helper.accessor("description", { header: "Description", cell: DescriptionCell }),
  helper.accessor("category", { header: "Category", cell: CategoryCell }),
  helper.accessor("qty", { header: "Qty", cell: QtyCell }),
  helper.accessor("unit", { header: "Unit", cell: UnitCell }),
  helper.accessor("length_text", { header: "Length", cell: LengthCell }),
  helper.accessor("grade_spec", { header: "Grade", cell: GradeCell }),
  helper.accessor("cut_to_length", {
    header: () => (
      <abbr title="Cut to length" className="no-underline">
        CTL
      </abbr>
    ),
    cell: CutToLengthCell,
  }),
  helper.accessor("delivery_notes", { header: "Notes", cell: NotesCell }),
  helper.display({ id: "catalog", header: "Catalog item", cell: CatalogCell }),
  helper.display({ id: "flags", header: "Flags", cell: FlagsCell }),
  helper.accessor("confidence", { header: "Conf.", cell: ConfidenceCell }),
  helper.display({ id: "actions", header: () => <span className="sr-only">Actions</span>, cell: ActionsCell }),
]);

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export type LinesGridProps = LineActions & {
  /** Already filtered for the "show removed" toggle; must be referentially stable between renders. */
  lines: ReviewLine[];
  selectedLineId: string | null;
  checkedIds: ReadonlySet<string>;
  onSelect: (lineId: string) => void;
  onToggleChecked: (lineId: string) => void;
  /** Lock every cell and hide the row actions (a superseded revision). */
  readOnly?: boolean;
};

export function LinesGrid({
  lines,
  selectedLineId,
  checkedIds,
  onSelect,
  onToggleChecked,
  onEdit,
  onRemove,
  onClearFlags,
  onSetCustom,
  onLink,
  readOnly = false,
}: LinesGridProps) {
  const meta = useMemo<GridMeta>(
    () => ({ selectedLineId, checkedIds, onSelect, onToggleChecked, onEdit, onRemove, onClearFlags, onSetCustom, onLink, readOnly }),
    [selectedLineId, checkedIds, onSelect, onToggleChecked, onEdit, onRemove, onClearFlags, onSetCustom, onLink, readOnly],
  );

  const table = useTable({
    features,
    columns,
    data: lines,
    getRowId: (row) => row.id,
    meta,
  });

  if (lines.length === 0) {
    return (
      <p className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500">
        No lines yet. Parse the request, or add a line by hand below.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-zinc-200">
      <table className="w-full min-w-[80rem] border-collapse text-left text-sm">
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
            const removed = line.status === "removed";
            const rowClass = [
              "cursor-pointer align-top",
              selected ? "bg-amber-50" : "hover:bg-zinc-50",
              removed ? "text-zinc-400 line-through" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <tr key={row.id} onClick={() => onSelect(line.id)} aria-selected={selected} className={rowClass}>
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
  );
}

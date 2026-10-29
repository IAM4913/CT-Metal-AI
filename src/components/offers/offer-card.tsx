"use client";

// One vendor offer (PRD FR-9, FR-10 inputs): who sent it and how, the header
// terms (payment, early pay, freight, expiry), the extraction confidence, links
// to the message and the quote file, the Mark reviewed / Decline / Re-extract
// actions, and the editable lines grid. Below the grid, the reply text with the
// selected line's span highlighted, the way the Review tab shows a request
// line's source (AC-9.3: reviewable exactly like request parsing).
//
// Header fields commit on blur or Enter and are keyed by the stored value, so a
// refresh after a successful save remounts them with what the database has
// while a failed save keeps what was typed next to the error. Nothing here
// fills a blank: an unknown price, freight, or date stays blank with its flag.
//
// The quote expiry is a calendar day stored at 00:00 UTC (parseQuoteExpiry,
// toExpiryTimestamp), so it is shown and seeded from its UTC day (isoDayOf,
// formatIsoDay) and committed as yyyy-MM-dd, never through the browser's zone,
// where that instant is the evening before for every US broker.
//
// Every callback resolves to an error message or null; the workspace owns the
// server action calls and the router.refresh() that follows a successful write.

import { format } from "date-fns";
import { useMemo, useRef, useState, useTransition, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  OfferLinesGrid,
  type OfferLineAddInput,
  type OfferLinePatch,
  type OfferLineRow,
  type OfferRequestLine,
} from "@/components/offers/offer-lines-grid";
import { splitAtSpan } from "@/components/review/source-pane";
import { freightBasisValues, type FreightBasis, type OfferSource, type OfferStatus } from "@/lib/db/enums";
import { formatIsoDay, isoDayOf } from "@/lib/parsing/money";

// ---------------------------------------------------------------------------
// Data shared with the workspace and the page
// ---------------------------------------------------------------------------

export type OfferMessage = {
  id: string;
  from_email: string;
  subject: string;
  body_text: string;
  received_at: string;
  /** The stored raw .eml, when the reply came in as one. */
  raw_attachment_id: string | null;
};

export type OfferAttachment = { id: string; filename: string; mime: string };

export type OfferCardData = {
  id: string;
  rfq_id: string;
  branch_id: string;
  vendor_name: string;
  branch_name: string;
  source: OfferSource;
  status: OfferStatus;
  received_at: string;
  quote_expires_at: string | null;
  payment_terms: string | null;
  early_pay_pct: number | null;
  early_pay_days: number | null;
  freight_amount: number | null;
  freight_basis: FreightBasis;
  notes: string;
  confidence: number;
  message: OfferMessage | null;
  /** The quote PDF (an uploaded PDF, or the first PDF attached to the .eml). */
  attachment: OfferAttachment | null;
  lines: OfferLineRow[];
};

/** Header fields a broker can change; mirrors the offer patch accepted by updateOffer. */
export type OfferPatch = Partial<{
  payment_terms: string | null;
  early_pay_pct: number | null;
  early_pay_days: number | null;
  freight_amount: number | null;
  freight_basis: FreightBasis;
  quote_expires_at: string | null;
  notes: string;
}>;

export type OfferCardProps = {
  offer: OfferCardData;
  requestLines: OfferRequestLine[];
  /** Lock every field and action. */
  readOnly: boolean;
  /** Each callback resolves to an error message, or null when the write succeeded. */
  onUpdateOffer: (patch: OfferPatch) => Promise<string | null>;
  onUpdateLine: (lineId: string, patch: OfferLinePatch) => Promise<string | null>;
  onAddLine: (input: OfferLineAddInput) => Promise<string | null>;
  onRemoveLine: (lineId: string) => Promise<string | null>;
  onMarkReviewed: () => Promise<string | null>;
  onSetDeclined: (declined: boolean) => Promise<string | null>;
  onReExtract: () => Promise<string | null>;
};

export const SOURCE_LABELS: Record<OfferSource, string> = {
  email: "Email",
  pdf: "PDF",
  phone: "Phone",
  text: "Text message",
  manual: "Manual",
};

const STATUS_LABELS: Record<OfferStatus, string> = {
  parsed: "Parsed",
  reviewed: "Reviewed",
  declined: "Declined",
};

const STATUS_CLASSES: Record<OfferStatus, string> = {
  parsed: "border-sky-200 bg-sky-50 text-sky-800",
  reviewed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  declined: "border-amber-200 bg-amber-50 text-amber-800",
};

export const FREIGHT_BASIS_LABELS: Record<FreightBasis, string> = {
  included: "Included (delivered)",
  separate: "Separate (plus freight, FOB)",
  unknown: "Unknown",
};

export function OfferStatusBadge({ status }: { status: OfferStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Extraction-backed sources can be re-run; a phone or text quote has nothing to extract from. */
export function canReExtract(offer: Pick<OfferCardData, "source" | "message" | "attachment">): boolean {
  return (offer.source === "email" || offer.source === "pdf") && (offer.message !== null || offer.attachment !== null);
}

const secondaryButton =
  "rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton =
  "rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400";
const inputBase =
  "w-full rounded border bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50 disabled:text-zinc-500";

/** An instant (received, sent) in the viewer's local time. */
function formatDateTime(iso: string): string {
  return format(new Date(iso), "MMM d, yyyy h:mm a");
}

/** "1% net 10" style summary, or null when neither part is known. */
export function earlyPaySummary(pct: number | null, days: number | null): string | null {
  if (pct === null && days === null) return null;
  const pctText = pct === null ? "? %" : `${pct}%`;
  const daysText = days === null ? "? days" : `net ${days}`;
  return `${pctText} ${daysText}`;
}

export function OfferCard({
  offer,
  requestLines,
  readOnly,
  onUpdateOffer,
  onUpdateLine,
  onAddLine,
  onRemoveLine,
  onMarkReviewed,
  onSetDeclined,
  onReExtract,
}: OfferCardProps) {
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [confirmingReExtract, setConfirmingReExtract] = useState(false);
  const [reviewPending, startReview] = useTransition();
  const [declinePending, startDecline] = useTransition();
  const [extractPending, startExtract] = useTransition();
  const busy = reviewPending || declinePending || extractPending;
  const declined = offer.status === "declined";

  const selectedLine = offer.lines.find((line) => line.id === selectedLineId) ?? null;
  const highlight = useMemo(() => {
    if (!selectedLine) return null;
    const span = selectedLine.source_span;
    if (span === null) return { kind: "none" as const, reason: "This line was entered by hand and has no source span." };
    if (span.kind === "text") return { kind: "text" as const, start: span.start, end: span.end };
    const filename = offer.attachment && offer.attachment.id === span.attachment_id ? offer.attachment.filename : "the quote file";
    return { kind: "attachment" as const, filename, page: span.page, attachment_id: span.attachment_id };
  }, [selectedLine, offer.attachment]);

  function markReviewed() {
    setCardError(null);
    startReview(async () => {
      const message = await onMarkReviewed();
      if (message !== null) setCardError(message);
    });
  }

  function toggleDeclined() {
    setCardError(null);
    startDecline(async () => {
      const message = await onSetDeclined(!declined);
      if (message !== null) setCardError(message);
    });
  }

  function reExtract() {
    setConfirmingReExtract(false);
    setCardError(null);
    setSelectedLineId(null);
    startExtract(async () => {
      const message = await onReExtract();
      if (message !== null) setCardError(message);
    });
  }

  const earlyPay = earlyPaySummary(offer.early_pay_pct, offer.early_pay_days);
  // The stored UTC day, whatever zone the browser is in.
  const expiryDay = isoDayOf(offer.quote_expires_at);
  const headingId = `offer-${offer.id}-heading`;

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-4 rounded border border-zinc-200 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <h4 id={headingId} className="text-base font-semibold text-zinc-900">
              {offer.vendor_name} <span className="font-normal text-zinc-600">{offer.branch_name}</span>
            </h4>
            <OfferStatusBadge status={offer.status} />
            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs text-zinc-700">
              {SOURCE_LABELS[offer.source]}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span>Received {formatDateTime(offer.received_at)}</span>
            <span>
              Confidence{" "}
              <span className="tabular-nums text-zinc-700">{Math.round(Math.min(Math.max(offer.confidence, 0), 1) * 100)}%</span>
            </span>
            {offer.message?.raw_attachment_id ? (
              <a
                href={`/attachments/${offer.message.raw_attachment_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-zinc-700 underline hover:text-zinc-900"
              >
                Open the .eml
              </a>
            ) : null}
            {offer.attachment ? (
              <a
                href={`/attachments/${offer.attachment.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-zinc-700 underline hover:text-zinc-900"
              >
                {offer.attachment.filename}
              </a>
            ) : null}
          </div>
        </div>

        {readOnly ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={markReviewed}
              disabled={busy || offer.status !== "parsed"}
              className={offer.status === "parsed" ? primaryButton : secondaryButton}
              title={
                offer.status === "reviewed"
                  ? "Already reviewed"
                  : declined
                    ? "A declined offer has nothing to review"
                    : "Confirm the lines above are what the vendor offered"
              }
            >
              {reviewPending ? "Saving..." : offer.status === "reviewed" ? "Reviewed" : "Mark reviewed"}
            </button>
            <button
              type="button"
              onClick={toggleDeclined}
              disabled={busy}
              className={secondaryButton}
              title={declined ? "Put the offer back to parsed" : "Record that this vendor passed, so the queue stops waiting on it"}
            >
              {declinePending ? "Saving..." : declined ? "Undo decline" : "Mark declined"}
            </button>
            {canReExtract(offer) ? (
              confirmingReExtract ? (
                <span className="flex flex-wrap items-center gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                  Replace {offer.lines.length === 1 ? "the 1 line" : `all ${offer.lines.length} lines`} with a fresh extraction?
                  <button type="button" onClick={reExtract} className={primaryButton}>
                    Re-extract
                  </button>
                  <button type="button" onClick={() => setConfirmingReExtract(false)} className={secondaryButton}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingReExtract(true)}
                  disabled={busy}
                  className={secondaryButton}
                  title="Run the extraction again on the reply text and quote file. Edits to the lines are lost."
                >
                  {extractPending ? "Extracting..." : "Re-extract"}
                </button>
              )
            ) : null}
          </div>
        )}
      </header>

      {cardError ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {cardError}
        </p>
      ) : null}

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Payment terms">
          <TextField
            key={offer.payment_terms ?? ""}
            label={`Payment terms, ${offer.vendor_name} ${offer.branch_name}`}
            value={offer.payment_terms ?? ""}
            placeholder="net 30"
            disabled={readOnly || busy}
            onCommit={(raw) => onUpdateOffer({ payment_terms: raw === "" ? null : raw })}
          />
        </Field>
        <Field label="Early pay" hint={earlyPay ?? "none quoted"}>
          <div className="flex items-center gap-2">
            <TextField
              key={`pct-${offer.early_pay_pct ?? ""}`}
              label={`Early pay percent, ${offer.vendor_name} ${offer.branch_name}`}
              value={offer.early_pay_pct === null ? "" : String(offer.early_pay_pct)}
              placeholder="%"
              numeric
              widthClass="w-20"
              disabled={readOnly || busy}
              onCommit={async (raw) => {
                const parsed = parseNonNegative(raw);
                if ("error" in parsed) return parsed.error;
                return onUpdateOffer({ early_pay_pct: parsed.value });
              }}
            />
            <span className="text-xs text-zinc-500">% within</span>
            <TextField
              key={`days-${offer.early_pay_days ?? ""}`}
              label={`Early pay days, ${offer.vendor_name} ${offer.branch_name}`}
              value={offer.early_pay_days === null ? "" : String(offer.early_pay_days)}
              placeholder="days"
              numeric
              widthClass="w-20"
              disabled={readOnly || busy}
              onCommit={async (raw) => {
                const parsed = parseWholeNumber(raw);
                if ("error" in parsed) return parsed.error;
                return onUpdateOffer({ early_pay_days: parsed.value });
              }}
            />
            <span className="text-xs text-zinc-500">days</span>
          </div>
        </Field>
        <Field label="Freight">
          <div className="flex items-center gap-2">
            <TextField
              key={`freight-${offer.freight_amount ?? ""}`}
              label={`Freight amount, ${offer.vendor_name} ${offer.branch_name}`}
              value={offer.freight_amount === null ? "" : String(offer.freight_amount)}
              placeholder="unknown"
              numeric
              widthClass="w-24"
              disabled={readOnly || busy}
              onCommit={async (raw) => {
                const parsed = parseNonNegative(raw);
                if ("error" in parsed) return parsed.error;
                return onUpdateOffer({ freight_amount: parsed.value });
              }}
            />
            <FreightBasisSelect
              key={offer.freight_basis}
              label={`Freight basis, ${offer.vendor_name} ${offer.branch_name}`}
              value={offer.freight_basis}
              disabled={readOnly || busy}
              onCommit={(freight_basis) => onUpdateOffer({ freight_basis })}
            />
          </div>
        </Field>
        <Field label="Quote valid through" hint={expiryDay ? (formatIsoDay(expiryDay) ?? expiryDay) : "not stated"}>
          <TextField
            key={expiryDay ?? ""}
            label={`Quote expiry, ${offer.vendor_name} ${offer.branch_name}`}
            value={expiryDay ?? ""}
            date
            widthClass="w-40"
            disabled={readOnly || busy}
            onCommit={async (raw) => {
              // Committed as the day itself; the server stores it at 00:00 UTC (toExpiryTimestamp).
              const parsed = parseDateOnlyInput(raw);
              if ("error" in parsed) return parsed.error;
              return onUpdateOffer({ quote_expires_at: parsed.value });
            }}
          />
        </Field>
        <Field label="Notes" wide>
          <TextField
            key={offer.notes}
            label={`Notes, ${offer.vendor_name} ${offer.branch_name}`}
            value={offer.notes}
            placeholder="anything the vendor said that the fields above do not hold"
            disabled={readOnly || busy}
            onCommit={(raw) => onUpdateOffer({ notes: raw })}
          />
        </Field>
      </dl>

      <section aria-label="Offer lines" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {offer.lines.length} {offer.lines.length === 1 ? "line" : "lines"}
          </span>
          {offer.lines.length > 0 ? (
            <span className="text-xs text-zinc-500">Click a row to see where it came from. Edit a cell, then Enter or click away to save.</span>
          ) : null}
        </div>
        <OfferLinesGrid
          lines={offer.lines}
          requestLines={requestLines}
          selectedLineId={selectedLineId}
          onSelect={setSelectedLineId}
          onEdit={onUpdateLine}
          onRemove={onRemoveLine}
          onAdd={onAddLine}
          readOnly={readOnly}
          emptyText={
            declined
              ? "The vendor declined. No lines."
              : canReExtract(offer)
                ? "No lines were extracted from this reply. Check the text below, then Re-extract or mark the offer declined."
                : "No lines on this offer."
          }
        />
      </section>

      {highlight?.kind === "attachment" ? (
        <p className="rounded border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          Selected line is from{" "}
          <a
            href={`/attachments/${highlight.attachment_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline hover:text-sky-700"
          >
            {highlight.filename}
          </a>
          , page {highlight.page}.
        </p>
      ) : null}
      {highlight?.kind === "none" ? (
        <p className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">{highlight.reason}</p>
      ) : null}

      {offer.message ? (
        <ReplyText
          message={offer.message}
          span={highlight?.kind === "text" ? highlight : null}
          openByDefault={highlight?.kind === "text"}
        />
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Reply text with the selected line's span highlighted
// ---------------------------------------------------------------------------

function ReplyText({
  message,
  span,
  openByDefault,
}: {
  message: OfferMessage;
  span: { start: number; end: number } | null;
  openByDefault: boolean;
}) {
  const [before, mark, after] = span ? splitAtSpan(message.body_text, span) : [message.body_text, "", ""];
  const empty = message.body_text.trim() === "";

  return (
    <details open={openByDefault || undefined} className="rounded border border-zinc-200">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-zinc-800">
        Reply text
        <span className="ml-2 text-xs font-normal text-zinc-500">
          {message.from_email ? `from ${message.from_email}, ` : ""}
          {formatDateTime(message.received_at)}
          {message.subject.trim() !== "" ? `, "${message.subject}"` : ""}
        </span>
      </summary>
      <div className="border-t border-zinc-200 p-3">
        {span && mark === "" ? (
          <p className="mb-2 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
            The recorded span for this line is empty or outside the text.
          </p>
        ) : null}
        {empty ? (
          <p className="text-sm text-zinc-500">The message had no text body.</p>
        ) : (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-sm leading-relaxed text-zinc-900">
            {before}
            {mark !== "" ? <mark className="rounded-sm bg-amber-200 text-zinc-900 ring-2 ring-amber-300">{mark}</mark> : null}
            {after}
          </pre>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Header field pieces
// ---------------------------------------------------------------------------

function Field({ label, hint, wide = false, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${wide ? "sm:col-span-2 lg:col-span-4" : ""}`}>
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
        {hint ? <span className="ml-2 normal-case tracking-normal text-zinc-400">{hint}</span> : null}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

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

function FieldError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-red-700">
      {message}
    </p>
  );
}

function inputClass(state: CommitState, extra = ""): string {
  return `${inputBase} ${state.error ? "border-red-400" : "border-zinc-300"} ${state.saving ? "opacity-60" : ""} ${extra}`.trim();
}

type TextFieldProps = {
  label: string;
  value: string;
  placeholder?: string;
  numeric?: boolean;
  date?: boolean;
  widthClass?: string;
  disabled: boolean;
  /** Receives the trimmed text. Returns an error message or null. */
  onCommit: (raw: string) => Promise<string | null>;
};

function TextField({ label, value, placeholder, numeric = false, date = false, widthClass, disabled, onCommit }: TextFieldProps) {
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
    <div className={widthClass ?? "w-full"}>
      <input
        type={date ? "date" : "text"}
        inputMode={numeric ? "decimal" : undefined}
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        disabled={disabled || commit.saving}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        title={commit.saving ? "Saving" : undefined}
        className={inputClass(commit, numeric ? "text-right tabular-nums" : date ? "tabular-nums" : "")}
      />
      <FieldError message={commit.error} />
    </div>
  );
}

function FreightBasisSelect({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: FreightBasis;
  disabled: boolean;
  onCommit: (value: FreightBasis) => Promise<string | null>;
}) {
  const commit = useCommit(onCommit);
  return (
    <div className="min-w-[9rem] flex-1">
      <select
        aria-label={label}
        value={value}
        disabled={disabled || commit.saving}
        onChange={(event) => void commit.run(event.target.value as FreightBasis)}
        className={inputClass(commit)}
      >
        {freightBasisValues.map((basis) => (
          <option key={basis} value={basis}>
            {FREIGHT_BASIS_LABELS[basis]}
          </option>
        ))}
      </select>
      <FieldError message={commit.error} />
    </div>
  );
}

/** Blank is null; otherwise a finite number of zero or more (a freight amount or a percent). */
export function parseNonNegative(raw: string): { value: number | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  const n = Number(trimmed.replace(/^\$/, "").replace(/%$/, "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return { error: "Enter a number, or leave blank." };
  return { value: n };
}

/** Blank is null; otherwise a whole number of one or more (early pay days). */
export function parseWholeNumber(raw: string): { value: number | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1) return { error: "Enter a whole number of days, or leave blank." };
  return { value: n };
}

/**
 * Blank is null; otherwise a yyyy-MM-dd day from a date input, returned
 * unchanged for a calendar-day field (the quote expiry): the server stores it
 * at 00:00 UTC and the card reads it back as the same day in every zone.
 */
export function parseDateOnlyInput(raw: string): { value: string | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return { error: "Enter a date as yyyy-mm-dd, or leave blank." };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { error: "That is not a real date." };
  }
  return { value: trimmed };
}

/**
 * Blank is null; otherwise a yyyy-MM-dd day from a date input, returned as an
 * ISO timestamp at local noon: for an instant field (when a phone quote was
 * received) the day the broker typed survives the trip through UTC in every
 * zone. Not for the quote expiry, which is a calendar day (parseDateOnlyInput).
 */
export function parseDateInput(raw: string): { value: string | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return { error: "Enter a date as yyyy-mm-dd, or leave blank." };
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  if (Number.isNaN(date.getTime())) return { error: "That is not a real date." };
  return { value: date.toISOString() };
}

"use client";

// "Enter a phone or text quote" (PRD AC-9.2): the same offer and offer-line
// fields as an extracted reply, typed by the broker. One row per request line
// the chosen RFQ asked about; a line the vendor did not quote is unchecked and
// left out. Declined records an offer with zero lines so the queue stops
// waiting on that vendor (AC-9.4).
//
// Nothing here is defaulted for the broker except what is not a judgment: the
// received date is today, the source is phone, availability starts at
// "unknown", and the offered description starts as the request line's own
// wording. Price, quantity, ready date, freight, and expiry start blank; a
// blank stays blank and is flagged by the server (computeOfferFlags).

import { format } from "date-fns";
import { useState, useTransition, type FormEvent } from "react";
import { createManualOfferAction } from "@/app/(app)/requests/[id]/actions";
import { rfqOptionLabel, type OpenRfqOption } from "@/components/offers/add-reply-panel";
import { FREIGHT_BASIS_LABELS, parseDateInput, parseDateOnlyInput, parseNonNegative, parseWholeNumber } from "@/components/offers/offer-card";
import {
  AVAILABILITY_LABELS,
  PRICE_BASIS_LABELS,
  parseIsoDate,
  parsePositiveNumber,
  requestLineLabel,
  type OfferRequestLine,
} from "@/components/offers/offer-lines-grid";
import {
  alternateTypeValues,
  availabilityValues,
  freightBasisValues,
  lineUnitValues,
  priceBasisValues,
  type AlternateType,
  type Availability,
  type FreightBasis,
  type LineUnit,
  type PriceBasis,
} from "@/lib/db/enums";

export type ManualSource = "phone" | "text";

/** One typed offer line as createManualOffer takes it (src/lib/server/offers.ts). */
export type ManualOfferLineInput = {
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

export type ManualOfferInput = {
  rfqId: string;
  source: ManualSource;
  /** ISO timestamp. */
  receivedAt: string;
  paymentTerms: string | null;
  earlyPayPct: number | null;
  earlyPayDays: number | null;
  freightAmount: number | null;
  freightBasis: FreightBasis;
  /** ISO timestamp, or null. */
  quoteExpiresAt: string | null;
  notes: string | null;
  declined: boolean;
  lines: ManualOfferLineInput[];
};

export type ManualQuoteFormProps = {
  rfqs: OpenRfqOption[];
  /** request_line ids each RFQ asked about (rfq_lines); an RFQ missing here shows every request line. */
  rfqLineIds: Record<string, string[]>;
  requestLines: OfferRequestLine[];
  disabled: boolean;
  onCreated: (message: string) => void;
  onCancel: () => void;
};

const inputClass =
  "w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50 disabled:text-zinc-500";
const cellInput =
  "w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50 disabled:text-zinc-400";
const primaryButton =
  "rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400";
const secondaryButton =
  "rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";
const chipOn = "rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-xs text-teal-900";
const chipOff = "rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50";

function blankToNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function field(data: FormData, lineId: string, name: string): FormDataEntryValue | null {
  return data.get(`lines[${lineId}][${name}]`);
}

/** The lines a chosen RFQ asked about, in line order; every line when the RFQ's rfq_lines are unknown. */
export function linesForRfq(
  rfqId: string,
  rfqLineIds: Record<string, string[]>,
  requestLines: OfferRequestLine[],
): OfferRequestLine[] {
  const ids = rfqLineIds[rfqId];
  const picked = ids && ids.length > 0 ? requestLines.filter((line) => ids.includes(line.id)) : requestLines;
  return [...picked].sort((a, b) => a.line_no - b.line_no);
}

export function ManualQuoteForm({ rfqs, rfqLineIds, requestLines, disabled, onCreated, onCancel }: ManualQuoteFormProps) {
  const [rfqId, setRfqId] = useState(rfqs.length === 1 ? rfqs[0].id : "");
  const [declined, setDeclined] = useState(false);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [exact, setExact] = useState<Record<string, boolean>>({});
  const [alternates, setAlternates] = useState<Record<string, AlternateType[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startSubmit] = useTransition();
  const [today] = useState(() => format(new Date(), "yyyy-MM-dd"));

  const locked = disabled || pending;
  const lines = rfqId === "" ? [] : linesForRfq(rfqId, rfqLineIds, requestLines);

  function isIncluded(lineId: string): boolean {
    return included[lineId] ?? true;
  }
  function isExact(lineId: string): boolean {
    return exact[lineId] ?? true;
  }
  function toggleAlternate(lineId: string, type: AlternateType) {
    setAlternates((current) => {
      const set = new Set(current[lineId] ?? []);
      if (set.has(type)) set.delete(type);
      else set.add(type);
      return { ...current, [lineId]: alternateTypeValues.filter((value) => set.has(value)) };
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const data = new FormData(event.currentTarget);

    if (rfqId === "") {
      setError("Pick the RFQ this quote answers.");
      return;
    }
    const sourceRaw = data.get("source");
    const source: ManualSource = sourceRaw === "text" ? "text" : "phone";

    const receivedRaw = blankToNull(data.get("receivedAt"));
    const received = parseDateInput(receivedRaw ?? "");
    if ("error" in received || received.value === null) {
      setError("Enter the date the quote was received.");
      return;
    }
    const earlyPct = parseNonNegative(String(data.get("earlyPayPct") ?? ""));
    if ("error" in earlyPct) return setError(`Early pay percent: ${earlyPct.error}`);
    const earlyDays = parseWholeNumber(String(data.get("earlyPayDays") ?? ""));
    if ("error" in earlyDays) return setError(`Early pay days: ${earlyDays.error}`);
    const freight = parseNonNegative(String(data.get("freightAmount") ?? ""));
    if ("error" in freight) return setError(`Freight amount: ${freight.error}`);
    const freightBasisRaw = data.get("freightBasis");
    const freightBasis = freightBasisValues.find((value) => value === freightBasisRaw) ?? "unknown";
    // A calendar day: stored at 00:00 UTC by the server and read back as that day in every zone.
    const expiry = parseDateOnlyInput(String(data.get("quoteExpiresAt") ?? ""));
    if ("error" in expiry) return setError(`Quote valid through: ${expiry.error}`);

    const typedLines: ManualOfferLineInput[] = [];
    if (!declined) {
      for (const line of lines) {
        if (!isIncluded(line.id)) continue;
        const offeredDesc = blankToNull(field(data, line.id, "offeredDesc"));
        if (offeredDesc === null) return setError(`Line ${line.line_no}: the offered item cannot be blank.`);
        const qty = parsePositiveNumber(String(field(data, line.id, "availableQty") ?? ""));
        if ("error" in qty) return setError(`Line ${line.line_no}, available quantity: ${qty.error}`);
        const unitRaw = blankToNull(field(data, line.id, "unit"));
        const unit = lineUnitValues.find((value) => value === unitRaw) ?? null;
        const availabilityRaw = field(data, line.id, "availability");
        const availability = availabilityValues.find((value) => value === availabilityRaw) ?? "unknown";
        const ready = parseIsoDate(String(field(data, line.id, "readyDate") ?? ""));
        if ("error" in ready) return setError(`Line ${line.line_no}, ready date: ${ready.error}`);
        const price = parsePositiveNumber(String(field(data, line.id, "unitPrice") ?? ""));
        if ("error" in price) return setError(`Line ${line.line_no}, unit price: ${price.error}`);
        const basisRaw = blankToNull(field(data, line.id, "priceBasis"));
        const priceBasis = priceBasisValues.find((value) => value === basisRaw) ?? null;
        const lineExact = isExact(line.id);
        typedLines.push({
          requestLineId: line.id,
          offeredDesc,
          isExactMatch: lineExact,
          alternateTypes: lineExact ? [] : (alternates[line.id] ?? []),
          availableQty: qty.value,
          unit,
          availability,
          readyDate: ready.value,
          deliveryEstimateText: blankToNull(field(data, line.id, "deliveryEstimateText")),
          unitPrice: price.value,
          priceBasis,
        });
      }
      if (typedLines.length === 0) {
        setError("Check at least one line the vendor quoted, or mark the quote declined.");
        return;
      }
    }

    const input: ManualOfferInput = {
      rfqId,
      source,
      receivedAt: received.value,
      paymentTerms: blankToNull(data.get("paymentTerms")),
      earlyPayPct: earlyPct.value,
      earlyPayDays: earlyDays.value,
      freightAmount: freight.value,
      freightBasis,
      quoteExpiresAt: expiry.value,
      notes: blankToNull(data.get("notes")),
      declined,
      lines: typedLines,
    };

    startSubmit(async () => {
      let result: { ok: boolean; error?: string };
      try {
        result = await createManualOfferAction(input);
      } catch (cause) {
        console.error("[offers] manual quote failed", cause);
        setError("The quote did not reach the server. Try again.");
        return;
      }
      if (!result.ok) {
        setError(result.error ?? "The quote could not be saved.");
        return;
      }
      const rfq = rfqs.find((option) => option.id === rfqId);
      onCreated(
        rfq
          ? `${declined ? "Decline" : "Quote"} from ${rfq.vendor_name}, ${rfq.branch_name} saved.`
          : `${declined ? "Decline" : "Quote"} saved.`,
      );
    });
  }

  return (
    <section aria-labelledby="manual-quote-heading" className="flex flex-col gap-4 rounded border border-zinc-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="manual-quote-heading" className="text-lg font-semibold">
            Enter a phone or text quote
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Same fields as an emailed offer. Leave what the vendor did not say blank; it is flagged, not guessed.
          </p>
        </div>
        <button type="button" onClick={onCancel} disabled={pending} className={secondaryButton}>
          Close
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="font-medium text-zinc-800">RFQ</span>
            <select
              name="rfqId"
              value={rfqId}
              onChange={(event) => setRfqId(event.target.value)}
              disabled={locked}
              required
              className={inputClass}
            >
              <option value="">{rfqs.length === 0 ? "No open RFQs" : "Pick the vendor who quoted"}</option>
              {rfqs.map((rfq) => (
                <option key={rfq.id} value={rfq.id}>
                  {rfqOptionLabel(rfq)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Came in by</span>
            <select name="source" defaultValue="phone" disabled={locked} className={inputClass}>
              <option value="phone">Phone</option>
              <option value="text">Text message</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Received</span>
            <input
              type="date"
              name="receivedAt"
              defaultValue={today}
              required
              disabled={locked}
              suppressHydrationWarning
              className={`${inputClass} tabular-nums`}
            />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Payment terms</span>
            <input type="text" name="paymentTerms" placeholder="net 30" disabled={locked} spellCheck={false} className={inputClass} />
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Early pay</span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                name="earlyPayPct"
                inputMode="decimal"
                aria-label="Early pay percent"
                placeholder="%"
                disabled={locked}
                className={`${inputClass} w-20 text-right tabular-nums`}
              />
              <span className="text-xs text-zinc-500">% within</span>
              <input
                type="text"
                name="earlyPayDays"
                inputMode="numeric"
                aria-label="Early pay days"
                placeholder="days"
                disabled={locked}
                className={`${inputClass} w-20 text-right tabular-nums`}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Freight</span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                name="freightAmount"
                inputMode="decimal"
                aria-label="Freight amount"
                placeholder="$"
                disabled={locked}
                className={`${inputClass} w-24 text-right tabular-nums`}
              />
              <select name="freightBasis" defaultValue="unknown" aria-label="Freight basis" disabled={locked} className={inputClass}>
                {freightBasisValues.map((basis) => (
                  <option key={basis} value={basis}>
                    {FREIGHT_BASIS_LABELS[basis]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Quote valid through</span>
            <input type="date" name="quoteExpiresAt" disabled={locked} className={`${inputClass} tabular-nums`} />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">Notes</span>
          <input
            type="text"
            name="notes"
            placeholder="anything else the vendor said"
            disabled={locked}
            spellCheck={false}
            className={inputClass}
          />
        </label>

        <label className="flex items-center gap-2 text-sm text-zinc-800">
          <input
            type="checkbox"
            name="declined"
            checked={declined}
            onChange={(event) => setDeclined(event.target.checked)}
            disabled={locked}
            className="h-4 w-4 accent-zinc-900"
          />
          The vendor declined (passes, does not stock it, or cannot quote). No lines are recorded.
        </label>

        {declined ? null : rfqId === "" ? (
          <p className="rounded border border-dashed border-zinc-300 px-3 py-4 text-center text-sm text-zinc-500">
            Pick the RFQ to see its lines.
          </p>
        ) : lines.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-300 px-3 py-4 text-center text-sm text-zinc-500">
            That RFQ has no lines.
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-zinc-200">
            <table className="w-full min-w-[78rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                  <th scope="col" className="px-2 py-2 font-medium">
                    Quoted
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Request line
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Offered
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Match
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Avail. qty
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Unit
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Availability
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Ready
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Delivery
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Price
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Basis
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {lines.map((line) => {
                  const on = isIncluded(line.id);
                  const rowLocked = locked || !on;
                  const lineExact = isExact(line.id);
                  return (
                    <tr key={line.id} className={`align-top ${on ? "" : "text-zinc-400"}`}>
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Line ${line.line_no} was quoted`}
                          checked={on}
                          disabled={locked}
                          onChange={(event) => setIncluded((current) => ({ ...current, [line.id]: event.target.checked }))}
                          className="h-4 w-4 accent-zinc-900"
                        />
                      </td>
                      <td className="min-w-[12rem] px-2 py-2 text-zinc-800">{requestLineLabel(line)}</td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          name={`lines[${line.id}][offeredDesc]`}
                          aria-label={`Offered item, line ${line.line_no}`}
                          defaultValue={line.description}
                          disabled={rowLocked}
                          spellCheck={false}
                          className={`${cellInput} min-w-[12rem]`}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex min-w-[9rem] flex-col gap-1">
                          <label className="flex items-center gap-1.5 text-xs text-zinc-700">
                            <input
                              type="checkbox"
                              checked={lineExact}
                              disabled={rowLocked}
                              onChange={(event) => setExact((current) => ({ ...current, [line.id]: event.target.checked }))}
                              className="h-4 w-4 accent-zinc-900"
                            />
                            {lineExact ? "Exact" : "Alternate"}
                          </label>
                          {lineExact ? null : (
                            <div className="flex flex-wrap gap-1" aria-label={`What differs on line ${line.line_no}`}>
                              {alternateTypeValues.map((type) => {
                                const picked = (alternates[line.id] ?? []).includes(type);
                                return (
                                  <button
                                    key={type}
                                    type="button"
                                    aria-pressed={picked}
                                    disabled={rowLocked}
                                    onClick={() => toggleAlternate(line.id, type)}
                                    className={`${picked ? chipOn : chipOff} disabled:cursor-not-allowed disabled:opacity-60`}
                                  >
                                    {type}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          name={`lines[${line.id}][availableQty]`}
                          inputMode="decimal"
                          aria-label={`Available quantity, line ${line.line_no}`}
                          disabled={rowLocked}
                          className={`${cellInput} w-20 text-right tabular-nums`}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <select
                          name={`lines[${line.id}][unit]`}
                          aria-label={`Unit, line ${line.line_no}`}
                          defaultValue=""
                          disabled={rowLocked}
                          className={`${cellInput} w-20`}
                        >
                          <option value="">-</option>
                          {lineUnitValues.map((unit) => (
                            <option key={unit} value={unit}>
                              {unit}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-2">
                        <select
                          name={`lines[${line.id}][availability]`}
                          aria-label={`Availability, line ${line.line_no}`}
                          defaultValue="unknown"
                          disabled={rowLocked}
                          className={`${cellInput} w-28`}
                        >
                          {availabilityValues.map((value) => (
                            <option key={value} value={value}>
                              {AVAILABILITY_LABELS[value]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="date"
                          name={`lines[${line.id}][readyDate]`}
                          aria-label={`Ready date, line ${line.line_no}`}
                          disabled={rowLocked}
                          className={`${cellInput} w-36 tabular-nums`}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          name={`lines[${line.id}][deliveryEstimateText]`}
                          aria-label={`Delivery estimate, line ${line.line_no}`}
                          placeholder="week of Nov 17"
                          disabled={rowLocked}
                          spellCheck={false}
                          className={`${cellInput} min-w-[10rem]`}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          name={`lines[${line.id}][unitPrice]`}
                          inputMode="decimal"
                          aria-label={`Unit price, line ${line.line_no}`}
                          placeholder="unknown"
                          disabled={rowLocked}
                          className={`${cellInput} w-24 text-right tabular-nums`}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <select
                          name={`lines[${line.id}][priceBasis]`}
                          aria-label={`Price basis, line ${line.line_no}`}
                          defaultValue=""
                          disabled={rowLocked}
                          className={`${cellInput} w-24`}
                        >
                          <option value="">-</option>
                          {priceBasisValues.map((basis) => (
                            <option key={basis} value={basis}>
                              {PRICE_BASIS_LABELS[basis]}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {error ? (
          <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={locked || rfqs.length === 0} className={primaryButton}>
            {pending ? "Saving..." : declined ? "Record the decline" : "Save quote"}
          </button>
          <span className="text-xs text-zinc-500">Saved with confidence 100% and no source span; review it like any other offer.</span>
        </div>
      </form>
    </section>
  );
}

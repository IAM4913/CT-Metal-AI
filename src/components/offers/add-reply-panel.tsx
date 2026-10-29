"use client";

// "Add reply" (PRD AC-9.1): paste the vendor's text, upload the .eml, or upload
// the quote PDF, and attach it to an RFQ. For an .eml the RFQ can be left on
// "auto-detect": the server matches In-Reply-To and References against the
// Message-IDs this request sent. When nothing matches (or for paste and PDF,
// which have no headers) the broker picks from the open RFQs of this request.
//
// The form posts FormData to ingestReplyAction. When the action answers
// needsRfqChoice the panel keeps the pasted text or file, shows the open RFQ
// list the action returned, and resubmits with the chosen rfqId. On success
// the workspace refreshes so the new offer card appears below.

import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { ingestReplyAction } from "@/app/(app)/requests/[id]/actions";
import type { RfqStatus } from "@/lib/db/enums";

/** An RFQ that can take a reply: this revision, status sent or responded (listOpenRfqs in src/lib/server/offers.ts). */
export type OpenRfqOption = {
  id: string;
  vendor_name: string;
  branch_name: string;
  status: RfqStatus;
  sent_at: string | null;
};

export type ReplyMode = "paste" | "eml" | "pdf";

export type AddReplyPanelProps = {
  requestId: string;
  openRfqs: OpenRfqOption[];
  /** The revision is superseded, or the workspace is busy. */
  disabled: boolean;
  /** Called after a successful ingest with a sentence for the workspace banner. */
  onIngested: (message: string) => void;
};

const MODES: ReadonlyArray<{ value: ReplyMode; label: string; help: string }> = [
  { value: "paste", label: "Paste text", help: "The body of the vendor's email or text message." },
  { value: "eml", label: "Upload .eml", help: "Saved from your mail client. Headers match it to the RFQ on their own." },
  { value: "pdf", label: "Upload PDF", help: "A quote the vendor sent as a file." },
];

/** Matches the .eml cap on /requests/new (MAX_EML_BYTES); serverActions.bodySizeLimit sits above it. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type IngestOutcome =
  | { kind: "ok"; offerId: string | null }
  | { kind: "choose"; openRfqs: OpenRfqOption[] }
  /** offerId is set when the reply was saved as an offer but its extraction failed (OfferExtractionError). */
  | { kind: "error"; message: string; offerId: string | null };

/**
 * ingestReplyAction answers { ok, offerId?, needsRfqChoice?, openRfqs?, error? }.
 * Read it field by field so a needsRfqChoice answer is recognized whichever
 * way ok is set on it.
 */
export function readIngestResult(result: unknown): IngestOutcome {
  if (result === null || typeof result !== "object") {
    return { kind: "error", message: "Unexpected answer from the server. Try again.", offerId: null };
  }
  const r = result as { ok?: unknown; offerId?: unknown; needsRfqChoice?: unknown; openRfqs?: unknown; error?: unknown };
  const offerId = typeof r.offerId === "string" ? r.offerId : null;
  if (r.needsRfqChoice === true) {
    return { kind: "choose", openRfqs: Array.isArray(r.openRfqs) ? (r.openRfqs as OpenRfqOption[]) : [] };
  }
  if (r.ok === true) return { kind: "ok", offerId };
  return {
    kind: "error",
    message: typeof r.error === "string" && r.error.trim() !== "" ? r.error : "The reply could not be ingested.",
    offerId,
  };
}

/** "Delta Steel, Fort Worth (sent Oct 20)" for the RFQ selects. */
export function rfqOptionLabel(rfq: OpenRfqOption): string {
  const when = rfq.sent_at ? `sent ${format(new Date(rfq.sent_at), "MMM d")}` : rfq.status;
  return `${rfq.vendor_name}, ${rfq.branch_name} (${when})`;
}

const inputClass =
  "w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50 disabled:text-zinc-500";
const primaryButton =
  "rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400";
const secondaryButton =
  "rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

export function AddReplyPanel({ requestId, openRfqs, disabled, onIngested }: AddReplyPanelProps) {
  const router = useRouter();
  const [mode, setMode] = useState<ReplyMode>("paste");
  const [rfqId, setRfqId] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<OpenRfqOption[] | null>(null);
  const [pickedRfqId, setPickedRfqId] = useState("");
  const [fileKey, setFileKey] = useState(0);
  const [pending, startSubmit] = useTransition();

  const noRfqs = openRfqs.length === 0;
  const needsRfq = mode !== "eml";
  const locked = disabled || pending;

  function changeMode(next: ReplyMode) {
    setMode(next);
    setFile(null);
    setError(null);
    setChoice(null);
    setFileKey((k) => k + 1);
  }

  function handleFile(event: FormEvent<HTMLInputElement>) {
    const picked = event.currentTarget.files?.[0] ?? null;
    setError(null);
    if (picked && picked.size > MAX_FILE_BYTES) {
      setFile(null);
      setError("That file is over 10 MB.");
      return;
    }
    if (picked && picked.size === 0) {
      setFile(null);
      setError("That file is empty.");
      return;
    }
    setFile(picked);
  }

  function submit(rfqOverride?: string) {
    const chosen = rfqOverride ?? rfqId;
    setError(null);

    if (mode === "paste" && text.trim() === "") {
      setError("Paste the reply text first.");
      return;
    }
    if (mode !== "paste" && file === null) {
      setError(mode === "eml" ? "Choose the .eml file." : "Choose the PDF file.");
      return;
    }
    if (needsRfq && chosen === "") {
      setError("Pick the RFQ this reply answers.");
      return;
    }

    const data = new FormData();
    data.set("requestId", requestId);
    data.set("mode", mode);
    if (chosen !== "") data.set("rfqId", chosen);
    if (mode === "paste") data.set("text", text);
    else if (file) data.set("file", file, file.name);

    startSubmit(async () => {
      let result: unknown;
      try {
        result = await ingestReplyAction(data);
      } catch (cause) {
        console.error("[offers] ingest failed", cause);
        setError("The reply did not reach the server. Try again.");
        return;
      }
      const outcome = readIngestResult(result);
      if (outcome.kind === "choose") {
        const options = outcome.openRfqs.length > 0 ? outcome.openRfqs : openRfqs;
        if (options.length === 0) {
          setError("The headers match no RFQ sent from this request, and there is no open RFQ to attach it to.");
          return;
        }
        setChoice(options);
        setPickedRfqId("");
        return;
      }
      if (outcome.kind === "error") {
        setError(outcome.message);
        // The reply was saved as an offer with no lines (the model call failed):
        // refresh so its card, with Re-extract, shows beside the error.
        if (outcome.offerId !== null) router.refresh();
        return;
      }
      const target = openRfqs.find((rfq) => rfq.id === chosen);
      setChoice(null);
      setText("");
      setFile(null);
      setRfqId("");
      setFileKey((k) => k + 1);
      onIngested(
        target
          ? `Reply from ${target.vendor_name}, ${target.branch_name} ingested and extracted. Review the lines below.`
          : "Reply matched by its headers, ingested, and extracted. Review the lines below.",
      );
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit();
  }

  const modeHelp = MODES.find((m) => m.value === mode)?.help ?? "";

  return (
    <section aria-labelledby="add-reply-heading" className="flex flex-col gap-4 rounded border border-zinc-200 p-4">
      <div>
        <h2 id="add-reply-heading" className="text-lg font-semibold">
          Add a reply
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Each reply becomes an offer with its lines extracted and tied to the request lines. Blanks are flagged, never
          filled.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <fieldset className="flex flex-wrap gap-4" disabled={locked}>
          <legend className="sr-only">How the reply arrived</legend>
          {MODES.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm text-zinc-800">
              <input
                type="radio"
                name="mode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => changeMode(option.value)}
                className="h-4 w-4 accent-zinc-900"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <p className="-mt-2 text-xs text-zinc-500">{modeHelp}</p>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">RFQ</span>
          <select
            name="rfqId"
            value={rfqId}
            onChange={(event) => setRfqId(event.target.value)}
            disabled={locked || (noRfqs && needsRfq)}
            required={needsRfq}
            className={inputClass}
          >
            <option value="">{mode === "eml" ? "Auto-detect from headers" : noRfqs ? "No open RFQs" : "Pick the RFQ this answers"}</option>
            {openRfqs.map((rfq) => (
              <option key={rfq.id} value={rfq.id}>
                {rfqOptionLabel(rfq)}
              </option>
            ))}
          </select>
          <span className="text-xs text-zinc-500">
            {mode === "eml"
              ? "Leave on auto-detect to match the In-Reply-To and References headers. Pick one to override."
              : "Open RFQs on this revision: sent, or already responded."}
          </span>
        </label>

        {mode === "paste" ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">Reply text</span>
            <textarea
              name="text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={locked}
              rows={6}
              spellCheck={false}
              placeholder="Have 60 pcs in stock at $0.98/ft, freight separate, 1% net 10."
              className={`${inputClass} font-mono leading-relaxed`}
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">{mode === "eml" ? "Email file" : "PDF file"}</span>
            <input
              key={fileKey}
              type="file"
              name="file"
              accept={mode === "eml" ? ".eml,message/rfc822" : ".pdf,application/pdf"}
              disabled={locked}
              onChange={handleFile}
              className="rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 file:mr-3 file:rounded file:border-0 file:bg-zinc-100 file:px-2 file:py-1 file:text-sm file:text-zinc-800 disabled:opacity-60"
            />
            <span className="text-xs text-zinc-500">
              {mode === "eml"
                ? "One .eml up to 10 MB. The raw file and any PDF inside it are stored with the offer."
                : "One PDF up to 10 MB. Lines are extracted from its text with page-level spans."}
            </span>
          </label>
        )}

        {error ? (
          <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        {noRfqs ? (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            No RFQ on this revision has been sent yet, so there is nothing to attach a reply to. Send the RFQs first.
          </p>
        ) : null}

        {choice ? (
          <div role="group" aria-labelledby="rfq-choice-heading" className="flex flex-col gap-2 rounded border border-amber-200 bg-amber-50 p-3">
            <p id="rfq-choice-heading" className="text-sm font-medium text-amber-900">
              The headers match no RFQ sent from this request. Which one is this reply for?
            </p>
            <ul className="flex flex-col gap-1">
              {choice.map((rfq) => (
                <li key={rfq.id}>
                  <label className="flex items-center gap-2 text-sm text-zinc-900">
                    <input
                      type="radio"
                      name="pickedRfqId"
                      value={rfq.id}
                      checked={pickedRfqId === rfq.id}
                      onChange={() => setPickedRfqId(rfq.id)}
                      disabled={locked}
                      className="h-4 w-4 accent-zinc-900"
                    />
                    {rfqOptionLabel(rfq)}
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => submit(pickedRfqId)}
                disabled={locked || pickedRfqId === ""}
                className={primaryButton}
              >
                {pending ? "Attaching..." : "Attach to this RFQ"}
              </button>
              <button type="button" onClick={() => setChoice(null)} disabled={locked} className={secondaryButton}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={locked || (noRfqs && needsRfq)} className={primaryButton}>
              {pending ? "Ingesting..." : "Ingest reply"}
            </button>
            {pending ? (
              <span role="status" className="text-xs text-zinc-500">
                Storing the reply and extracting lines. This takes a few seconds.
              </span>
            ) : null}
          </div>
        )}
      </form>
    </section>
  );
}

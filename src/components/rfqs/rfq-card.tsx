"use client";

// One RFQ draft (PRD FR-7, FR-8): the branch it goes to, its status, the
// recipients, subject, and body as editable fields while it is a draft or a
// failed send, read-only once it is sent. Each field commits on blur (or
// Enter for the single-line inputs) and is keyed by the saved value, so a
// refresh after a successful save remounts it with the stored value while a
// failed save keeps what was typed next to the error.
//
// Nothing here sends. "Retry" on a failed card and "Send all" in the workspace
// are the only paths to the mail adapter, and both are explicit clicks.
//
// body_stale marks a body that no longer matches what its lines would generate
// (edited by hand, or a line changed under a hand-edited body): the card says
// so beside Regenerate body and leaves the choice to the broker. readOnly (a
// superseded revision) shows every card the way a sent one is shown.

import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { RfqStatus } from "@/lib/db/enums";

export type RfqCardLine = { id: string; line_no: number; description: string };

export type RfqCardData = {
  id: string;
  branch_id: string;
  vendor_name: string;
  branch_name: string;
  status: RfqStatus;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  body_text: string;
  include_customer_name: boolean;
  sent_at: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  lines: RfqCardLine[];
  /** The stored body differs from the text the current lines would generate. */
  body_stale: boolean;
};

/** Mirrors the patch updateDraft accepts in src/lib/server/routing.ts. */
export type DraftPatch = Partial<{
  to_emails: string[];
  cc_emails: string[];
  body_text: string;
  subject: string;
  include_customer_name: boolean;
}>;

export type RfqCardProps = {
  rfq: RfqCardData;
  /** True while the workspace is sending; every control is disabled. */
  busy: boolean;
  /** The revision is superseded: show the card read-only whatever its status. */
  readOnly?: boolean;
  /** Each callback resolves to an error message, or null when the write succeeded. */
  onUpdate: (patch: DraftPatch) => Promise<string | null>;
  onRegenerate: () => Promise<string | null>;
  onRetry: () => Promise<string | null>;
};

const STATUS_LABELS: Record<RfqStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  sent: "Sent",
  failed: "Failed",
  responded: "Responded",
  declined: "Declined",
  closed: "Closed",
};

const STATUS_CLASSES: Record<RfqStatus, string> = {
  draft: "border-zinc-200 bg-zinc-100 text-zinc-700",
  queued: "border-sky-200 bg-sky-50 text-sky-800",
  sent: "border-indigo-200 bg-indigo-50 text-indigo-800",
  failed: "border-red-200 bg-red-50 text-red-800",
  responded: "border-emerald-200 bg-emerald-50 text-emerald-800",
  declined: "border-amber-200 bg-amber-50 text-amber-800",
  closed: "border-zinc-300 bg-zinc-200 text-zinc-800",
};

/** The statuses updateDraft accepts edits in. */
export function isEditable(status: RfqStatus): boolean {
  return status === "draft" || status === "failed";
}

/** "a@x.com, b@y.com" to ["a@x.com", "b@y.com"]; blanks dropped, order kept. */
export function parseEmailList(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export function RfqStatusBadge({ status }: { status: RfqStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const secondaryButton =
  "rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";
const inputBase =
  "w-full rounded border bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 disabled:bg-zinc-50 disabled:text-zinc-500";

export function RfqCard({ rfq, busy, readOnly = false, onUpdate, onRegenerate, onRetry }: RfqCardProps) {
  const router = useRouter();
  const [regenPending, startRegen] = useTransition();
  const [retryPending, startRetry] = useTransition();
  const [cardError, setCardError] = useState<string | null>(null);
  const editable = isEditable(rfq.status) && !busy && !readOnly;
  const disabled = busy || regenPending || retryPending || readOnly;

  function regenerate() {
    setCardError(null);
    startRegen(async () => {
      const message = await onRegenerate();
      if (message !== null) setCardError(message);
      else router.refresh();
    });
  }

  function retry() {
    setCardError(null);
    startRetry(async () => {
      const message = await onRetry();
      if (message !== null) setCardError(message);
      // Refresh either way: a failed retry still wrote a new last_error.
      router.refresh();
    });
  }

  return (
    <article aria-labelledby={`rfq-${rfq.id}-heading`} className="flex flex-col gap-4 rounded border border-zinc-200 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 id={`rfq-${rfq.id}-heading`} className="text-base font-semibold text-zinc-900">
            {rfq.vendor_name} <span className="font-normal text-zinc-600">{rfq.branch_name}</span>
          </h3>
          <RfqStatusBadge status={rfq.status} />
        </div>
        <div className="text-right text-xs text-zinc-500">
          <div>
            {rfq.lines.length} {rfq.lines.length === 1 ? "line" : "lines"}
          </div>
          {rfq.sent_at ? <div>Sent {format(new Date(rfq.sent_at), "MMM d, yyyy h:mm a")}</div> : null}
        </div>
      </header>

      {rfq.status === "failed" && rfq.last_error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span>
            <span className="font-medium">Send failed:</span> {rfq.last_error}
          </span>
          {readOnly ? null : (
            <button type="button" onClick={retry} disabled={disabled} className={secondaryButton}>
              {retryPending ? "Retrying..." : "Retry"}
            </button>
          )}
        </div>
      ) : null}

      {editable && rfq.to_emails.length === 0 ? (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          No recipient. Add a To address, or this RFQ is marked failed when you send.
        </p>
      ) : null}

      {cardError ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {cardError}
        </p>
      ) : null}

      <dl className="grid gap-3 text-sm sm:grid-cols-[6rem_1fr]">
        <Field label="To">
          {editable ? (
            <EmailListInput
              key={rfq.to_emails.join(",")}
              label={`To addresses for ${rfq.vendor_name} ${rfq.branch_name}`}
              value={rfq.to_emails}
              disabled={disabled}
              onCommit={(to_emails) => onUpdate({ to_emails })}
            />
          ) : (
            <ReadOnly value={rfq.to_emails.join(", ")} />
          )}
        </Field>
        <Field label="Cc">
          {editable ? (
            <EmailListInput
              key={rfq.cc_emails.join(",")}
              label={`Cc addresses for ${rfq.vendor_name} ${rfq.branch_name}`}
              value={rfq.cc_emails}
              disabled={disabled}
              onCommit={(cc_emails) => onUpdate({ cc_emails })}
            />
          ) : (
            <ReadOnly value={rfq.cc_emails.join(", ")} />
          )}
        </Field>
        <Field label="Subject">
          {editable ? (
            <TextInput
              key={rfq.subject}
              label={`Subject for ${rfq.vendor_name} ${rfq.branch_name}`}
              value={rfq.subject}
              disabled={disabled}
              onCommit={(subject) => onUpdate({ subject })}
            />
          ) : (
            <ReadOnly value={rfq.subject} />
          )}
        </Field>
        <Field label="Customer">
          <IncludeCustomerToggle
            key={String(rfq.include_customer_name)}
            checked={rfq.include_customer_name}
            disabled={!editable || disabled}
            onCommit={(include_customer_name) => onUpdate({ include_customer_name })}
          />
        </Field>
        {rfq.provider_message_id ? (
          <Field label="Message-ID">
            <ReadOnly value={rfq.provider_message_id} mono />
          </Field>
        ) : null}
      </dl>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Body</span>
          {editable ? (
            <button type="button" onClick={regenerate} disabled={disabled} className={secondaryButton}>
              {regenPending ? "Regenerating..." : "Regenerate body"}
            </button>
          ) : null}
        </div>
        {editable && rfq.body_stale ? (
          <p role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This body differs from what the current lines would generate: it was edited by hand, or a line changed
            since. Check it before sending, or Regenerate body to rebuild it from the lines.
          </p>
        ) : null}
        {editable ? (
          <BodyTextarea
            key={rfq.body_text}
            label={`Body for ${rfq.vendor_name} ${rfq.branch_name}`}
            value={rfq.body_text}
            disabled={disabled}
            onCommit={(body_text) => onUpdate({ body_text })}
          />
        ) : (
          <pre className="whitespace-pre-wrap rounded border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-800">
            {rfq.body_text}
          </pre>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Lines in this RFQ</span>
        {rfq.lines.length === 0 ? (
          <p className="text-sm text-zinc-500">No lines. Route a line to this branch on the Route tab.</p>
        ) : (
          <ul className="text-sm text-zinc-800">
            {rfq.lines.map((line) => (
              <li key={line.id} className="flex gap-2">
                <span className="w-6 shrink-0 text-right tabular-nums text-zinc-500">{line.line_no}</span>
                <span>{line.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Field pieces
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function ReadOnly({ value, mono = false }: { value: string; mono?: boolean }) {
  if (value.trim() === "") return <span className="text-zinc-400">-</span>;
  return <span className={`break-all text-zinc-800 ${mono ? "font-mono text-xs" : ""}`}>{value}</span>;
}

/** Runs a commit inside a transition and refreshes on success, so the field stays disabled until the stored value arrives. */
function useFieldCommit<T>(commit: (value: T) => Promise<string | null>) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(value: T) {
    setError(null);
    startSaving(async () => {
      const message = await commit(value);
      if (message !== null) setError(message);
      else router.refresh();
    });
  }
  return { saving, error, run };
}

function FieldError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-red-700">
      {message}
    </p>
  );
}

function inputClass(error: string | null, extra = ""): string {
  return `${inputBase} ${error ? "border-red-400" : "border-zinc-300"} ${extra}`.trim();
}

type TextInputProps = {
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => Promise<string | null>;
};

function TextInput({ label, value, disabled, onCommit }: TextInputProps) {
  const [draft, setDraft] = useState(value);
  const skipNextBlur = useRef(false);
  const commit = useFieldCommit(onCommit);

  function handleBlur() {
    if (skipNextBlur.current) {
      skipNextBlur.current = false;
      return;
    }
    const trimmed = draft.trim();
    if (trimmed === value.trim()) return;
    commit.run(trimmed);
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
    <div>
      <input
        type="text"
        aria-label={label}
        value={draft}
        disabled={disabled || commit.saving}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        title={commit.saving ? "Saving" : undefined}
        className={inputClass(commit.error)}
      />
      <FieldError message={commit.error} />
    </div>
  );
}

type EmailListInputProps = {
  label: string;
  value: string[];
  disabled: boolean;
  onCommit: (emails: string[]) => Promise<string | null>;
};

function EmailListInput({ label, value, disabled, onCommit }: EmailListInputProps) {
  return (
    <TextInput
      label={label}
      value={value.join(", ")}
      disabled={disabled}
      onCommit={(text) => {
        const emails = parseEmailList(text);
        if (emails.join(",") === value.join(",")) return Promise.resolve(null);
        return onCommit(emails);
      }}
    />
  );
}

type BodyTextareaProps = {
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => Promise<string | null>;
};

function BodyTextarea({ label, value, disabled, onCommit }: BodyTextareaProps) {
  const [draft, setDraft] = useState(value);
  const commit = useFieldCommit(onCommit);
  const rows = Math.min(24, Math.max(8, value.split("\n").length + 1));

  function handleBlur() {
    if (draft === value) return;
    commit.run(draft);
  }

  return (
    <div>
      <textarea
        aria-label={label}
        value={draft}
        rows={rows}
        disabled={disabled || commit.saving}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={handleBlur}
        title={commit.saving ? "Saving" : undefined}
        className={inputClass(commit.error, "font-mono leading-relaxed")}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500">Plain text. Saved when you click away.</span>
        {commit.saving ? (
          <span className="text-xs text-zinc-500" role="status">
            Saving...
          </span>
        ) : null}
      </div>
      <FieldError message={commit.error} />
    </div>
  );
}

type IncludeCustomerToggleProps = {
  checked: boolean;
  disabled: boolean;
  onCommit: (checked: boolean) => Promise<string | null>;
};

function IncludeCustomerToggle({ checked, disabled, onCommit }: IncludeCustomerToggleProps) {
  const commit = useFieldCommit(onCommit);
  return (
    <div>
      <label className="flex items-center gap-2 pt-1.5 text-sm text-zinc-800">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || commit.saving}
          onChange={(event) => commit.run(event.target.checked)}
          className="h-4 w-4 accent-zinc-900"
        />
        Include the customer name in the body
        {commit.saving ? <span className="text-xs text-zinc-500">Saving...</span> : null}
      </label>
      <FieldError message={commit.error} />
    </div>
  );
}

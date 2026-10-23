"use client";

// The original request, unchanged (AC-1.4), with the selected line's span
// highlighted (AC-3.1). The text is split once at the span's start and end into
// before, mark, after; nothing is re-flowed or trimmed, so offsets recorded at
// parse time land on the same characters here. A span that points into an
// attachment page cannot be marked in the email body, so a line above the text
// says which file and page the line came from instead.
//
// Client component because the highlighted span scrolls into view when the
// selection changes.

import { format } from "date-fns";
import { useEffect, useRef } from "react";
import { AttachmentsList } from "@/components/attachments-list";

export type SourceHighlight =
  | { kind: "text"; start: number; end: number }
  | { kind: "attachment"; filename: string; page: number }
  | { kind: "none"; reason: string };

export type SourceMessage = {
  from_email: string;
  to_emails: string[];
  cc_emails: string[];
  received_at: string;
};

export type SourceAttachment = { id: string; filename: string; mime: string; size_bytes: number };

type SourcePaneProps = {
  sourceText: string;
  attachments: SourceAttachment[];
  message: SourceMessage | null;
  highlight: SourceHighlight | null;
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** before, mark, after; mark is empty when the span is empty or out of range. */
export function splitAtSpan(text: string, span: { start: number; end: number }): [string, string, string] {
  const start = clamp(Math.trunc(span.start), 0, text.length);
  const end = clamp(Math.trunc(span.end), start, text.length);
  return [text.slice(0, start), text.slice(start, end), text.slice(end)];
}

export function SourcePane({ sourceText, attachments, message, highlight }: SourcePaneProps) {
  const markRef = useRef<HTMLElement>(null);
  const highlightKey =
    highlight === null
      ? ""
      : highlight.kind === "text"
        ? `text:${highlight.start}:${highlight.end}`
        : highlight.kind === "attachment"
          ? `attachment:${highlight.filename}:${highlight.page}`
          : `none:${highlight.reason}`;

  useEffect(() => {
    if (highlightKey.startsWith("text:")) {
      markRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightKey]);

  const textSpan = highlight?.kind === "text" ? highlight : null;
  const [before, mark, after] = textSpan ? splitAtSpan(sourceText, textSpan) : [sourceText, "", ""];

  return (
    <section aria-labelledby="source-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="source-heading" className="text-lg font-semibold">
          Source
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Exactly what the customer sent. Select a line on the right to see where it came from.
        </p>
      </div>

      {message ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
          <dt className="font-medium text-zinc-500">From</dt>
          <dd className="break-all">{message.from_email || "(no sender)"}</dd>
          {message.to_emails.length > 0 ? (
            <>
              <dt className="font-medium text-zinc-500">To</dt>
              <dd className="break-all">{message.to_emails.join(", ")}</dd>
            </>
          ) : null}
          {message.cc_emails.length > 0 ? (
            <>
              <dt className="font-medium text-zinc-500">Cc</dt>
              <dd className="break-all">{message.cc_emails.join(", ")}</dd>
            </>
          ) : null}
          <dt className="font-medium text-zinc-500">Date</dt>
          <dd>{format(new Date(message.received_at), "MMM d, yyyy h:mm a")}</dd>
        </dl>
      ) : null}

      {highlight?.kind === "attachment" ? (
        <p className="rounded border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          Selected line is from <span className="font-medium">{highlight.filename}</span>, page {highlight.page}.
        </p>
      ) : null}
      {highlight?.kind === "none" ? (
        <p className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">{highlight.reason}</p>
      ) : null}
      {textSpan && mark === "" ? (
        <p className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
          The recorded span for this line is empty or outside the text.
        </p>
      ) : null}

      {sourceText.trim() === "" ? (
        <p className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500">
          The source text is empty.
        </p>
      ) : (
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-sm leading-relaxed text-zinc-900">
          {before}
          {mark !== "" ? (
            <mark ref={markRef} className="rounded-sm bg-amber-200 text-zinc-900 ring-2 ring-amber-300">
              {mark}
            </mark>
          ) : null}
          {after}
        </pre>
      )}

      <div>
        <h3 className="text-sm font-semibold text-zinc-800">Attachments</h3>
        <div className="mt-2">
          <AttachmentsList attachments={attachments} />
        </div>
      </div>
    </section>
  );
}

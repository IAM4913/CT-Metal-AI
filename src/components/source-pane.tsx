// The original request, unchanged (AC-1.4): the full source_text as sent,
// signature and quoted thread included, plus the files stored under the
// request. When the request came from an email, the inbound message header
// (sender, recipients, date) sits above the text.

import { format } from "date-fns";
import { AttachmentsList } from "@/components/attachments-list";
import type { Tables } from "@/lib/db/client";

type MessageHeader = Pick<Tables<"messages">, "from_email" | "to_emails" | "cc_emails" | "received_at">;

export function SourcePane({
  sourceText,
  attachments,
  message = null,
}: {
  sourceText: string;
  attachments: Pick<Tables<"attachments">, "id" | "filename" | "mime" | "size_bytes">[];
  message?: MessageHeader | null;
}) {
  return (
    <section aria-labelledby="source-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="source-heading" className="text-lg font-semibold">
          Source
        </h2>
        <p className="mt-1 text-sm text-zinc-600">Exactly what the customer sent. Nothing here is edited.</p>
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

      {sourceText.trim() === "" ? (
        <p className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500">
          The source text is empty.
        </p>
      ) : (
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-sm leading-relaxed text-zinc-900">
          {sourceText}
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

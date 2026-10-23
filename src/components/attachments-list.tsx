// Files stored under a request (AC-1.2, AC-1.4). Each link goes through the
// /attachments/[id] route handler, which checks the session, loads the row
// under RLS, and redirects to a short-lived signed Storage URL.

import type { Tables } from "@/lib/db/client";

type AttachmentRow = Pick<Tables<"attachments">, "id" | "filename" | "mime" | "size_bytes">;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsList({ attachments }: { attachments: AttachmentRow[] }) {
  if (attachments.length === 0) {
    return <p className="text-sm text-zinc-500">No attachments.</p>;
  }

  return (
    <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 text-sm">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
          <a
            href={`/attachments/${attachment.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-zinc-900 underline hover:text-zinc-700"
          >
            {attachment.filename}
          </a>
          <span className="text-xs text-zinc-500">{attachment.mime}</span>
          <span className="ml-auto text-xs text-zinc-500">{formatBytes(attachment.size_bytes)}</span>
        </li>
      ))}
    </ul>
  );
}

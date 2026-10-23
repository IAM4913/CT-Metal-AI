// Upload a saved email (AC-1.2). Server component: a plain multipart form posting
// to the eml server action. The 10 MB figure matches the file check in
// actions.ts (MAX_EML_BYTES); serverActions.bodySizeLimit in next.config.ts
// sits above it so that check, not a 413, is what a too-large file hits.

import { createEmlAction } from "@/app/(app)/requests/new/actions";

export function EmlUploadForm() {
  return (
    <section aria-labelledby="eml-heading" className="rounded border border-zinc-200 p-4">
      <h2 id="eml-heading" className="text-lg font-semibold">
        Upload an .eml
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Save the customer&apos;s email from your mail client and drop it here. Sender, subject, date, the
        full body, and every attachment are kept with the request. The customer is linked automatically when
        the sender&apos;s domain matches one on file.
      </p>

      <form action={createEmlAction} className="mt-4 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">Email file</span>
          <input
            type="file"
            name="file"
            accept=".eml,message/rfc822"
            required
            className="rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 file:mr-3 file:rounded file:border-0 file:bg-zinc-100 file:px-2 file:py-1 file:text-sm file:text-zinc-800"
          />
          <span className="text-xs text-zinc-500">
            One .eml up to 10 MB. Attachments inside it are stored under the request and listed on the review
            tab.
          </span>
        </label>

        <div>
          <button
            type="submit"
            className="rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Create request from email
          </button>
        </div>
      </form>
    </section>
  );
}

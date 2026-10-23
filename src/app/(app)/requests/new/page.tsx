// Intake page (PRD section 9, /requests/new): three ways to start a request on
// one screen. Each section is its own form posting to its own server action in
// ./actions.ts. A failed submit comes back here with ?error=<code>.

import { EmlUploadForm } from "@/components/intake/eml-upload-form";
import { ManualLinesForm } from "@/components/intake/manual-lines-form";
import { PasteForm } from "@/components/intake/paste-form";
import { listCustomers } from "@/lib/server/requests";
import { requireBroker } from "@/lib/server/session";

const ERROR_MESSAGES: Record<string, string> = {
  paste: "Paste the material list before submitting.",
  customer: "That customer was not recognized. Pick one from the list or leave it blank.",
  eml: "Choose a .eml file to upload.",
  eml_size: "That file is over 10 MB. Save the email without its largest attachments and try again.",
  eml_type: "That does not look like an .eml file. Save the email as .eml from your mail client.",
  eml_parse: "Could not read that .eml file. Check that it is a saved email and try again.",
  manual: "Every line needs a description, and quantity must be a positive number.",
  manual_empty: "Enter at least one line.",
  failed: "Could not save the request. Try again.",
};

type NewRequestPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function NewRequestPage({ searchParams }: NewRequestPageProps) {
  const session = await requireBroker();
  const [params, customers] = await Promise.all([searchParams, listCustomers(session)]);

  const code = typeof params.error === "string" ? params.error : null;
  // Own keys only: the code comes from the URL, and a prototype key such as
  // "constructor" or "__proto__" must fall back to the generic message rather
  // than hand React a function or an object to render.
  const errorMessage =
    code === null ? null : Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : ERROR_MESSAGES.failed;

  return (
    <main className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold">New request</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Paste a list, upload the customer&apos;s email, or type the lines in. The original text is kept
          as sent and parsed on the next screen.
        </p>
      </div>

      {errorMessage ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </p>
      ) : null}

      <PasteForm customers={customers} />
      <EmlUploadForm />
      <ManualLinesForm customers={customers} />
    </main>
  );
}

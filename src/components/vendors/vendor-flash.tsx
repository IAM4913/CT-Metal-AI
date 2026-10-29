// The one-line result of the last vendor admin form post, read from the URL:
// ?saved=<what>, ?deleted=<what>, or ?error=<code>&n=<count>. The codes are
// written by src/app/(app)/vendors/actions.ts. Only own keys of the tables are
// honored: the values come from the URL, and a prototype key such as
// "constructor" must fall back to the generic message rather than hand React a
// function to render.

type SearchParams = Record<string, string | string[] | undefined>;

const SAVED_MESSAGES: Record<string, string> = {
  vendor: "Vendor saved.",
  branch: "Branch saved.",
  contact: "Contact saved.",
  capabilities: "Capabilities saved.",
};

const DELETED_MESSAGES: Record<string, string> = {
  vendor: "Vendor deleted.",
  branch: "Branch deleted.",
  contact: "Contact deleted.",
};

const ERROR_MESSAGES: Record<string, string> = {
  vendor_invalid: "Check the vendor fields: a name and a type are required.",
  branch_invalid:
    "Check the branch fields: name, city, and state are required, early-pay percent is 0 to 100, and early-pay days is a whole number.",
  contact_invalid: "Check the contact fields: a name and a valid email address are required.",
  capabilities_invalid: "One of the categories was not recognized. Reload the page and try again.",
  not_found: "That record was not found. It may have been deleted.",
  failed: "Could not save. Try again.",
};

function single(params: SearchParams, key: string): string | null {
  const value = params[key];
  return typeof value === "string" ? value : null;
}

function lookup(table: Record<string, string>, code: string | null): string | null {
  if (code === null) return null;
  return Object.hasOwn(table, code) ? table[code] : null;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The sentence for the URL state, or null when the URL carries none. */
export function flashMessage(params: SearchParams): { tone: "ok" | "error"; text: string } | null {
  const error = single(params, "error");
  if (error !== null) {
    const n = Number(single(params, "n"));
    const count = Number.isInteger(n) && n > 0 ? n : null;
    if (error === "vendor_in_use") {
      return {
        tone: "error",
        text: `This vendor cannot be deleted: its branches have ${count === null ? "RFQ or purchase history" : plural(count, "RFQ or purchase")}. Keep it for the history, or clear its preferred flags so it stops being suggested.`,
      };
    }
    if (error === "branch_in_use") {
      return {
        tone: "error",
        text: `This branch cannot be deleted: it has ${count === null ? "RFQ or purchase history" : plural(count, "RFQ or purchase")}. Keep it for the history, or clear its preferred flag and capabilities so it stops being suggested.`,
      };
    }
    return { tone: "error", text: lookup(ERROR_MESSAGES, error) ?? ERROR_MESSAGES.failed };
  }

  const saved = lookup(SAVED_MESSAGES, single(params, "saved"));
  if (saved) return { tone: "ok", text: saved };

  const deleted = lookup(DELETED_MESSAGES, single(params, "deleted"));
  if (deleted) return { tone: "ok", text: deleted };

  return null;
}

export function VendorFlash({ params }: { params: SearchParams }) {
  const flash = flashMessage(params);
  if (!flash) return null;
  return (
    <p
      role={flash.tone === "error" ? "alert" : "status"}
      className={
        flash.tone === "error"
          ? "rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          : "rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      }
    >
      {flash.text}
    </p>
  );
}

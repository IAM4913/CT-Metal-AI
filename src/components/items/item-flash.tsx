// The one-line result of the last item admin form post, read from the URL:
// ?saved=<what>, ?deleted=<what>, or ?error=<code>. The codes are written by
// src/app/(app)/items/actions.ts. Only own keys of the tables are honored:
// the values come from the URL, and a prototype key such as "constructor"
// must fall back to the generic message rather than hand React a function.
//
// An alias save may carry ?also=<designations>, the other items that own the
// same normalized alias. Each one is shown only when it looks like a
// designation (letters, digits, and the few punctuation marks the catalog
// uses); anything else collapses to a count.

type SearchParams = Record<string, string | string[] | undefined>;

const SAVED_MESSAGES: Record<string, string> = {
  item: "Item saved.",
  item_created: "Item created. Add the phrases shops use for it as aliases below so the parser can find it.",
  alias: "Alias saved.",
};

const DELETED_MESSAGES: Record<string, string> = {
  alias: "Alias deleted.",
};

const ERROR_MESSAGES: Record<string, string> = {
  designation_invalid:
    "A designation is required: the canonical name with no spaces, such as C12x30 or HSS8x8x5/8 (80 characters max).",
  designation_taken: "An item with that designation already exists.",
  category_invalid: "Pick a category.",
  weight_invalid: "Weight per foot must be a number of pounds above 0, or left blank when unknown.",
  grade_invalid: "Default grade is 60 characters max.",
  dims_not_json:
    'Dims is not valid JSON. Write an object like {"a": 8, "b": 8, "t": 0.625}, with double quotes around every key.',
  dims_not_object:
    'Dims must be a JSON object (curly braces with named keys), like {"t": 0.375}, not a list or a single value.',
  dims_bad_values:
    "Every dims value must be a number or a string. Nested objects, lists, true, false, and null are not allowed.",
  dims_invalid: 'Check the dims field: a JSON object of numbers or strings, like {"a": 8, "b": 8, "t": 0.625}.',
  item_invalid: "Check the item fields: a category and a designation are required.",
  alias_invalid: "Type the alias first (200 characters max).",
  alias_empty:
    "That alias has nothing left after normalization (no letters or digits). Write the phrase a shop would use, such as 8 square 5/8.",
  alias_exists: "This item already has that alias (the same phrase once normalized).",
  alias_not_found: "That alias was not found, or it is a seed alias, which cannot be deleted.",
  not_found: "That item was not found. It may have been deleted.",
  failed: "Could not save. Try again.",
};

const DESIGNATION_PATTERN = /^[A-Za-z0-9#./-]{1,40}$/;

function single(params: SearchParams, key: string): string | null {
  const value = params[key];
  return typeof value === "string" ? value : null;
}

function lookup(table: Record<string, string>, code: string | null): string | null {
  if (code === null) return null;
  return Object.hasOwn(table, code) ? table[code] : null;
}

/** The ?also= designations that pass the pattern, and how many were given. */
export function collisionsFrom(params: SearchParams): { shown: string[]; total: number } {
  const raw = single(params, "also");
  if (raw === null || raw === "") return { shown: [], total: 0 };
  const parts = raw.split(",").filter((part) => part !== "");
  return { shown: parts.filter((part) => DESIGNATION_PATTERN.test(part)), total: parts.length };
}

/** The sentence for the URL state, or null when the URL carries none. */
export function flashMessage(params: SearchParams): { tone: "ok" | "error"; text: string } | null {
  const error = single(params, "error");
  if (error !== null) {
    return { tone: "error", text: lookup(ERROR_MESSAGES, error) ?? ERROR_MESSAGES.failed };
  }

  const saved = lookup(SAVED_MESSAGES, single(params, "saved"));
  if (saved) {
    const { shown, total } = collisionsFrom(params);
    if (total === 0) return { tone: "ok", text: saved };
    const which =
      shown.length === total && shown.length > 0
        ? shown.join(", ")
        : `${total} other item${total === 1 ? "" : "s"}`;
    return {
      tone: "ok",
      text: `${saved} Note: ${which} also ${total === 1 ? "carries" : "carry"} this alias. Your learned alias wins when a request is parsed, so check that this is the item you meant.`,
    };
  }

  const deleted = lookup(DELETED_MESSAGES, single(params, "deleted"));
  if (deleted) return { tone: "ok", text: deleted };

  return null;
}

export function ItemFlash({ params }: { params: SearchParams }) {
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

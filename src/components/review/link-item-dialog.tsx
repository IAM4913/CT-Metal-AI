"use client";

// Link a line to a catalog item (AC-2.3, AC-3.5). Type a designation or the
// shop phrase, pick a result, done. For an unmatched line the lib saves the
// line's description as a learned alias for the item, so the same wording
// matches on its own next time; the dialog says so because the broker should
// know what is being remembered. Two cases learn nothing, and the dialog says
// that too: re-linking an already linked line (its description is the old
// item's designation, not shop language), and a description with no size in it
// ("angle", "plate"), which would make every later size-less line of that
// shape resolve to the picked item. The size test here mirrors aliasToLearn()
// in src/lib/server/review.ts: a digit, or a vulgar fraction that normalizes
// to one.
//
// Search is debounced and out-of-order replies are dropped (a slow reply for
// "C1" must not overwrite the results for "C12x30").

import { useEffect, useRef, useState } from "react";
import { searchCatalogAction } from "@/app/(app)/requests/[id]/actions";

type SearchOk = Extract<Awaited<ReturnType<typeof searchCatalogAction>>, { ok: true }>;
export type CatalogSearchResult = SearchOk["results"][number];

type LinkItemDialogProps = {
  line: { id: string; line_no: number; description: string; raw_text: string; catalog_item_id: string | null };
  /** Resolves to an error message, or null when the link was saved. */
  onPick: (catalogItemId: string) => Promise<string | null>;
  onClose: () => void;
};

const DEBOUNCE_MS = 300;

// A digit, or a Unicode vulgar fraction (U+00BC to U+00BE, U+2150 to U+215E),
// which normalizeAlias turns into digits before the alias is stored.
const CARRIES_SIZE = /[\d¼-¾⅐-⅞]/;

const inputClass =
  "w-full rounded border border-zinc-300 px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500";

export function LinkItemDialog({ line, onPick, onClose }: LinkItemDialogProps) {
  const [query, setQuery] = useState(line.description);
  // The query the current results answer; "searching" is derived from the gap
  // between it and the typed query, so no state is set synchronously in an effect.
  const [answered, setAnswered] = useState<{ query: string; results: CatalogSearchResult[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const sequence = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = query.trim();
  const results = answered && answered.query === trimmed ? answered.results : [];
  const searching = trimmed !== "" && (answered === null || answered.query !== trimmed);
  const learnsAlias = line.catalog_item_id === null && CARRIES_SIZE.test(line.description);

  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, []);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (trimmed === "") return;
    const seq = ++sequence.current;
    const timer = setTimeout(async () => {
      const result = await searchCatalogAction(trimmed);
      if (seq !== sequence.current) return;
      if (result.ok) {
        setAnswered({ query: trimmed, results: result.results });
        setError(null);
      } else {
        setAnswered({ query: trimmed, results: [] });
        setError(result.error);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  async function pick(item: CatalogSearchResult) {
    setPickingId(item.id);
    setError(null);
    const message = await onPick(item.id);
    if (message !== null) {
      setError(message);
      setPickingId(null);
      return;
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-zinc-900/40 p-4 pt-24"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-item-heading"
        className="flex w-full max-w-lg flex-col gap-4 rounded border border-zinc-200 bg-white p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="link-item-heading" className="text-lg font-semibold">
              Link line {line.line_no} to a catalog item
            </h2>
            {learnsAlias ? (
              <p className="mt-1 text-sm text-zinc-600">
                <span className="font-medium text-zinc-800">&ldquo;{line.description}&rdquo;</span> is saved as an
                alias for the item you pick, so it matches on its own next time.
              </p>
            ) : line.catalog_item_id === null ? (
              <p className="mt-1 text-sm text-zinc-600">
                No alias is learned from{" "}
                <span className="font-medium text-zinc-800">&ldquo;{line.description}&rdquo;</span>: it names no size,
                and an alias without one would match every later line of that shape.
              </p>
            ) : (
              <p className="mt-1 text-sm text-zinc-600">
                Currently linked to <span className="font-medium text-zinc-800">{line.description}</span>. Picking
                another item changes the link; no alias is learned.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            Close
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">Designation or shop phrase</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="HSS8x8x5/8, 12 inch channel 30#, 3/8 plate"
            spellCheck={false}
            className={inputClass}
          />
        </label>

        {error ? (
          <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="max-h-72 overflow-auto rounded border border-zinc-200">
          {trimmed === "" ? (
            <p className="px-3 py-6 text-center text-sm text-zinc-500">Type a designation or the words the customer used.</p>
          ) : searching ? (
            <p className="px-3 py-6 text-center text-sm text-zinc-500">Searching...</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-zinc-500">
              No catalog item matches. Try the designation, or mark the line as a custom item.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200 text-sm">
              {results.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div>
                    <div className="font-medium text-zinc-900">{item.designation}</div>
                    <div className="text-xs text-zinc-500">{item.category.replace(/_/g, " ")}</div>
                  </div>
                  <button
                    type="button"
                    disabled={pickingId !== null}
                    onClick={() => pick(item)}
                    className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pickingId === item.id ? "Linking..." : "Link"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

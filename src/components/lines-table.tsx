// Read-only view of request_lines for the Review tab. Step 4 replaces this with
// the editable TanStack grid (AC-3.1, AC-3.2); until then it shows what intake
// wrote, flags included, so a missing value is visible rather than filled in.

import type { Tables } from "@/lib/db/client";

type LineRow = Pick<
  Tables<"request_lines">,
  | "id"
  | "line_no"
  | "description"
  | "qty"
  | "unit"
  | "length_text"
  | "length_ft"
  | "grade_spec"
  | "flags"
  | "confidence"
  | "status"
>;

/** ASCII hyphen as the empty-cell marker. The flags column says why a cell is empty. */
const EMPTY = "-";

const headerClass = "px-2 py-2 font-medium";
const cellClass = "px-2 py-2 align-top";

function formatLength(line: Pick<LineRow, "length_text" | "length_ft">): string {
  if (line.length_text && line.length_text.trim() !== "") return line.length_text;
  if (line.length_ft !== null) return `${line.length_ft} ft`;
  return EMPTY;
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function flagLabel(flag: string): string {
  return flag.replace(/_/g, " ");
}

export function LinesTable({ lines }: { lines: LineRow[] }) {
  return (
    <section aria-labelledby="lines-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="lines-heading" className="text-lg font-semibold">
          Lines
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          {lines.length === 0
            ? "Parse and review arrive in Step 4."
            : `${lines.length} line${lines.length === 1 ? "" : "s"}. Blank cells are flagged, never guessed.`}
        </p>
      </div>

      {lines.length === 0 ? (
        <p className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500">
          No lines yet. Parsing this request into lines is the next step.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-zinc-200">
          <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                <th scope="col" className={headerClass}>
                  #
                </th>
                <th scope="col" className={headerClass}>
                  Description
                </th>
                <th scope="col" className={`${headerClass} text-right`}>
                  Qty
                </th>
                <th scope="col" className={headerClass}>
                  Unit
                </th>
                <th scope="col" className={headerClass}>
                  Length
                </th>
                <th scope="col" className={headerClass}>
                  Grade
                </th>
                <th scope="col" className={headerClass}>
                  Flags
                </th>
                <th scope="col" className={`${headerClass} text-right`}>
                  Conf.
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {lines.map((line) => (
                <tr key={line.id} className={line.status === "removed" ? "text-zinc-400 line-through" : ""}>
                  <td className={`${cellClass} tabular-nums text-zinc-500`}>{line.line_no}</td>
                  <td className={cellClass}>{line.description}</td>
                  <td className={`${cellClass} text-right tabular-nums`}>{line.qty ?? EMPTY}</td>
                  <td className={cellClass}>{line.unit ?? EMPTY}</td>
                  <td className={cellClass}>{formatLength(line)}</td>
                  <td className={cellClass}>{line.grade_spec ?? EMPTY}</td>
                  <td className={cellClass}>
                    {line.flags.length === 0 ? (
                      <span className="text-zinc-400">{EMPTY}</span>
                    ) : (
                      <ul className="flex flex-wrap gap-1">
                        {line.flags.map((flag) => (
                          <li
                            key={flag}
                            className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800"
                          >
                            {flagLabel(flag)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className={`${cellClass} text-right tabular-nums`}>{formatConfidence(line.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

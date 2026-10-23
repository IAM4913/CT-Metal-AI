// Request line flags as small chips (PRD AC-2.2). One color per family so a
// glance separates "something is missing" (amber) from "the model was unsure"
// (violet), "no catalog item" (rose), "check for a repeat" (sky), and "the
// customer named an alternate" (teal). No hooks, so it renders from either a
// server or a client component.

import type { RequestLineFlag } from "@/lib/db/enums";

const FLAG_CLASSES: Record<RequestLineFlag, string> = {
  missing_grade: "border-amber-200 bg-amber-50 text-amber-800",
  missing_qty: "border-amber-200 bg-amber-50 text-amber-800",
  missing_length: "border-amber-200 bg-amber-50 text-amber-800",
  ambiguous_size: "border-violet-200 bg-violet-50 text-violet-800",
  ambiguous_unit: "border-violet-200 bg-violet-50 text-violet-800",
  unmatched_item: "border-rose-200 bg-rose-50 text-rose-800",
  possible_duplicate: "border-sky-200 bg-sky-50 text-sky-800",
  alternate_mentioned: "border-teal-200 bg-teal-50 text-teal-800",
};

const FLAG_TITLES: Record<RequestLineFlag, string> = {
  missing_grade: "No grade or spec in the source. Leave blank only if the customer does not care.",
  missing_qty: "No quantity in the source. Required before confirming.",
  missing_length: "No length in the source.",
  ambiguous_size: "The size could be read more than one way.",
  ambiguous_unit: "A count with no unit, or a unit that could mean two things.",
  unmatched_item: "No catalog item matched. Link one or mark the line custom.",
  possible_duplicate: "Another line names the same item at the same length and grade.",
  alternate_mentioned: "The customer named an alternate (another wall, grade, or size).",
};

export function flagLabel(flag: RequestLineFlag): string {
  return flag.replace(/_/g, " ");
}

export function FlagChip({ flag }: { flag: RequestLineFlag }) {
  return (
    <span
      title={FLAG_TITLES[flag]}
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${FLAG_CLASSES[flag]}`}
    >
      {flagLabel(flag)}
    </span>
  );
}

export function FlagChips({ flags, emptyText = "-" }: { flags: RequestLineFlag[]; emptyText?: string }) {
  if (flags.length === 0) {
    return <span className="text-zinc-400">{emptyText}</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <li key={flag}>
          <FlagChip flag={flag} />
        </li>
      ))}
    </ul>
  );
}

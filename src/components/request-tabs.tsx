"use client";

// Tab strip for the request workspace (PRD section 9: Review, Route, RFQs,
// Offers, Compare). Client component only because the active tab comes from
// the current pathname; the tabs themselves are plain links.

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { segment: "", label: "Review" },
  { segment: "route", label: "Route" },
  { segment: "rfqs", label: "RFQs" },
  { segment: "offers", label: "Offers" },
  { segment: "compare", label: "Compare" },
] as const;

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function RequestTabs({ requestId }: { requestId: string }) {
  const pathname = stripTrailingSlash(usePathname());
  const base = `/requests/${requestId}`;

  return (
    <nav aria-label="Request sections" className="border-b border-zinc-200">
      <ul className="-mb-px flex flex-wrap gap-x-1 text-sm">
        {TABS.map((tab) => {
          const href = tab.segment ? `${base}/${tab.segment}` : base;
          const active = tab.segment ? pathname === href || pathname.startsWith(`${href}/`) : pathname === base;
          return (
            <li key={tab.label}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "inline-block border-b-2 border-zinc-900 px-3 py-2 font-medium text-zinc-900"
                    : "inline-block border-b-2 border-transparent px-3 py-2 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900"
                }
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

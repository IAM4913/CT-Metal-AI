// The /vendors list: one row per vendor with its type, branch counts, and the
// first line of its notes. Plain table; the name links to the detail page.

import Link from "next/link";
import { excerpt, type VendorListRow } from "@/lib/server/vendors";
import { VENDOR_TYPE_LABELS } from "./labels";

export function VendorTable({ vendors }: { vendors: VendorListRow[] }) {
  if (vendors.length === 0) {
    return <p className="text-sm text-zinc-600">No vendors yet. Add the first one below.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
            <th scope="col" className="py-2 pr-4 font-medium">
              Vendor
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Type
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              Branches
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              Preferred
            </th>
            <th scope="col" className="py-2 font-medium">
              Notes
            </th>
          </tr>
        </thead>
        <tbody>
          {vendors.map((vendor) => (
            <tr key={vendor.id} className="border-b border-zinc-100 align-top">
              <td className="py-2 pr-4">
                <Link href={`/vendors/${vendor.id}`} className="font-medium text-zinc-900 underline hover:text-zinc-700">
                  {vendor.name}
                </Link>
                {vendor.website ? <div className="text-xs text-zinc-500">{vendor.website}</div> : null}
              </td>
              <td className="py-2 pr-4 text-zinc-700">{VENDOR_TYPE_LABELS[vendor.vendor_type]}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-zinc-700">{vendor.branch_count}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-zinc-700">{vendor.preferred_count}</td>
              <td className="py-2 text-zinc-600">{excerpt(vendor.notes) || <span className="text-zinc-400">none</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

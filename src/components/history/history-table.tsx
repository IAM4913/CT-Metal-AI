// Purchase history results (AC-11.2, AC-11.3): one row per purchase line with
// the links back to the request, the RFQ that asked, and the reply that
// answered (its offer card, and the quote file when there is one). Server
// component, plain table.
//
// The Confirmed column shows the UTC calendar day of confirmed_at
// (confirmedDayText), the same day the date filter compares on, so a row
// always turns up when its shown date is searched. The RFQ link lands on the
// rfq-<id> anchor of src/components/rfqs/rfq-card.tsx, which the RFQs tab
// renders for every RFQ of the revision (RFQS_TAB_STATUSES); the Reply link
// lands on the offer-<id> anchor of src/components/offers/offer-card.tsx.

import Link from "next/link";
import type { LineUnit, PriceBasis } from "@/lib/db/enums";
import { confirmedDayText, rowItemText, type HistoryRow } from "@/lib/history/filter";

export const PRICE_BASIS_LABELS: Record<PriceBasis, string> = {
  per_cwt: "/cwt",
  per_lb: "/lb",
  per_ft: "/ft",
  per_pc: "/pc",
  per_ton: "/ton",
  per_sqft: "/sqft",
};

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const quantity = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

/** "$58.50 /cwt"; "unknown" when either half is missing (PRD section 8 rule 1). */
export function priceText(unitPrice: number | null, basis: PriceBasis | null): string {
  if (unitPrice === null) return "unknown";
  const amount = money.format(unitPrice);
  return basis === null ? `${amount} (no basis)` : `${amount} ${PRICE_BASIS_LABELS[basis]}`;
}

/** "12 pcs"; the bare number when the unit is unknown. */
export function qtyText(qty: number, unit: LineUnit | null): string {
  const amount = quantity.format(qty);
  return unit === null ? amount : `${amount} ${unit}`;
}

/** "4 lines from 3 purchases". */
export function summaryText(lineCount: number, purchaseCount: number): string {
  const lines = lineCount === 1 ? "1 line" : `${lineCount} lines`;
  const purchases = purchaseCount === 1 ? "1 purchase" : `${purchaseCount} purchases`;
  return `${lines} from ${purchases}`;
}

const linkClass = "font-medium text-zinc-900 underline hover:text-zinc-700";
const cellClass = "px-3 py-2 align-top";

export function HistoryTable({ rows }: { rows: HistoryRow[] }) {
  return (
    <div className="overflow-x-auto rounded border border-zinc-200">
      <table className="w-full min-w-[64rem] text-sm">
        <thead className="bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
          <tr>
            <th scope="col" className={cellClass}>
              Confirmed
            </th>
            <th scope="col" className={cellClass}>
              PO
            </th>
            <th scope="col" className={cellClass}>
              Customer
            </th>
            <th scope="col" className={cellClass}>
              Vendor
            </th>
            <th scope="col" className={cellClass}>
              Item
            </th>
            <th scope="col" className={`${cellClass} text-right`}>
              Qty
            </th>
            <th scope="col" className={`${cellClass} text-right`}>
              Unit price
            </th>
            <th scope="col" className={cellClass}>
              Offered as
            </th>
            <th scope="col" className={cellClass}>
              Open
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200">
          {rows.map((row, index) => {
            const item = rowItemText(row);
            const showDescription = row.designation !== null && row.line_description.trim() !== "" && row.line_description !== row.designation;
            const requestHref = `/requests/${row.request_id}`;
            return (
              <tr key={`${row.purchase_id}-${row.request_line_id}-${row.offer_id ?? "none"}-${index}`} className="bg-white">
                <td className={`${cellClass} whitespace-nowrap tabular-nums text-zinc-800`}>{confirmedDayText(row.confirmed_at)}</td>
                <td className={`${cellClass} whitespace-nowrap text-zinc-800`}>{row.po_number ?? <span className="text-zinc-400">none</span>}</td>
                <td className={`${cellClass} text-zinc-800`}>{row.customer_name ?? <span className="text-zinc-400">not linked</span>}</td>
                <td className={`${cellClass} text-zinc-800`}>
                  <div>{row.vendor_name}</div>
                  <div className="text-xs text-zinc-500">{row.branch_name}</div>
                </td>
                <td className={`${cellClass} text-zinc-900`}>
                  <div className={row.designation !== null ? "font-medium" : ""}>{item.trim() === "" ? <span className="text-zinc-400">no description</span> : item}</div>
                  {showDescription ? <div className="text-xs text-zinc-500">{row.line_description}</div> : null}
                  {row.designation === null ? <div className="text-xs text-zinc-500">custom item</div> : null}
                </td>
                <td className={`${cellClass} whitespace-nowrap text-right tabular-nums text-zinc-800`}>{qtyText(row.qty, row.unit)}</td>
                <td className={`${cellClass} whitespace-nowrap text-right tabular-nums ${row.unit_price === null ? "text-zinc-400" : "text-zinc-800"}`}>
                  {priceText(row.unit_price, row.price_basis)}
                </td>
                <td className={`${cellClass} text-zinc-800`}>{row.offered_desc.trim() === "" ? <span className="text-zinc-400">not recorded</span> : row.offered_desc}</td>
                <td className={`${cellClass} whitespace-nowrap`}>
                  <ul className="flex flex-col gap-0.5">
                    <li>
                      <Link href={requestHref} className={linkClass}>
                        Request
                      </Link>
                    </li>
                    <li>
                      {row.rfq_id !== null ? (
                        <Link href={`${requestHref}/rfqs#rfq-${row.rfq_id}`} className={linkClass}>
                          RFQ
                        </Link>
                      ) : (
                        <span className="text-zinc-400">RFQ</span>
                      )}
                    </li>
                    <li>
                      {row.offer_id !== null ? (
                        <Link href={`${requestHref}/offers#offer-${row.offer_id}`} className={linkClass}>
                          Reply
                        </Link>
                      ) : (
                        <span className="text-zinc-400">Reply</span>
                      )}
                    </li>
                    {row.attachment_id !== null ? (
                      <li>
                        <a href={`/attachments/${row.attachment_id}`} target="_blank" rel="noopener noreferrer" className={linkClass}>
                          Quote file
                        </a>
                      </li>
                    ) : null}
                  </ul>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

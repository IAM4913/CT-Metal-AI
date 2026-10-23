"use client";

// Enter lines by hand (AC-1.3). Client component only because rows are added and
// removed in place; the submit is still a plain form post to the manual server
// action. Fields are named lines[i][field] with i the row's current position,
// so the action can rebuild the array from FormData in order.

import { useState } from "react";
import { createManualAction } from "@/app/(app)/requests/new/actions";
import { lineUnitValues } from "@/lib/db/enums";

type CustomerOption = { id: string; name: string; short_name: string };

const INITIAL_ROWS = 3;

const inputClass =
  "w-full rounded border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500";

export function ManualLinesForm({ customers }: { customers: CustomerOption[] }) {
  // Row keys stay stable across removals so React keeps each row's typed values.
  const [rowKeys, setRowKeys] = useState<number[]>(() => Array.from({ length: INITIAL_ROWS }, (_, i) => i));
  const [nextKey, setNextKey] = useState(INITIAL_ROWS);

  function addRow() {
    setRowKeys((keys) => [...keys, nextKey]);
    setNextKey((key) => key + 1);
  }

  function removeRow(key: number) {
    setRowKeys((keys) => (keys.length > 1 ? keys.filter((k) => k !== key) : keys));
  }

  return (
    <section aria-labelledby="manual-heading" className="rounded border border-zinc-200 p-4">
      <h2 id="manual-heading" className="text-lg font-semibold">
        Enter lines by hand
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Phone call or walk-in. Leave a field blank when the customer did not say; it is flagged on review, never
        guessed.
      </p>

      <form action={createManualAction} className="mt-4 flex flex-col gap-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                <th scope="col" className="px-1 py-2 font-medium">
                  #
                </th>
                <th scope="col" className="px-1 py-2 font-medium">
                  Description
                </th>
                <th scope="col" className="px-1 py-2 font-medium">
                  Qty
                </th>
                <th scope="col" className="px-1 py-2 font-medium">
                  Unit
                </th>
                <th scope="col" className="px-1 py-2 font-medium">
                  Length
                </th>
                <th scope="col" className="px-1 py-2 font-medium">
                  Grade
                </th>
                <th scope="col" className="px-1 py-2 font-medium">
                  Notes
                </th>
                <th scope="col" className="px-1 py-2">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rowKeys.map((key, index) => (
                <tr key={key} className="border-b border-zinc-100 align-top">
                  <td className="px-1 py-2 text-zinc-500">{index + 1}</td>
                  <td className="px-1 py-2">
                    <input
                      type="text"
                      name={`lines[${index}][description]`}
                      aria-label={`Line ${index + 1} description`}
                      placeholder="8x8x5/8 HSS"
                      className={`${inputClass} min-w-[14rem]`}
                    />
                  </td>
                  <td className="px-1 py-2">
                    <input
                      type="number"
                      name={`lines[${index}][qty]`}
                      aria-label={`Line ${index + 1} quantity`}
                      inputMode="decimal"
                      min={0}
                      step="any"
                      className={`${inputClass} w-20`}
                    />
                  </td>
                  <td className="px-1 py-2">
                    <select
                      name={`lines[${index}][unit]`}
                      aria-label={`Line ${index + 1} unit`}
                      defaultValue=""
                      className={`${inputClass} w-20`}
                    >
                      <option value=""></option>
                      {lineUnitValues.map((unit) => (
                        <option key={unit} value={unit}>
                          {unit}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-1 py-2">
                    <input
                      type="text"
                      name={`lines[${index}][length_text]`}
                      aria-label={`Line ${index + 1} length`}
                      placeholder="40'"
                      className={`${inputClass} w-24`}
                    />
                  </td>
                  <td className="px-1 py-2">
                    <input
                      type="text"
                      name={`lines[${index}][grade_spec]`}
                      aria-label={`Line ${index + 1} grade`}
                      placeholder="A500 Gr B"
                      className={`${inputClass} w-28`}
                    />
                  </td>
                  <td className="px-1 py-2">
                    <input
                      type="text"
                      name={`lines[${index}][notes]`}
                      aria-label={`Line ${index + 1} notes`}
                      placeholder="deliver Fort Worth"
                      className={`${inputClass} min-w-[10rem]`}
                    />
                  </td>
                  <td className="px-1 py-2">
                    <button
                      type="button"
                      onClick={() => removeRow(key)}
                      disabled={rowKeys.length === 1}
                      aria-label={`Remove line ${index + 1}`}
                      className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <button
            type="button"
            onClick={addRow}
            className="rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100"
          >
            Add row
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">
              Subject <span className="font-normal text-zinc-500">(optional)</span>
            </span>
            <input type="text" name="subject" maxLength={200} className={inputClass} />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-800">
              Customer <span className="font-normal text-zinc-500">(optional)</span>
            </span>
            <select name="customerId" defaultValue="" className={inputClass}>
              <option value="">No customer</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.short_name ? `${customer.name} (${customer.short_name})` : customer.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <button
            type="submit"
            className="rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Create request from lines
          </button>
        </div>
      </form>
    </section>
  );
}

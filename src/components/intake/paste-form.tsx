// Paste a material list (AC-1.1). Server component: a plain form posting to the
// paste server action; nothing here needs client-side state.

import { createPasteAction } from "@/app/(app)/requests/new/actions";

export type CustomerOption = { id: string; name: string; short_name: string };

const inputClass =
  "rounded border border-zinc-300 px-3 py-2 text-base text-zinc-900 outline-none focus:border-zinc-500";

export function PasteForm({ customers }: { customers: CustomerOption[] }) {
  return (
    <section aria-labelledby="paste-heading" className="rounded border border-zinc-200 p-4">
      <h2 id="paste-heading" className="text-lg font-semibold">
        Paste a list
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Email body, text message, whatever the customer sent. Shop language is fine.
      </p>

      <form action={createPasteAction} className="mt-4 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800">Material list</span>
          <textarea
            name="text"
            required
            rows={10}
            spellCheck={false}
            placeholder={"100 pcs 8x8x5/8 HSS, 40' lengths, A500 Gr B\n6 pcs 12 inch channel 30# at 40 ft"}
            className={`${inputClass} font-mono text-sm`}
          />
        </label>

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
            Create request from paste
          </button>
        </div>
      </form>
    </section>
  );
}

// Vendor directory (PRD FR-5, section 9: /vendors). Every vendor with its
// branch counts, and a form to add one. The seeded vendors are examples from
// the discovery call (AC-5.2) and the page says so.

import { VendorFlash } from "@/components/vendors/vendor-flash";
import { VendorForm } from "@/components/vendors/vendor-form";
import { VendorTable } from "@/components/vendors/vendor-table";
import { requireBroker } from "@/lib/server/session";
import { listVendors } from "@/lib/server/vendors";

type VendorsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function VendorsPage({ searchParams }: VendorsPageProps) {
  const session = await requireBroker();
  const [params, vendors] = await Promise.all([searchParams, listVendors(session)]);

  return (
    <main className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Vendors</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Companies you buy from, with their branches, contacts, capabilities, and terms. The seeded vendors are
          examples: correct them to match your real reps. Open a vendor to edit its branches.
        </p>
      </div>

      <VendorFlash params={params} />

      <section aria-labelledby="vendor-list-heading" className="flex flex-col gap-3">
        <h2 id="vendor-list-heading" className="text-lg font-semibold">
          {vendors.length} vendor{vendors.length === 1 ? "" : "s"}
        </h2>
        <VendorTable vendors={vendors} />
      </section>

      <section aria-labelledby="new-vendor-heading" className="rounded border border-zinc-200 p-4">
        <h2 id="new-vendor-heading" className="text-lg font-semibold">
          New vendor
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Add the company first; branches, contacts, and capabilities are added on the next screen.
        </p>
        <div className="mt-4">
          <VendorForm />
        </div>
      </section>
    </main>
  );
}

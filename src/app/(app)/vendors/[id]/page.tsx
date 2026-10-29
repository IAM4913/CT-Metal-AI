// One vendor (PRD FR-5, section 9: /vendors/[id]): the company fields, each
// branch with its terms, capabilities, and contacts, and a form to add a
// branch. Everything is a plain form posting to ./actions.ts; the result of
// the last post comes back in the URL and is shown by VendorFlash.

import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteVendorAction } from "@/app/(app)/vendors/actions";
import { BranchForm } from "@/components/vendors/branch-form";
import { BranchSection } from "@/components/vendors/branch-section";
import { ConfirmButton } from "@/components/vendors/confirm-button";
import { DANGER_BUTTON_CLASS } from "@/components/vendors/fields";
import { VENDOR_TYPE_LABELS } from "@/components/vendors/labels";
import { VendorFlash } from "@/components/vendors/vendor-flash";
import { VendorForm } from "@/components/vendors/vendor-form";
import { requireBroker } from "@/lib/server/session";
import { getVendorDetail } from "@/lib/server/vendors";

type VendorPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function VendorPage({ params, searchParams }: VendorPageProps) {
  const session = await requireBroker();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const detail = await getVendorDetail(session, id);
  if (!detail) notFound();

  const { vendor, branches, history_count: historyCount } = detail;
  const inUse = historyCount > 0;

  return (
    <main className="flex flex-col gap-8">
      <nav aria-label="Breadcrumb" className="text-sm text-zinc-600">
        <Link href="/vendors" className="underline hover:text-zinc-900">
          Vendors
        </Link>
        <span className="mx-2">/</span>
        <span className="text-zinc-900">{vendor.name}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{vendor.name}</h1>
          <p className="mt-1 text-sm text-zinc-600">
            {VENDOR_TYPE_LABELS[vendor.vendor_type]}
            {vendor.website ? (
              <>
                <span className="mx-2">/</span>
                <a href={externalHref(vendor.website)} rel="noreferrer" target="_blank" className="underline">
                  {vendor.website}
                </a>
              </>
            ) : null}
            <span className="mx-2">/</span>
            {branches.length} branch{branches.length === 1 ? "" : "es"}
          </p>
        </div>
        <form action={deleteVendorAction} className="flex flex-col items-end gap-1">
          <input type="hidden" name="vendor_id" value={vendor.id} />
          <ConfirmButton
            message={`Delete ${vendor.name} with all of its branches and contacts? This cannot be undone.`}
            className={DANGER_BUTTON_CLASS}
            disabled={inUse}
            title={inUse ? "Vendors with RFQ or purchase history cannot be deleted." : undefined}
          >
            Delete vendor
          </ConfirmButton>
          {inUse ? (
            <span className="text-xs text-zinc-500">
              Has {historyCount} RFQ{historyCount === 1 ? "" : "s"} or purchase{historyCount === 1 ? "" : "s"} on file,
              cannot be deleted.
            </span>
          ) : null}
        </form>
      </header>

      <VendorFlash params={query} />

      <section aria-labelledby="vendor-fields-heading" className="rounded border border-zinc-200 p-4">
        <h2 id="vendor-fields-heading" className="text-lg font-semibold">
          Company
        </h2>
        <div className="mt-4">
          <VendorForm vendor={vendor} />
        </div>
      </section>

      <section aria-labelledby="branches-heading" className="flex flex-col gap-4">
        <h2 id="branches-heading" className="text-lg font-semibold">
          Branches
        </h2>
        {branches.length === 0 ? (
          <p className="text-sm text-zinc-600">
            No branches yet. RFQs go to branches, so add at least one with a contact and its capabilities.
          </p>
        ) : (
          branches.map((branch) => <BranchSection key={branch.id} vendorId={vendor.id} branch={branch} />)
        )}
      </section>

      <section id="add-branch" aria-labelledby="add-branch-heading" className="rounded border border-zinc-200 p-4">
        <h2 id="add-branch-heading" className="text-lg font-semibold">
          Add branch
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          A location that receives RFQs. Leave a term blank when you do not know it; the comparison shows it as
          unknown rather than guessing.
        </p>
        <div className="mt-4">
          <BranchForm vendorId={vendor.id} />
        </div>
      </section>
    </main>
  );
}

/** A stored website with no scheme still opens as an external link rather than a relative path. */
function externalHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

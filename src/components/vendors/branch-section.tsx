// One branch on the vendor detail page: a summary header, the terms edit form
// (collapsed), the capability grid, the contacts with an edit form each and an
// add form, and the delete button. The section carries id="branch-<id>" so the
// actions can redirect back to the branch that was just saved.

import { deleteBranchAction, deleteContactAction } from "@/app/(app)/vendors/actions";
import type { BranchDetail, ContactRow } from "@/lib/server/vendors";
import { BranchForm } from "./branch-form";
import { CapabilityGrid } from "./capability-grid";
import { ConfirmButton } from "./confirm-button";
import { ContactForm } from "./contact-form";
import { DANGER_BUTTON_CLASS } from "./fields";
import { CATEGORY_LABELS, FREIGHT_DEFAULT_LABELS } from "./labels";

type BranchSectionProps = {
  vendorId: string;
  branch: BranchDetail;
};

export function BranchSection({ vendorId, branch }: BranchSectionProps) {
  const headingId = `branch-${branch.id}-heading`;
  const inUse = branch.history_count > 0;

  return (
    <section
      id={`branch-${branch.id}`}
      aria-labelledby={headingId}
      className="flex flex-col gap-6 rounded border border-zinc-200 p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={headingId} className="text-lg font-semibold text-zinc-900">
            {branch.name}
            {branch.preferred ? (
              <span className="ml-2 inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
                Preferred
              </span>
            ) : null}
          </h3>
          <p className="mt-1 text-sm text-zinc-600">
            {branch.city}, {branch.state}
            {branch.region ? ` (${branch.region})` : ""}
          </p>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-700">
            <div>
              <dt className="inline text-zinc-500">Terms: </dt>
              <dd className="inline">{branch.payment_terms ?? <span className="text-zinc-400">unknown</span>}</dd>
            </div>
            <div>
              <dt className="inline text-zinc-500">Early pay: </dt>
              <dd className="inline">{earlyPayText(branch)}</dd>
            </div>
            <div>
              <dt className="inline text-zinc-500">Freight: </dt>
              <dd className="inline">{FREIGHT_DEFAULT_LABELS[branch.freight_default]}</dd>
            </div>
            <div>
              <dt className="inline text-zinc-500">History: </dt>
              <dd className="inline">
                {branch.history_count === 0 ? "none" : `${branch.history_count} RFQ${branch.history_count === 1 ? "" : "s"} or purchase${branch.history_count === 1 ? "" : "s"}`}
              </dd>
            </div>
          </dl>
          {branch.notes ? <p className="mt-2 whitespace-pre-line text-sm text-zinc-700">{branch.notes}</p> : null}
        </div>

        <form action={deleteBranchAction} className="flex flex-col items-end gap-1">
          <input type="hidden" name="vendor_id" value={vendorId} />
          <input type="hidden" name="branch_id" value={branch.id} />
          <ConfirmButton
            message={`Delete the ${branch.name} branch and its contacts and capabilities? This cannot be undone.`}
            className={DANGER_BUTTON_CLASS}
            disabled={inUse}
            title={inUse ? "Branches with RFQ or purchase history cannot be deleted." : undefined}
          >
            Delete branch
          </ConfirmButton>
          {inUse ? <span className="text-xs text-zinc-500">Has history, cannot be deleted.</span> : null}
        </form>
      </header>

      <details className="rounded border border-zinc-100 bg-zinc-50 p-3">
        <summary className="cursor-pointer text-sm font-medium text-zinc-800">Edit location, terms, and notes</summary>
        <div className="mt-4">
          <BranchForm vendorId={vendorId} branch={branch} />
        </div>
      </details>

      <div>
        <h4 className="text-sm font-semibold text-zinc-900">Capabilities</h4>
        {branch.capabilities.length > 0 ? (
          <p className="mt-1 text-sm text-zinc-700">
            {branch.capabilities.map((category) => CATEGORY_LABELS[category]).join(", ")}
          </p>
        ) : null}
        <div className="mt-3">
          <CapabilityGrid vendorId={vendorId} branchId={branch.id} selected={branch.capabilities} />
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-zinc-900">Contacts</h4>
        {branch.contacts.length === 0 ? (
          <p className="mt-1 text-sm text-amber-700">
            No contacts. An RFQ to this branch has nobody to go to until one is added.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {branch.contacts.map((contact) => (
              <ContactItem key={contact.id} vendorId={vendorId} branchId={branch.id} contact={contact} />
            ))}
          </ul>
        )}
        <details className="mt-3 rounded border border-zinc-100 bg-zinc-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-zinc-800">Add contact</summary>
          <div className="mt-4">
            <ContactForm vendorId={vendorId} branchId={branch.id} />
          </div>
        </details>
      </div>
    </section>
  );
}

function ContactItem({ vendorId, branchId, contact }: { vendorId: string; branchId: string; contact: ContactRow }) {
  return (
    <li className="rounded border border-zinc-200 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="text-sm">
          <div className="font-medium text-zinc-900">
            {contact.name}
            {contact.is_primary ? (
              <span className="ml-2 inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-800">
                Primary
              </span>
            ) : null}
          </div>
          <div className="text-zinc-700">
            {contact.email}
            {contact.phone ? <span className="text-zinc-500"> / {contact.phone}</span> : null}
          </div>
          {contact.notes ? <p className="mt-1 whitespace-pre-line text-zinc-600">{contact.notes}</p> : null}
        </div>
        <form action={deleteContactAction}>
          <input type="hidden" name="vendor_id" value={vendorId} />
          <input type="hidden" name="branch_id" value={branchId} />
          <input type="hidden" name="contact_id" value={contact.id} />
          <ConfirmButton message={`Delete contact ${contact.name}?`} className={DANGER_BUTTON_CLASS}>
            Delete
          </ConfirmButton>
        </form>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-zinc-600">Edit contact</summary>
        <div className="mt-3">
          <ContactForm vendorId={vendorId} branchId={branchId} contact={contact} />
        </div>
      </details>
    </li>
  );
}

/** "2% in 10 days", "2% (days unknown)", "10 days (percent unknown)", or "none on file". */
function earlyPayText(branch: BranchDetail): string {
  const { early_pay_pct: pct, early_pay_days: days } = branch;
  if (pct === null && days === null) return "none on file";
  if (pct !== null && days !== null) return `${pct}% in ${days} days`;
  if (pct !== null) return `${pct}% (days unknown)`;
  return `${days} days (percent unknown)`;
}

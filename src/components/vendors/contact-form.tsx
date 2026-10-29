// Create or edit a contact at a branch. The primary contact is who an RFQ is
// addressed to (routing.ts), so the form says so; the lib keeps one primary
// per branch by clearing the flag on the others when a new one is set.

import { createContactAction, updateContactAction } from "@/app/(app)/vendors/actions";
import type { ContactRow } from "@/lib/server/vendors";
import { CheckboxField, FormActions, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS, TextAreaField, TextField } from "./fields";

type ContactFormProps = {
  vendorId: string;
  branchId: string;
  contact?: ContactRow;
};

export function ContactForm({ vendorId, branchId, contact }: ContactFormProps) {
  return (
    <form action={contact ? updateContactAction : createContactAction} className="flex flex-col gap-3">
      <input type="hidden" name="vendor_id" value={vendorId} />
      <input type="hidden" name="branch_id" value={branchId} />
      {contact ? <input type="hidden" name="contact_id" value={contact.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label="Name" name="name" defaultValue={contact?.name} required />
        <TextField label="Email" name="email" type="email" defaultValue={contact?.email} required />
        <TextField label="Phone" name="phone" type="tel" defaultValue={contact?.phone} />
      </div>
      <CheckboxField
        label="Primary contact"
        name="is_primary"
        defaultChecked={contact?.is_primary ?? false}
        hint="RFQs for this branch are addressed to the primary contact."
      />
      <TextAreaField label="Contact notes" name="notes" defaultValue={contact?.notes} rows={2} />
      <FormActions>
        <button type="submit" className={contact ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS}>
          {contact ? "Save contact" : "Add contact"}
        </button>
      </FormActions>
    </form>
  );
}

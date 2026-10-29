// Create or edit a vendor (company). With a vendor the form carries its id as
// a hidden field and posts to the update action; without one it posts to the
// create action.

import { createVendorAction, updateVendorAction } from "@/app/(app)/vendors/actions";
import type { VendorRow } from "@/lib/server/vendors";
import { FormActions, PRIMARY_BUTTON_CLASS, SelectField, TextAreaField, TextField } from "./fields";
import { VENDOR_TYPE_OPTIONS } from "./labels";

export function VendorForm({ vendor }: { vendor?: VendorRow }) {
  return (
    <form action={vendor ? updateVendorAction : createVendorAction} className="flex flex-col gap-4">
      {vendor ? <input type="hidden" name="vendor_id" value={vendor.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" name="name" defaultValue={vendor?.name} required />
        <SelectField
          label="Type"
          name="vendor_type"
          options={VENDOR_TYPE_OPTIONS}
          defaultValue={vendor?.vendor_type ?? "service_center"}
          required
        />
        <TextField
          label="Website"
          name="website"
          type="text"
          defaultValue={vendor?.website}
          placeholder="https://"
          className="sm:col-span-2"
        />
        <TextAreaField
          label="Notes"
          name="notes"
          defaultValue={vendor?.notes}
          hint="Relationship notes about the company. Branch and contact notes live on each branch below."
          className="sm:col-span-2"
        />
      </div>
      <FormActions>
        <button type="submit" className={PRIMARY_BUTTON_CLASS}>
          {vendor ? "Save vendor" : "Create vendor"}
        </button>
      </FormActions>
    </form>
  );
}

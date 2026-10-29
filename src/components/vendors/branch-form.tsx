// Create or edit a vendor branch: location, preferred flag, terms (payment
// terms, early-pay percent and days, freight default), and notes. Every
// optional field left blank is stored as null, never a default (CLAUDE.md:
// missing data is null plus a flag), so the terms shown later are what the
// broker actually knows.

import { createBranchAction, updateBranchAction } from "@/app/(app)/vendors/actions";
import type { BranchRow } from "@/lib/server/vendors";
import { CheckboxField, FormActions, PRIMARY_BUTTON_CLASS, SelectField, TextAreaField, TextField } from "./fields";
import { FREIGHT_DEFAULT_OPTIONS } from "./labels";

type BranchFormProps = {
  vendorId: string;
  branch?: BranchRow;
};

export function BranchForm({ vendorId, branch }: BranchFormProps) {
  return (
    <form action={branch ? updateBranchAction : createBranchAction} className="flex flex-col gap-4">
      <input type="hidden" name="vendor_id" value={vendorId} />
      {branch ? <input type="hidden" name="branch_id" value={branch.id} /> : null}

      <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-sm font-semibold text-zinc-900">Location</legend>
        <TextField label="Branch name" name="name" defaultValue={branch?.name} required placeholder="Houston" />
        <TextField label="City" name="city" defaultValue={branch?.city} required />
        <TextField label="State" name="state" defaultValue={branch?.state} required placeholder="TX" />
        <TextField label="Region" name="region" defaultValue={branch?.region} placeholder="Gulf Coast" />
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-sm font-semibold text-zinc-900">Terms</legend>
        <TextField
          label="Payment terms"
          name="payment_terms"
          defaultValue={branch?.payment_terms}
          placeholder="Net 30"
        />
        <TextField
          label="Early-pay discount %"
          name="early_pay_pct"
          type="number"
          step="any"
          min={0}
          max={100}
          defaultValue={branch?.early_pay_pct}
          hint="Whole percent: 2 means 2%. Leave blank when unknown."
        />
        <TextField
          label="Early-pay days"
          name="early_pay_days"
          type="number"
          step="1"
          min={0}
          max={365}
          defaultValue={branch?.early_pay_days}
          hint="Days from invoice to earn the discount."
        />
        <SelectField
          label="Freight default"
          name="freight_default"
          options={FREIGHT_DEFAULT_OPTIONS}
          defaultValue={branch?.freight_default ?? "unknown"}
          required
        />
      </fieldset>

      <CheckboxField
        label="Preferred branch"
        name="preferred"
        defaultChecked={branch?.preferred ?? false}
        hint="Preferred branches rank first in vendor matching (AC-6.1)."
      />

      <TextAreaField
        label="Branch notes"
        name="notes"
        defaultValue={branch?.notes}
        hint="Relationship notes: who answers fast, what they stock, when to call."
      />

      <FormActions>
        <button type="submit" className={PRIMARY_BUTTON_CLASS}>
          {branch ? "Save branch" : "Add branch"}
        </button>
      </FormActions>
    </form>
  );
}

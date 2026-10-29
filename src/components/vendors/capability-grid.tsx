// The categories a branch can supply, as a checkbox grid over every
// material_category value. Posting the form replaces the branch's capability
// set with the ticked boxes (setCapabilities diffs against what is stored).

import { setCapabilitiesAction } from "@/app/(app)/vendors/actions";
import type { MaterialCategory } from "@/lib/db/enums";
import { FormActions, SECONDARY_BUTTON_CLASS } from "./fields";
import { CATEGORY_OPTIONS } from "./labels";

type CapabilityGridProps = {
  vendorId: string;
  branchId: string;
  selected: readonly MaterialCategory[];
};

export function CapabilityGrid({ vendorId, branchId, selected }: CapabilityGridProps) {
  const checked = new Set(selected);
  return (
    <form action={setCapabilitiesAction} className="flex flex-col gap-3">
      <input type="hidden" name="vendor_id" value={vendorId} />
      <input type="hidden" name="branch_id" value={branchId} />
      <fieldset>
        <legend className="mb-2 text-sm text-zinc-600">
          Tick every category this branch sells. Vendor matching suggests the branch for lines in these categories.
        </legend>
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {CATEGORY_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm text-zinc-800">
              <input
                type="checkbox"
                name="categories"
                value={option.value}
                defaultChecked={checked.has(option.value)}
                className="h-4 w-4 rounded border-zinc-300"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      <FormActions>
        <button type="submit" className={SECONDARY_BUTTON_CLASS}>
          Save capabilities
        </button>
        <span className="text-xs text-zinc-500">
          {selected.length === 0 ? "No capabilities yet: this branch is never suggested." : `${selected.length} selected`}
        </span>
      </FormActions>
    </form>
  );
}

// Create or edit a catalog item. With an item the form carries its id as a
// hidden field and posts to the update action; without one it posts to the
// create action. The dims field is a small JSON textarea; the hint shows the
// key convention the seeded catalog uses so a hand-added item matches it.

import { createItemAction, updateItemAction } from "@/app/(app)/items/actions";
import { FormActions, PRIMARY_BUTTON_CLASS, SelectField, TextAreaField, TextField } from "@/components/vendors/fields";
import { CATEGORY_OPTIONS } from "@/components/vendors/labels";
import { dimsToText, type ItemRow } from "@/lib/server/items";

export function ItemForm({ item }: { item?: ItemRow }) {
  return (
    <form action={item ? updateItemAction : createItemAction} className="flex flex-col gap-4">
      {item ? <input type="hidden" name="item_id" value={item.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Category"
          name="category"
          options={CATEGORY_OPTIONS}
          defaultValue={item?.category ?? null}
          blankLabel={item ? undefined : "Pick a category"}
          required
        />
        <TextField
          label="Designation"
          name="designation"
          defaultValue={item?.designation}
          required
          placeholder="HSS8x8x5/8, C12x30, L2x2x1/4, PL3/8"
          hint="The canonical name as it appears in RFQs. Spaces are removed. Must be unique across the catalog."
        />
        <TextField
          label="Weight per foot (lb)"
          name="weight_per_ft"
          type="number"
          step="any"
          defaultValue={item?.weight_per_ft}
          placeholder="59.32"
          hint="Leave blank when unknown; the comparison then cannot convert a per-cwt price for this item and says so."
        />
        <TextField
          label="Default grade"
          name="default_grade"
          defaultValue={item?.default_grade}
          placeholder="A500 Gr B, A36, A992, A53 Gr B"
          hint="Shown when a request names no grade. Leave blank when there is no usual one."
        />
        <TextAreaField
          label="Dims (JSON)"
          name="dims"
          defaultValue={item ? dimsToText(item.dims) : ""}
          rows={3}
          className="sm:col-span-2"
          hint={
            'A flat object of numbers (inches) or strings. Seed conventions: HSS and angles {"a": 8, "b": 8, "t": 0.625}; round HSS {"od": 8.625, "nominal": 8, "t": 0.375}; pipe {"nps": 2, "od": 2.375, "t": 0.154, "schedule": "STD"}; flat bar {"t": 0.25, "w": 2}; round bar {"d": 1}; square bar {"a": 1}; plate {"t": 0.375, "weight_per_sqft": 15.3}; rebar {"bar_number": 4, "d": 0.5}. Leave blank for none.'
          }
        />
      </div>
      <FormActions>
        <button type="submit" className={PRIMARY_BUTTON_CLASS}>
          {item ? "Save item" : "Create item"}
        </button>
      </FormActions>
    </form>
  );
}

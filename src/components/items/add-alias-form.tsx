// Add a learned alias to an item (AC-4.4). The typed phrase is normalized on
// the server before it is stored, and the saved form is what the alias list
// then shows, so the broker sees exactly what a request line will match.

import { addAliasAction } from "@/app/(app)/items/actions";
import { FormActions, PRIMARY_BUTTON_CLASS, TextField } from "@/components/vendors/fields";

export function AddAliasForm({ itemId }: { itemId: string }) {
  return (
    <form action={addAliasAction} className="flex flex-col gap-4">
      <input type="hidden" name="item_id" value={itemId} />
      <TextField
        label="Alias"
        name="alias"
        required
        placeholder='8" sq tube 5/8 wall'
        hint='Write it the way a shop would. It is stored normalized: 8" sq tube 5/8 wall becomes 8 sq hss 5/8 wall. Case, inch marks, and extra spaces do not matter.'
      />
      <FormActions>
        <button type="submit" className={PRIMARY_BUTTON_CLASS}>
          Add alias
        </button>
      </FormActions>
    </form>
  );
}

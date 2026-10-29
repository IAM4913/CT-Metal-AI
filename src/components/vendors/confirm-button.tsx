"use client";

// A submit button that asks before the form posts. The only client code in the
// vendor admin: deleting a vendor, branch, or contact is one click otherwise,
// and the browser's confirm dialog is enough for a single-user back office.
// Without JavaScript the button still submits; the server guards still hold.

import type { ReactNode } from "react";

type ConfirmButtonProps = {
  message: string;
  className: string;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
};

export function ConfirmButton({ message, className, disabled, title, children }: ConfirmButtonProps) {
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled}
      title={title}
      onClick={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      {children}
    </button>
  );
}

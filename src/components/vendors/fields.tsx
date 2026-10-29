// Plain form controls for the vendor admin forms. Server components: no state,
// no handlers. Each one is a label wrapping its input, so the whole form
// stays usable without JavaScript.

import type { ReactNode } from "react";

export const INPUT_CLASS =
  "rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none";
export const PRIMARY_BUTTON_CLASS =
  "rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400";
export const SECONDARY_BUTTON_CLASS =
  "rounded border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100";
export const DANGER_BUTTON_CLASS =
  "rounded border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-400 disabled:hover:bg-transparent";

type TextFieldProps = {
  label: string;
  name: string;
  defaultValue?: string | number | null;
  required?: boolean;
  type?: "text" | "email" | "tel" | "url" | "number";
  placeholder?: string;
  hint?: string;
  /** Number inputs: the step attribute ("any" for decimals). */
  step?: string;
  min?: number;
  max?: number;
  className?: string;
};

export function TextField({
  label,
  name,
  defaultValue,
  required,
  type = "text",
  placeholder,
  hint,
  step,
  min,
  max,
  className,
}: TextFieldProps) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${className ?? ""}`}>
      <span className="font-medium text-zinc-800">
        {label}
        {required ? <span className="text-zinc-500"> *</span> : null}
      </span>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue ?? ""}
        required={required}
        placeholder={placeholder}
        step={step}
        min={min}
        max={max}
        className={INPUT_CLASS}
      />
      {hint ? <span className="text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

type TextAreaFieldProps = {
  label: string;
  name: string;
  defaultValue?: string | null;
  rows?: number;
  hint?: string;
  className?: string;
};

export function TextAreaField({ label, name, defaultValue, rows = 3, hint, className }: TextAreaFieldProps) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${className ?? ""}`}>
      <span className="font-medium text-zinc-800">{label}</span>
      <textarea name={name} defaultValue={defaultValue ?? ""} rows={rows} className={INPUT_CLASS} />
      {hint ? <span className="text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

type SelectFieldProps<V extends string> = {
  label: string;
  name: string;
  options: readonly { value: V; label: string }[];
  defaultValue?: V | null;
  required?: boolean;
  /** Shown as the first option with an empty value when set. */
  blankLabel?: string;
  className?: string;
};

export function SelectField<V extends string>({
  label,
  name,
  options,
  defaultValue,
  required,
  blankLabel,
  className,
}: SelectFieldProps<V>) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${className ?? ""}`}>
      <span className="font-medium text-zinc-800">
        {label}
        {required ? <span className="text-zinc-500"> *</span> : null}
      </span>
      <select name={name} defaultValue={defaultValue ?? ""} required={required} className={INPUT_CLASS}>
        {blankLabel !== undefined ? <option value="">{blankLabel}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

type CheckboxFieldProps = {
  label: string;
  name: string;
  value?: string;
  defaultChecked?: boolean;
  hint?: string;
};

export function CheckboxField({ label, name, value = "on", defaultChecked, hint }: CheckboxFieldProps) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="mt-0.5 h-4 w-4 rounded border-zinc-300"
      />
      <span className="flex flex-col">
        <span className="font-medium text-zinc-800">{label}</span>
        {hint ? <span className="text-xs text-zinc-500">{hint}</span> : null}
      </span>
    </label>
  );
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

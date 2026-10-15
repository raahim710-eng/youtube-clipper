import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** Labelled input with helper text and inline errors (UI_UX.md §6 "Forms"). */
export function FormField({
  id,
  label,
  description,
  errors,
  ...inputProps
}: {
  id: string;
  label: string;
  description?: string;
  errors?: string[];
} & Omit<React.ComponentProps<typeof Input>, "id">) {
  const invalid = Boolean(errors?.length);
  const describedBy = [description ? `${id}-description` : null, invalid ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name={id}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy || undefined}
        {...inputProps}
      />
      {description ? <FieldDescription id={`${id}-description`}>{description}</FieldDescription> : null}
      {invalid ? <FieldError id={`${id}-error`} errors={errors?.map((message) => ({ message }))} /> : null}
    </Field>
  );
}

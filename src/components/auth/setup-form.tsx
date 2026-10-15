"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormField } from "@/components/auth/form-field";
import { ErrorState } from "@/components/states/error-state";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { authClient, authErrorMessage } from "@/lib/auth-client";
import { fieldErrorsFrom, PASSWORD_MIN_LENGTH, setupSchema } from "@/lib/validation/auth";

/** First-run owner account form (FND-01). */
export function SetupForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const form = new FormData(event.currentTarget);
    const parsed = setupSchema.safeParse({
      name: form.get("name"),
      email: form.get("email"),
      password: form.get("password"),
      confirmPassword: form.get("confirmPassword"),
    });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setFieldErrors({});
    setPending(true);
    const { name, email, password } = parsed.data;
    const { error } = await authClient.signUp.email({ name, email, password });
    if (error) {
      setPending(false);
      setFormError(authErrorMessage(error, "Couldn't create the account. Please try again."));
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {formError ? <ErrorState title="Account not created" description={formError} /> : null}
      <FieldGroup>
        <FormField id="name" label="Your name" autoComplete="name" required autoFocus errors={fieldErrors.name} />
        <FormField id="email" label="Email" type="email" autoComplete="email" required errors={fieldErrors.email} />
        <FormField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          description={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`}
          errors={fieldErrors.password}
        />
        <FormField
          id="confirmPassword"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          required
          errors={fieldErrors.confirmPassword}
        />
      </FieldGroup>
      <Button type="submit" className="w-full" size="lg" disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        {pending ? "Creating account…" : "Create owner account"}
      </Button>
    </form>
  );
}

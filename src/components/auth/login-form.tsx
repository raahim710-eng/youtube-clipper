"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormField } from "@/components/auth/form-field";
import { ErrorState } from "@/components/states/error-state";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { authClient, authErrorMessage } from "@/lib/auth-client";
import { fieldErrorsFrom, loginSchema } from "@/lib/validation/auth";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const form = new FormData(event.currentTarget);
    const parsed = loginSchema.safeParse({ email: form.get("email"), password: form.get("password") });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setFieldErrors({});
    setPending(true);
    const { error } = await authClient.signIn.email(parsed.data);
    if (error) {
      setPending(false);
      // Same message for unknown email and wrong password, so accounts can't be probed.
      setFormError(
        error.status === 429 || error.status === 503 ? authErrorMessage(error, "") : "Email or password is incorrect.",
      );
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {formError ? <ErrorState title="Couldn't sign in" description={formError} /> : null}
      <FieldGroup>
        <FormField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          errors={fieldErrors.email}
        />
        <FormField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          errors={fieldErrors.password}
        />
      </FieldGroup>
      <Button type="submit" className="w-full" size="lg" disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Forgot your password? Run <code className="font-mono">npm run auth:reset-password</code> in the project folder.
      </p>
    </form>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/auth/form-field";
import { ErrorState } from "@/components/states/error-state";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { authClient, authErrorMessage } from "@/lib/auth-client";
import { changePasswordSchema, fieldErrorsFrom, PASSWORD_MIN_LENGTH } from "@/lib/validation/auth";

export function ChangePasswordForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const form = new FormData(event.currentTarget);
    const parsed = changePasswordSchema.safeParse({
      currentPassword: form.get("currentPassword"),
      newPassword: form.get("newPassword"),
      confirmPassword: form.get("confirmPassword"),
    });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setFieldErrors({});
    setPending(true);
    const { error } = await authClient.changePassword({
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (error) {
      setFormError(
        error.status === 400 || error.status === 401
          ? authErrorMessage(error, "Your current password is incorrect.")
          : authErrorMessage(error, "Couldn't change your password. Please try again."),
      );
      return;
    }
    formRef.current?.reset();
    toast.success("Password changed. Other sessions were signed out.");
    router.refresh();
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate className="max-w-md space-y-6">
      {formError ? <ErrorState title="Password not changed" description={formError} /> : null}
      <FieldGroup>
        <FormField
          id="currentPassword"
          label="Current password"
          type="password"
          autoComplete="current-password"
          errors={fieldErrors.currentPassword}
        />
        <FormField
          id="newPassword"
          label="New password"
          type="password"
          autoComplete="new-password"
          description={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          errors={fieldErrors.newPassword}
        />
        <FormField
          id="confirmPassword"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          errors={fieldErrors.confirmPassword}
        />
      </FieldGroup>
      <Button type="submit" disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        {pending ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}

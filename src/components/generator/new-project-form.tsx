"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createProjectAction } from "@/app/(app)/generator/actions";
import { BriefForm, NEW_PROJECT_SETTINGS } from "./brief-form";

/** "New video": saves the brief and starts writing the script (GEN-01). */
export function NewProjectForm({ voices }: { voices: string[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <BriefForm
        initial={NEW_PROJECT_SETTINGS}
        voices={voices}
        submitLabel="Create and write the script"
        busy={pending}
        onSubmit={(settings) =>
          startTransition(async () => {
            setError(null);
            const result = await createProjectAction(settings);
            if (result && !result.ok) {
              setError(result.error);
              toast.error(result.error);
            }
          })
        }
      />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

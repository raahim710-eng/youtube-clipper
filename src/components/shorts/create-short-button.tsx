"use client";

import { Smartphone } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { createShortAction } from "@/app/(app)/shorts/actions";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** Turns a clip into a Short and opens the editor (SHORT-01). */
export function CreateShortButton({
  clipId,
  label = "Create Short",
  size = "sm",
  variant = "default",
}: {
  clipId: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "default" | "outline";
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await createShortAction(clipId);
          if (result && !result.ok) toast.error(result.error);
        })
      }
    >
      {pending ? <Spinner data-icon="inline-start" /> : <Smartphone data-icon="inline-start" />}
      {label}
    </Button>
  );
}

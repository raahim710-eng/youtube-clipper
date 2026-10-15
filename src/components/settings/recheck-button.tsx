"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { recheckSystemStatusAction } from "@/app/(app)/settings/actions";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function RecheckButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function recheck() {
    startTransition(async () => {
      const result = await recheckSystemStatusAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={recheck} disabled={pending}>
      {pending ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
      {pending ? "Checking…" : "Check again"}
    </Button>
  );
}

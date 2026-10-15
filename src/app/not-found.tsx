import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <EmptyState
        icon={FileQuestion}
        title="Page not found"
        description="This page doesn't exist or was moved."
        action={
          <Button asChild>
            <Link href="/dashboard">Go to dashboard</Link>
          </Button>
        }
        className="max-w-md"
      />
    </main>
  );
}

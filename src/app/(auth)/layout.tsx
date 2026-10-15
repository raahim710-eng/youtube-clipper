import { Brand } from "@/components/brand";

// Login/setup decide per request whether an owner exists; never prerender or prefetch that.
// See DECISIONS.md D-022.
export const instant = false;

/** Centered layout for /login and /setup. */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-4 md:p-6">
      <Brand className="text-lg" />
      <div className="w-full max-w-md">{children}</div>
      <p className="max-w-md text-center text-xs text-muted-foreground">
        Runs on your computer. Your videos and account stay on this machine.
      </p>
    </main>
  );
}

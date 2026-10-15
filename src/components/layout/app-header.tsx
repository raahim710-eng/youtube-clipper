import { Suspense } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentSession } from "@/server/session";
import { HeaderTitle } from "./header-title";
import { JobsDrawer } from "./jobs-drawer";
import { UserMenu } from "./user-menu";

/** Top bar (UI_UX.md §2). The user menu reads the session, so it streams in behind Suspense. */
export function AppHeader() {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <HeaderTitle />
      <div className="ml-auto flex items-center gap-1">
        <JobsDrawer />
        <Suspense fallback={<Skeleton className="size-8 rounded-full" />}>
          <CurrentUserMenu />
        </Suspense>
      </div>
    </header>
  );
}

async function CurrentUserMenu() {
  const session = await getCurrentSession();
  if (!session) return null;
  return <UserMenu name={session.user.name} email={session.user.email} />;
}

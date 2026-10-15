import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

// Every signed-in page depends on the session, which we deliberately don't cache
// (a revoked session must stop working immediately). So these routes may block on
// navigation instead of being prefetched as "instant". See DECISIONS.md D-022.
export const instant = false;

/**
 * Shell for every signed-in page. It renders no user data itself (that would block
 * the whole segment); each page checks the session via requireUser(), and the
 * header's user menu streams in behind its own Suspense boundary.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <AppHeader />
        <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}

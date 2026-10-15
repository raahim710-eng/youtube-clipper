import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Your account, connections and how the app runs on this computer." />
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <SettingsNav />
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </div>
  );
}

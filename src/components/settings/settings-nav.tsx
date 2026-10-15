"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PhaseBadge } from "@/components/phase-badge";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { title: "Profile & security", href: "/settings" },
  { title: "Channels", href: "/settings/channels", phase: 7 },
  { title: "AI & processing", href: "/settings/ai" },
  { title: "System status", href: "/settings/system" },
] as const;

/** Settings sub-navigation (FND-05). Horizontal on small screens, vertical on large ones. */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto lg:flex-col">
      {SECTIONS.map((section) => {
        const active = pathname === section.href;
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted",
              active ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {section.title}
            {"phase" in section ? <PhaseBadge phase={section.phase} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

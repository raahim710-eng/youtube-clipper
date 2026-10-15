"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { isActivePath, MAIN_NAV, SETTINGS_NAV_ITEM } from "@/lib/navigation";

/** Left navigation (UI_UX.md §2). Collapses to icons on desktop and becomes a sheet on small screens. */
export function AppSidebar() {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  // On phones the sidebar is a sheet; close it once a destination is chosen.
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const SettingsIcon = SETTINGS_NAV_ITEM.icon;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Dashboard">
              <Link onClick={closeOnMobile} href="/dashboard">
                <Brand />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {MAIN_NAV.map((item) => {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActivePath(pathname, item.href)}
                      tooltip={item.available ? item.title : `${item.title} — Phase ${item.phase}`}
                    >
                      <Link onClick={closeOnMobile} href={item.href}>
                        <Icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                    {!item.available ? (
                      <SidebarMenuBadge className="text-[10px] font-normal text-muted-foreground">
                        P{item.phase}
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={isActivePath(pathname, SETTINGS_NAV_ITEM.href)}
              tooltip={SETTINGS_NAV_ITEM.title}
            >
              <Link onClick={closeOnMobile} href={SETTINGS_NAV_ITEM.href}>
                <SettingsIcon />
                <span>{SETTINGS_NAV_ITEM.title}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

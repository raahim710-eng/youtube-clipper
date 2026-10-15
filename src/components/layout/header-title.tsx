"use client";

import { usePathname } from "next/navigation";
import { isActivePath, MAIN_NAV, SETTINGS_NAV_ITEM } from "@/lib/navigation";

/** Section name in the top bar, derived from the current URL. */
export function HeaderTitle() {
  const pathname = usePathname();
  const item = [...MAIN_NAV, SETTINGS_NAV_ITEM].find((entry) => isActivePath(pathname, entry.href));
  return <span className="truncate text-sm font-medium">{item?.title ?? ""}</span>;
}

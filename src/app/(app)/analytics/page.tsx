import type { Metadata } from "next";
import { FeaturePlaceholder } from "@/components/feature-placeholder";
import { findNavItem } from "@/lib/navigation";
import { requireUser } from "@/server/session";

const item = findNavItem("/analytics");

export const metadata: Metadata = { title: item.title };

/** Placeholder until this feature's phase — see ROADMAP.md. */
export default async function AnalyticsPage() {
  await requireUser();
  return <FeaturePlaceholder item={item} />;
}

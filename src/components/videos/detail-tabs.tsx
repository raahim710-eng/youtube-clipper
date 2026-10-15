"use client";

import { useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = ["clips", "transcript", "details"] as const;
type Tab = (typeof TABS)[number];

/** Switches the video page tab instantly and keeps it in the URL (?tab=…) for links and reloads. */
export function showTab(tab: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  window.history.replaceState(null, "", url);
}

/** Video page tabs, kept in ?tab= so links like "Review clips" open the right one. */
export function DetailTabs({
  clips,
  transcript,
  details,
  counts,
}: {
  clips: React.ReactNode;
  transcript: React.ReactNode;
  details: React.ReactNode;
  counts: { toReview: number };
}) {
  const params = useSearchParams();
  const requested = params.get("tab");
  const value: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : "clips";

  return (
    <Tabs
      value={value}
      // Client-only URL update (no server round trip), synced with useSearchParams by Next.js.
      onValueChange={(next) => showTab(next)}
      className="gap-4"
    >
      <TabsList>
        <TabsTrigger value="clips">Clips{counts.toReview > 0 ? ` (${counts.toReview})` : ""}</TabsTrigger>
        <TabsTrigger value="transcript">Transcript</TabsTrigger>
        <TabsTrigger value="details">Details</TabsTrigger>
      </TabsList>
      <TabsContent value="clips">{clips}</TabsContent>
      <TabsContent value="transcript">{transcript}</TabsContent>
      <TabsContent value="details">{details}</TabsContent>
    </Tabs>
  );
}

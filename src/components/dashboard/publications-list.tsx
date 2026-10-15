"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { PUBLICATION_STATUS_LABELS } from "@/lib/constants";
import type { PublicationView } from "@/server/services/youtube";

/** Dashboard "Scheduled": scheduled publications first, then the latest uploads (times in the viewer's zone). */
export function PublicationsList({ publications }: { publications: PublicationView[] }) {
  return (
    <ul className="space-y-2" aria-label="Uploads and scheduled videos">
      {publications.map((publication) => (
        <li key={publication.id} className="flex items-center gap-2 text-sm">
          <div className="min-w-0 flex-1">
            <Link href="/youtube" className="block truncate font-medium hover:underline">
              {publication.title}
            </Link>
            <p className="truncate text-xs text-muted-foreground">
              {publication.channelTitle}
              {publication.publishAt
                ? ` · publishes ${new Date(publication.publishAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
                : ""}
            </p>
          </div>
          <Badge variant="outline" className="shrink-0 font-normal">
            {PUBLICATION_STATUS_LABELS[publication.status]}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

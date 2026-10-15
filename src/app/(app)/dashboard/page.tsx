import { CalendarClock, ChartLine, Clapperboard, ListTodo, Scissors } from "lucide-react";
import type { Metadata } from "next";
import { ActiveJobsList, ClipsToReviewList, RecentVideosList } from "@/components/dashboard/activity-lists";
import { GetStartedCard } from "@/components/dashboard/get-started-card";
import { QuickActions } from "@/components/dashboard/quick-actions";
import { SystemStatusBanner } from "@/components/dashboard/system-status-banner";
import { DashboardWidget } from "@/components/dashboard/dashboard-widget";
import { PublicationsList } from "@/components/dashboard/publications-list";
import { PageHeader } from "@/components/page-header";
import { requireUser } from "@/server/session";
import { listJobs } from "@/server/services/jobs";
import { getSystemStatus } from "@/server/services/system-status";
import { getLibraryStats, listVideos } from "@/server/services/videos";
import { listClips } from "@/server/services/clips";
import { listPublications } from "@/server/services/youtube";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requireUser();
  const [status, activeJobs, recentVideos, stats] = await Promise.all([
    getSystemStatus(),
    listJobs(user.id, { activeOnly: true, limit: 5 }),
    listVideos(user.id, { q: "", sort: "newest", status: "all" }).then((videos) => videos.slice(0, 4)),
    getLibraryStats(user.id),
  ]);
  const [toReview, scheduled, recentUploads] = await Promise.all([
    listClips(user.id, { status: "suggested", limit: 4 }),
    listPublications(user.id, { scheduledOnly: true, limit: 4 }),
    listPublications(user.id, { limit: 4 }),
  ]);
  const publications = [...scheduled, ...recentUploads.filter((p) => !scheduled.some((s) => s.id === p.id))].slice(
    0,
    4,
  );
  const firstName = user.name.split(/\s+/)[0] || user.name;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description="Here's what's happening across your videos and channel."
      />

      <SystemStatusBanner status={status} />

      <QuickActions />

      <div className="grid gap-4 lg:grid-cols-3">
        <GetStartedCard status={status} videoCount={stats.count} className="lg:col-span-1" />
        <div className="grid gap-4 md:grid-cols-2 lg:col-span-2">
          <DashboardWidget
            title="In progress"
            icon={ListTodo}
            emptyTitle="No background jobs"
            emptyDescription="Uploads, transcriptions and exports will show their progress here."
          >
            {activeJobs.length > 0 ? <ActiveJobsList jobs={activeJobs} /> : undefined}
          </DashboardWidget>
          <DashboardWidget
            title="Recent videos"
            icon={Clapperboard}
            emptyTitle="No videos yet"
            emptyDescription="Videos you upload to your library will appear here."
          >
            {recentVideos.length > 0 ? <RecentVideosList videos={recentVideos} /> : undefined}
          </DashboardWidget>
          <DashboardWidget
            title="Ready for review"
            icon={Scissors}
            emptyTitle="No clip suggestions"
            emptyDescription="Moments suggested by the AI Clip Finder wait here for your review."
          >
            {toReview.length > 0 ? <ClipsToReviewList clips={toReview} /> : undefined}
          </DashboardWidget>
          <DashboardWidget
            title="Scheduled"
            icon={CalendarClock}
            emptyTitle="Nothing scheduled"
            emptyDescription="Uploads and scheduled publications for your channels will be listed here."
          >
            {publications.length > 0 ? <PublicationsList publications={publications} /> : undefined}
          </DashboardWidget>
        </div>
      </div>

      <DashboardWidget
        title="Channel performance"
        icon={ChartLine}
        emptyTitle="No analytics yet"
        emptyDescription="Views, watch time and recommendations appear once a channel is connected and synced."
        phase={8}
      />
    </div>
  );
}

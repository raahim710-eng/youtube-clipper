import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublishForm } from "@/components/youtube/publish-form";
import { requireUser } from "@/server/session";
import { getPublishForm } from "@/server/services/youtube";

export const metadata: Metadata = { title: "Publish to YouTube" };

export default async function PublishPage({ params }: PageProps<"/youtube/publish/[kind]/[id]">) {
  const user = await requireUser();
  const { kind, id } = await params;
  if (kind !== "video" && kind !== "short") notFound();
  // Filtered by owner: someone else's video or Short looks exactly like a missing one.
  const form = await getPublishForm(user.id, kind, id);
  if (!form) notFound();
  return <PublishForm key={`${kind}:${id}`} form={form} />;
}

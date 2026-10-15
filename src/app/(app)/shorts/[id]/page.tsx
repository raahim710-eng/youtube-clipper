import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShortEditor } from "@/components/shorts/short-editor";
import { requireUser } from "@/server/session";
import { getShortEditor } from "@/server/services/shorts";

export const metadata: Metadata = { title: "Edit Short" };

export default async function ShortEditorPage({ params }: PageProps<"/shorts/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  // Filtered by owner: someone else's Short looks exactly like a missing one.
  const data = await getShortEditor(user.id, id);
  if (!data) notFound();
  return <ShortEditor key={data.id} data={data} />;
}

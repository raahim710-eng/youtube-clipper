import type { Metadata } from "next";
import { ChangePasswordForm } from "@/components/settings/change-password-form";
import { SessionsList } from "@/components/settings/sessions-list";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentSession, requireUser } from "@/server/session";
import { listUserSessions } from "@/server/services/sessions";

export const metadata: Metadata = { title: "Profile & security" };

export default async function ProfileSettingsPage() {
  const user = await requireUser();
  const session = await getCurrentSession();
  const sessions = session ? await listUserSessions(user.id, session.sessionId) : [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
          <CardDescription>The owner account for this installation.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-[120px_1fr]">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{user.name}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{user.email}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Change password</CardTitle>
          <CardDescription>Changing your password signs out all your other sessions.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active sessions</CardTitle>
          <CardDescription>Browsers that are signed in to this app. Sessions expire after 7 days.</CardDescription>
        </CardHeader>
        <CardContent>
          <SessionsList
            sessions={sessions.map((s) => ({
              id: s.id,
              createdAt: s.createdAt.toISOString(),
              expiresAt: s.expiresAt.toISOString(),
              userAgent: s.userAgent,
              isCurrent: s.isCurrent,
            }))}
          />
        </CardContent>
      </Card>
    </>
  );
}

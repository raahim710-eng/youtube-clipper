import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ConfigRequired } from "@/components/auth/config-required";
import { LoginForm } from "@/components/auth/login-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { safeRedirectPath } from "@/lib/validation/auth";
import { getAuthGate } from "@/server/auth-gate";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  const destination = safeRedirectPath(typeof next === "string" ? next : null);

  const gate = await getAuthGate();
  if (gate.kind === "config") return <ConfigRequired problems={gate.problems} />;
  if (gate.kind === "needs-setup") redirect("/setup");
  if (gate.kind === "signed-in") redirect(destination);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">
          <h1>Sign in</h1>
        </CardTitle>
        <CardDescription>Use the owner account you created for this app.</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm next={destination} />
      </CardContent>
    </Card>
  );
}

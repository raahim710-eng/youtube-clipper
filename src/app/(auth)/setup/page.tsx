import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ConfigRequired } from "@/components/auth/config-required";
import { SetupForm } from "@/components/auth/setup-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAuthGate } from "@/server/auth-gate";

export const metadata: Metadata = { title: "Set up" };

/** First-run owner setup (FND-01). Closed on the server once an account exists. */
export default async function SetupPage() {
  const gate = await getAuthGate();
  if (gate.kind === "config") return <ConfigRequired problems={gate.problems} />;
  if (gate.kind === "signed-in") redirect("/dashboard");
  if (gate.kind === "ready") redirect("/login");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">
          <h1>Create your owner account</h1>
        </CardTitle>
        <CardDescription>
          This is a one-time step. The account is stored only on this computer, and sign-up closes once it exists.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SetupForm />
      </CardContent>
    </Card>
  );
}

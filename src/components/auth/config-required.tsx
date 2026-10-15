import { Wrench } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConfigProblem } from "@/server/env";
import { TextWithCode } from "@/components/text-with-code";

/**
 * Shown instead of the login/setup form when required configuration is missing,
 * so the app never pretends authentication works when it can't.
 */
export function ConfigRequired({ problems }: { problems: ConfigProblem[] }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-warning/15 text-warning">
            <Wrench className="size-5" aria-hidden />
          </span>
          <div>
            <CardTitle>
              <h1>Setup needed before you can sign in</h1>
            </CardTitle>
            <CardDescription>Login is turned off until these settings are fixed.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ul className="space-y-2">
          {problems.map((problem) => (
            <li key={problem.variable} className="rounded-lg border p-3">
              <code className="font-mono text-xs font-semibold">{problem.variable}</code>
              <p className="mt-1 text-muted-foreground">
                <TextWithCode text={problem.message} />
              </p>
            </li>
          ))}
        </ul>
        <div className="space-y-1 text-muted-foreground">
          <p className="font-medium text-foreground">How to fix</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              In the project folder, run <code className="font-mono text-xs">npm run setup:env</code> (creates{" "}
              <code className="font-mono text-xs">.env</code> with new secrets), or edit your existing{" "}
              <code className="font-mono text-xs">.env</code>.
            </li>
            <li>
              Run <code className="font-mono text-xs">npm run db:migrate</code> if you haven&apos;t yet.
            </li>
            <li>Restart the app and reload this page.</li>
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

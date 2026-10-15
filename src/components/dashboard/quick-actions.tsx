import { ArrowRight, Scissors, Upload, WandSparkles } from "lucide-react";
import Link from "next/link";
import { PhaseBadge } from "@/components/phase-badge";
import { Card, CardContent } from "@/components/ui/card";
import { findNavItem } from "@/lib/navigation";

const ACTIONS = [
  { label: "Upload video", description: "Add a video to your library", icon: Upload, item: findNavItem("/videos") },
  { label: "Find clips", description: "Spot moments for Shorts", icon: Scissors, item: findNavItem("/clip-finder") },
  {
    label: "Generate video",
    description: "Create an original video from a topic",
    icon: WandSparkles,
    item: findNavItem("/generator"),
  },
];

/** DASH-01. Each action links to its page; unbuilt ones show the phase that delivers them. */
export function QuickActions() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {ACTIONS.map(({ label, description, icon: Icon, item }) => (
        <Link
          key={label}
          href={item.href}
          className="group rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Card className="h-full transition-colors group-hover:bg-muted/50">
            <CardContent className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex items-center justify-between gap-2 font-medium">
                  {label}
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="block text-sm text-muted-foreground">{description}</span>
                {!item.available ? <PhaseBadge phase={item.phase} /> : null}
              </span>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

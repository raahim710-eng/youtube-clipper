import {
  ChartLine,
  Clapperboard,
  LayoutDashboard,
  type LucideIcon,
  MonitorPlay,
  PenLine,
  Scissors,
  Settings,
  Smartphone,
  WandSparkles,
} from "lucide-react";

/**
 * Single source of truth for the sidebar and for each feature's placeholder page.
 * When a feature is built in its phase, set `available: true` and replace its
 * placeholder page with the real one.
 */

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Roadmap phase that delivers this feature (ROADMAP.md). */
  phase: number;
  /** Whether the real feature exists yet. */
  available: boolean;
  /** One sentence describing what the page will do. */
  description: string;
  /** What the finished page will offer — shown on the placeholder. */
  planned: string[];
};

export const MAIN_NAV: NavItem[] = [
  {
    title: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboard,
    phase: 2,
    available: true,
    description: "Everything happening on your channel and in the app, at a glance.",
    planned: [],
  },
  {
    title: "Videos",
    href: "/videos",
    icon: Clapperboard,
    phase: 3,
    available: true,
    description: "Upload and manage the source videos every other tool works with.",
    planned: [
      "Drag-and-drop uploads that resume after interruptions",
      "Automatic metadata, poster frames and browser-friendly previews",
      "Search, sort and filter your library",
      "Background processing with live progress",
    ],
  },
  {
    title: "AI Clip Finder",
    href: "/clip-finder",
    icon: Scissors,
    phase: 4,
    available: true,
    description: "Transcribe your videos locally and find moments that could work as Shorts.",
    planned: [
      "Local transcription with word-level timestamps",
      "Searchable transcript synced with the player",
      "Ranked clip suggestions with a hook, title and reason",
      "Manual clips from any transcript selection",
    ],
  },
  {
    title: "Shorts Editor",
    href: "/shorts",
    icon: Smartphone,
    phase: 5,
    available: true,
    description: "Turn clips into vertical 9:16 Shorts with captions and smart framing.",
    planned: [
      "Automatic face-tracking reframing, centre or blurred-background modes",
      "Editable auto-captions with style presets",
      "Trim on a timeline with transcript words",
      "1080×1920 MP4 export",
    ],
  },
  {
    title: "AI Packaging",
    href: "/packaging",
    icon: PenLine,
    phase: 6,
    available: true,
    description: "Titles, descriptions, hashtags, hooks and thumbnail ideas for each upload.",
    planned: [
      "Five title options within YouTube's limits",
      "Descriptions with chapters from your transcript",
      "Hashtags and opening hooks",
      "Thumbnail concepts and mock-ups from your own frames",
    ],
  },
  {
    title: "YouTube",
    href: "/youtube",
    icon: MonitorPlay,
    phase: 7,
    available: true,
    description: "Connect your channels and publish or schedule uploads securely.",
    planned: [
      "Secure Google sign-in for one or more channels",
      "Uploads with title, description, tags, thumbnail and disclosures",
      "Scheduling with YouTube's own publish time (after the free API audit)",
      "Daily quota tracking",
    ],
  },
  {
    title: "Analytics",
    href: "/analytics",
    icon: ChartLine,
    phase: 8,
    available: false,
    description: "Channel and video performance with recommendations based on your data.",
    planned: [
      "Views, watch time and subscriber trends",
      "Top videos and Shorts vs long-form comparison",
      "Recommendations that show their evidence",
    ],
  },
  {
    title: "Original Video Generator",
    href: "/generator",
    icon: WandSparkles,
    phase: 9,
    available: true,
    description: "Create original videos from a topic with a script, narration and real stock footage.",
    planned: [
      "Scene-by-scene script you review and edit",
      "Narration with a local voice (Windows voices; Kokoro optional)",
      "Real moving footage per scene: Pexels, optional Pixabay, your library or your own clips",
      "Captions, credits and finished MP4 in your library",
    ],
  },
];

export const SETTINGS_NAV_ITEM = {
  title: "Settings",
  href: "/settings",
  icon: Settings,
} as const;

export function findNavItem(href: string): NavItem {
  const item = MAIN_NAV.find((entry) => entry.href === href);
  if (!item) throw new Error(`Unknown navigation item: ${href}`);
  return item;
}

/** True when `pathname` is the item's page or one of its sub-pages. */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

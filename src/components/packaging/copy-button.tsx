"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** One-click copy (PKG-05). Shows a tick for a moment so it's clear something happened. */
export function CopyButton({
  text,
  label,
  what,
  size = "sm",
}: {
  text: string;
  /** Accessible name, e.g. "Copy title 2". */
  label: string;
  /** For the confirmation, e.g. "Title". */
  what: string;
  size?: "sm" | "icon-sm";
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`${what} copied.`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copying isn't allowed here. Select the text and press Ctrl+C instead.");
    }
  }
  return (
    <Button type="button" variant="ghost" size={size} onClick={copy} aria-label={label} disabled={!text.trim()}>
      {copied ? <Check /> : <Copy />}
      {size === "sm" ? (copied ? "Copied" : "Copy") : null}
    </Button>
  );
}

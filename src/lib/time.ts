/** Timecodes for clips: m:ss.s (or h:mm:ss.s) — tenths matter when trimming. */
export function formatTimecode(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const totalSeconds = Math.floor(tenths / 10);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = `${String(totalSeconds % 60).padStart(2, "0")}.${tenths % 10}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Parses "75.5", "1:15.5" or "1:02:03" into milliseconds; null when it isn't a time. */
export function parseTimecode(input: string): number | null {
  const parts = input.trim().split(":");
  if (parts.length === 0 || parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  const numbers = parts.map(Number);
  const seconds = numbers.reduce((total, value) => total * 60 + value, 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

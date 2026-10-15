"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title", label: "Title A–Z" },
  { value: "longest", label: "Longest first" },
  { value: "largest", label: "Largest first" },
];
const STATUSES = [
  { value: "all", label: "All videos" },
  { value: "ready", label: "Ready" },
  { value: "processing", label: "Processing" },
  { value: "failed", label: "Failed" },
];

/** LIB-04: search, sort and filter, kept in the URL so a view can be bookmarked. */
export function LibraryToolbar() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");

  function setParam(key: string, value: string, defaultValue: string) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === defaultValue) next.delete(key);
    else next.set(key, value);
    const search = next.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  }

  // Debounce typing so the list doesn't reload on every key press.
  useEffect(() => {
    if (query.trim() === (params.get("q") ?? "")) return;
    const timer = setTimeout(() => setParam("q", query.trim(), ""), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setParam always reads the latest params
  }, [query]);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by title"
          aria-label="Search videos by title"
          className="pl-8"
        />
      </div>
      <Select value={params.get("status") ?? "all"} onValueChange={(value) => setParam("status", value, "all")}>
        <SelectTrigger className="w-full sm:w-40" aria-label="Filter by status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUSES.map((status) => (
            <SelectItem key={status.value} value={status.value}>
              {status.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={params.get("sort") ?? "newest"} onValueChange={(value) => setParam("sort", value, "newest")}>
        <SelectTrigger className="w-full sm:w-44" aria-label="Sort videos">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORTS.map((sort) => (
            <SelectItem key={sort.value} value={sort.value}>
              {sort.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

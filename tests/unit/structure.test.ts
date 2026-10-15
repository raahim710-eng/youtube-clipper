import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAIN_NAV, SETTINGS_NAV_ITEM } from "@/lib/navigation";
import { resolveSqliteFilePath } from "@/server/database-url";

const appDir = path.resolve(__dirname, "../../src/app");

describe("navigation", () => {
  it("gives every navigation item a page", () => {
    for (const item of [...MAIN_NAV, SETTINGS_NAV_ITEM]) {
      const page = path.join(appDir, "(app)", item.href, "page.tsx");
      expect(fs.existsSync(page), `${item.href} needs ${page}`).toBe(true);
    }
  });

  it("has unique links and describes unbuilt features", () => {
    const hrefs = MAIN_NAV.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of MAIN_NAV.filter((entry) => !entry.available)) {
      expect(item.planned.length, `${item.title} needs planned features`).toBeGreaterThan(0);
      expect(item.phase).toBeGreaterThan(2);
    }
  });
});

describe("API route protection (TESTING.md §4)", () => {
  // Routes allowed to answer without a session. Everything else must call requireApiSession().
  const PUBLIC_ROUTES = new Set(["auth/[...all]", "health"]);
  const BROWSER_NAVIGATION_ROUTES = new Set(["youtube/oauth/start", "youtube/oauth/callback"]);

  it("requires a session in every non-public API route", () => {
    const apiDir = path.join(appDir, "api");
    const routes = fs
      .readdirSync(apiDir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith("route.ts"))
      .map((file) => path.dirname(file).split(path.sep).join("/"));

    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      if (PUBLIC_ROUTES.has(route) || route.startsWith("internal/")) continue;
      const source = fs.readFileSync(path.join(apiDir, route, "route.ts"), "utf8");
      if (BROWSER_NAVIGATION_ROUTES.has(route)) {
        // Visited by the browser itself (OAuth redirects), so they redirect instead of answering 401 —
        // but they must still check the session.
        expect(source, `api/${route} must check the session`).toMatch(/getCurrentSession\(\)[\s\S]*if \(!session\)/);
        continue;
      }
      expect(source, `api/${route} must call requireApiSession()`).toContain("requireApiSession(");
    }
  });
});

describe("resolveSqliteFilePath", () => {
  it("resolves relative paths from the project root", () => {
    expect(resolveSqliteFilePath("file:./data/app.db", "/project")).toBe(path.resolve("/project", "data/app.db"));
  });

  it("rejects non-file URLs", () => {
    expect(() => resolveSqliteFilePath("postgres://x")).toThrow();
    expect(() => resolveSqliteFilePath("file:")).toThrow();
  });
});

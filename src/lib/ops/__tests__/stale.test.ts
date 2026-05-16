import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_STALE_THRESHOLD_MS,
  APP_STALE_BANNER_THRESHOLD_MS,
  isApiSnapshotStale,
  shouldShowStaleBanner,
} from "../stale";

describe("ops stale helpers", () => {
  it("uses a 2-hour API stale threshold", () => {
    expect(API_STALE_THRESHOLD_MS).toBe(2 * 60 * 60 * 1000);
    expect(isApiSnapshotStale(119 * 60 * 1000)).toBe(false);
    expect(isApiSnapshotStale(API_STALE_THRESHOLD_MS)).toBe(false);
    expect(isApiSnapshotStale(API_STALE_THRESHOLD_MS + 1)).toBe(true);
  });

  it("uses a 3-hour app banner threshold", () => {
    expect(APP_STALE_BANNER_THRESHOLD_MS).toBe(3 * 60 * 60 * 1000);
    expect(shouldShowStaleBanner(null)).toBe(false);
    expect(shouldShowStaleBanner(APP_STALE_BANNER_THRESHOLD_MS)).toBe(false);
    expect(shouldShowStaleBanner(APP_STALE_BANNER_THRESHOLD_MS + 1)).toBe(true);
  });
});

describe("stale snapshot banner integration", () => {
  function readProjectFile(filePath: string): string {
    return readFileSync(path.join(process.cwd(), filePath), "utf8");
  }

  it("mounts the stale banner below AppNav and before main content", () => {
    const layout = readProjectFile("src/app/(app)/layout.tsx");

    expect(layout).toContain("StaleSnapshotBanner");
    expect(layout.indexOf("<AppNav />")).toBeLessThan(layout.indexOf("<StaleSnapshotBanner />"));
    expect(layout.indexOf("<StaleSnapshotBanner />")).toBeLessThan(layout.indexOf("<main"));
  });

  it("uses exact stale banner copy, data-health link, session dismissal, and health fetch", () => {
    const banner = readProjectFile("src/components/layout/stale-snapshot-banner.tsx");

    expect(banner).toContain("Tutor data may be outdated. Last successful sync was over 3 hours ago.");
    expect(banner).toContain("View data health");
    expect(banner).toContain('href="/data-health"');
    expect(banner).toContain('fetch("/api/data-health"');
    expect(banner).toContain("sessionStorage");
    expect(banner).toContain("STALE_BANNER_SESSION_KEY");
    expect(banner).toContain("shouldShowStaleBanner");
  });
});

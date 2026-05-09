import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Phase 10 view transition source guardrails", () => {
  it("keeps Next config on cacheComponents without experimental viewTransition", () => {
    const source = read("next.config.ts");

    expect(source).toContain("cacheComponents: true");
    expect(source).not.toMatch(/viewTransition/);
  });

  it("does not add animation dependencies", () => {
    const packageJson = read("package.json");

    expect(packageJson).not.toContain("framer-motion");
    expect(packageJson).not.toContain('"motion"');
    expect(packageJson).not.toContain("motion/react");
    expect(packageJson).not.toContain("@react-spring");
    expect(packageJson).not.toContain("react-spring");
  });

  it("defines scoped calendar transition CSS and reduced-motion rules", () => {
    const source = read("src/app/globals.css");

    expect(source).toContain("compare-calendar-transition-surface");
    expect(source).toContain("view-transition-name: compare-calendar");
    expect(source).toContain(":active-view-transition-type(week-forward)");
    expect(source).toContain(":active-view-transition-type(week-back)");
    expect(source).toContain(":active-view-transition-type(day)");
    expect(source).toContain("animation-duration: 160ms");
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("wires ComparePanel through native helper imports and flushSync", () => {
    const source = read("src/components/compare/compare-panel.tsx");

    expect(source).toContain("runCalendarViewTransition");
    expect(source).toContain("getWeekTransitionKind");
    expect(source).toContain("isRapidWeekNavigation");
    expect(source).toContain('import { flushSync } from "react-dom";');
  });

  it("normalizes calendar scroll through minute-of-day conversions", () => {
    const source = read("src/components/compare/compare-panel.tsx");

    expect(source).toContain("const CALENDAR_START_HOUR = 7;");
    expect(source).toContain("const WEEK_PIXELS_PER_HOUR = 48;");
    expect(source).toContain("const DAY_PIXELS_PER_HOUR = 60;");
    expect(source).toContain("captureCalendarMinuteOfDay");
    expect(source).toContain("restoreCalendarMinuteOfDay");
    expect(source).toContain(
      "CALENDAR_START_HOUR * 60 + ((el?.scrollTop ?? 0) / sourcePixelsPerHour) * 60",
    );
    expect(source).toContain(
      "((minuteOfDay - CALENDAR_START_HOUR * 60) / 60) * targetPixelsPerHour",
    );
    expect(source).toContain("sameViewScrollTop");
    expect(source).toContain("requestAnimationFrame(restore)");
  });

  it("documents the 5pm week-day scroll conversion evidence", () => {
    const source = read("src/components/compare/compare-panel.tsx");

    expect(source).toContain("480");
    expect(source).toContain("1020");
    expect(source).toContain("600");
  });

  it("keeps useCompare on the client helper path without next/navigation", () => {
    const source = read("src/hooks/use-compare.ts");

    expect(source).toContain("runCalendarViewTransition");
    expect(source).not.toContain("next/navigation");
  });

  it("keeps fetch-first week navigation cache and abort handling safe", () => {
    const source = read("src/hooks/use-compare.ts");

    expect(source).toContain("cancelCompareFetch");
    expect(source).toContain("abortRef.current?.abort();");
    expect(source).toContain("pruneCacheToWeek");
    expect(source).toContain("const targetSuffix = `:${committedWeek}:${CACHE_VERSION}`;");
    expect(source).toContain("pruneCacheToWeek(newWeek);");
    expect(source).not.toContain("tutorCache.current.clear();\n    const prepared = await fetchCompareData");
  });

  it("bases rapid week arrows on the pending target week", () => {
    const source = read("src/components/compare/compare-panel.tsx");

    expect(source).toContain("const pendingWeekRef = useRef<string | null>(null);");
    expect(source).toContain("pendingWeekRef.current = targetWeek;");
    expect(source).toContain("const handleWeekDelta = useCallback");
    expect(source).toContain("const baseWeek = pendingWeekRef.current ?? weekStart;");
    expect(source).toContain("handleWeekChange(shiftWeek(baseWeek, delta));");
    expect(source).toContain("cancelCompareFetch();");
  });

  it("keeps compare cache version stable", () => {
    const source = read("src/lib/search/cache-version.ts");

    expect(source).toContain('export const CACHE_VERSION = "v2";');
  });
});

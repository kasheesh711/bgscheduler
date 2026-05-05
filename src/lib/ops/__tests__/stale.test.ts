import { describe, expect, it } from "vitest";
import {
  API_STALE_THRESHOLD_MS,
  APP_STALE_BANNER_THRESHOLD_MS,
  isApiSnapshotStale,
  shouldShowStaleBanner,
} from "../stale";

describe("ops stale helpers", () => {
  it("uses a 26-hour API stale threshold", () => {
    expect(API_STALE_THRESHOLD_MS).toBe(26 * 60 * 60 * 1000);
    expect(isApiSnapshotStale(25 * 60 * 60 * 1000 + 59 * 60 * 1000)).toBe(false);
    expect(isApiSnapshotStale(API_STALE_THRESHOLD_MS)).toBe(false);
    expect(isApiSnapshotStale(API_STALE_THRESHOLD_MS + 1)).toBe(true);
  });

  it("uses a 48-hour app banner threshold", () => {
    expect(APP_STALE_BANNER_THRESHOLD_MS).toBe(48 * 60 * 60 * 1000);
    expect(shouldShowStaleBanner(null)).toBe(false);
    expect(shouldShowStaleBanner(APP_STALE_BANNER_THRESHOLD_MS)).toBe(false);
    expect(shouldShowStaleBanner(APP_STALE_BANNER_THRESHOLD_MS + 1)).toBe(true);
  });
});

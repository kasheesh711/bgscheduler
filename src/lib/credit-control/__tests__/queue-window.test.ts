import { describe, expect, it } from "vitest";

import {
  QUEUE_WINDOW_INITIAL,
  QUEUE_WINDOW_STEP,
  getNextWindowSize,
  getWindowSizeForIndex,
} from "@/lib/credit-control/queue-window";

describe("queue window constants", () => {
  it("starts with a window large enough to fill the panel and grows by the same step", () => {
    expect(QUEUE_WINDOW_INITIAL).toBeGreaterThanOrEqual(30);
    expect(QUEUE_WINDOW_STEP).toBeGreaterThanOrEqual(30);
  });
});

describe("getNextWindowSize", () => {
  it("grows the window by one step when more rows remain", () => {
    expect(getNextWindowSize(60, 300, 60)).toBe(120);
    expect(getNextWindowSize(120, 300, 60)).toBe(180);
  });

  it("clamps to the total row count on the final step", () => {
    expect(getNextWindowSize(240, 290, 60)).toBe(290);
  });

  it("never shrinks the window when the list got shorter", () => {
    expect(getNextWindowSize(120, 80, 60)).toBe(120);
    expect(getNextWindowSize(60, 60, 60)).toBe(60);
    expect(getNextWindowSize(60, 0, 60)).toBe(60);
  });

  it("uses the default step when none is given", () => {
    expect(getNextWindowSize(QUEUE_WINDOW_INITIAL, QUEUE_WINDOW_INITIAL + QUEUE_WINDOW_STEP * 2)).toBe(
      QUEUE_WINDOW_INITIAL + QUEUE_WINDOW_STEP,
    );
  });
});

describe("getWindowSizeForIndex", () => {
  it("keeps the current window when the target row is already mounted", () => {
    expect(getWindowSizeForIndex(0, 60, 60)).toBe(60);
    expect(getWindowSizeForIndex(59, 60, 60)).toBe(60);
  });

  it("expands the window in whole steps until the target row is mounted", () => {
    expect(getWindowSizeForIndex(60, 60, 60)).toBe(120);
    expect(getWindowSizeForIndex(119, 60, 60)).toBe(120);
    expect(getWindowSizeForIndex(120, 60, 60)).toBe(180);
    expect(getWindowSizeForIndex(245, 60, 60)).toBe(300);
  });

  it("uses the default step when none is given", () => {
    expect(getWindowSizeForIndex(QUEUE_WINDOW_INITIAL, QUEUE_WINDOW_INITIAL)).toBe(
      QUEUE_WINDOW_INITIAL + QUEUE_WINDOW_STEP,
    );
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  getWeekTransitionKind,
  isRapidWeekNavigation,
  runCalendarViewTransition,
} from "../view-transitions";

describe("getWeekTransitionKind", () => {
  it("returns forward for a later ISO week", () => {
    expect(getWeekTransitionKind("2026-04-06", "2026-04-13")).toBe(
      "week-forward",
    );
  });

  it("returns back for an earlier ISO week", () => {
    expect(getWeekTransitionKind("2026-04-13", "2026-04-06")).toBe(
      "week-back",
    );
  });

  it("returns null for the same ISO week", () => {
    expect(getWeekTransitionKind("2026-04-06", "2026-04-06")).toBeNull();
  });
});

describe("isRapidWeekNavigation", () => {
  it("returns false without a previous navigation timestamp", () => {
    expect(isRapidWeekNavigation(null, 1000)).toBe(false);
  });

  it("returns true below the rapid-navigation threshold", () => {
    expect(isRapidWeekNavigation(1000, 1299)).toBe(true);
  });

  it("returns false at the rapid-navigation threshold", () => {
    expect(isRapidWeekNavigation(1000, 1300)).toBe(false);
  });
});

describe("runCalendarViewTransition", () => {
  it("calls update directly when skip is true", async () => {
    const update = vi.fn();
    const fakeDocument = {
      startViewTransition: vi.fn(),
    } as unknown as Document;

    await runCalendarViewTransition(update, {
      kind: "day",
      skip: true,
      documentRef: fakeDocument,
    });

    expect(update).toHaveBeenCalledOnce();
    expect(fakeDocument.startViewTransition).not.toHaveBeenCalled();
  });

  it("calls update directly when startViewTransition is unsupported", async () => {
    const update = vi.fn();
    const fakeDocument = {} as unknown as Document;

    await runCalendarViewTransition(update, {
      kind: "day",
      documentRef: fakeDocument,
    });

    expect(update).toHaveBeenCalledOnce();
  });

  it("calls update directly when reduced motion is enabled", async () => {
    const update = vi.fn();
    const fakeDocument = {
      startViewTransition: vi.fn(),
    } as unknown as Document;

    await runCalendarViewTransition(update, {
      kind: "day",
      documentRef: fakeDocument,
      reducedMotion: true,
    });

    expect(update).toHaveBeenCalledOnce();
    expect(fakeDocument.startViewTransition).not.toHaveBeenCalled();
  });

  it("uses native view transitions with static transition types", async () => {
    const update = vi.fn();
    const fakeDocument = {
      startViewTransition: vi.fn((options) => {
        options.update();

        return {
          finished: Promise.resolve(),
        };
      }),
    } as unknown as Document;

    await runCalendarViewTransition(update, {
      kind: "day",
      documentRef: fakeDocument,
    });

    expect(update).toHaveBeenCalledOnce();
    expect(fakeDocument.startViewTransition).toHaveBeenCalledWith({
      update,
      types: ["day"],
    });
  });
});

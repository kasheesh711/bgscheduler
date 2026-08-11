import { describe, expect, it } from "vitest";

import {
  SCHEDULE_VIEW_STORAGE_KEY,
  readStoredScheduleView,
  resolveScheduleView,
  resolveViewContainerClasses,
  writeStoredScheduleView,
} from "../schedule-view-preference";

describe("resolveScheduleView", () => {
  it("passes the two valid views through", () => {
    expect(resolveScheduleView("agenda")).toBe("agenda");
    expect(resolveScheduleView("calendar")).toBe("calendar");
  });

  it("fails closed to auto on anything else", () => {
    expect(resolveScheduleView(null)).toBeNull();
    expect(resolveScheduleView("")).toBeNull();
    expect(resolveScheduleView("AGENDA")).toBeNull();
    expect(resolveScheduleView("grid")).toBeNull();
  });
});

describe("readStoredScheduleView", () => {
  it("reads a valid stored choice", () => {
    const storage = { getItem: () => "calendar" };
    expect(readStoredScheduleView(storage)).toBe("calendar");
  });

  it("returns auto for missing storage, garbage, or a throwing getItem", () => {
    expect(readStoredScheduleView(null)).toBeNull();
    expect(readStoredScheduleView(undefined)).toBeNull();
    expect(readStoredScheduleView({ getItem: () => "nonsense" })).toBeNull();
    expect(
      readStoredScheduleView({
        getItem: () => {
          throw new Error("private browsing");
        },
      }),
    ).toBeNull();
  });
});

describe("writeStoredScheduleView", () => {
  it("persists under the schedule view key", () => {
    const writes: Array<[string, string]> = [];
    writeStoredScheduleView(
      { setItem: (key: string, value: string) => void writes.push([key, value]) },
      "calendar",
    );
    expect(writes).toEqual([[SCHEDULE_VIEW_STORAGE_KEY, "calendar"]]);
  });

  it("swallows a throwing setItem", () => {
    expect(() =>
      writeStoredScheduleView(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        "agenda",
      ),
    ).not.toThrow();
    expect(() => writeStoredScheduleView(null, "agenda")).not.toThrow();
  });
});

describe("resolveViewContainerClasses", () => {
  it("auto lets the SSR HTML pick per screen size", () => {
    expect(resolveViewContainerClasses(null)).toEqual({
      agenda: "mx-auto w-full max-w-screen-sm lg:hidden",
      calendar: "mx-auto hidden w-full max-w-screen-sm lg:block lg:max-w-5xl",
      header: "mx-auto max-w-screen-sm lg:max-w-5xl",
    });
  });

  it("forced agenda hides the calendar at every size", () => {
    expect(resolveViewContainerClasses("agenda")).toEqual({
      agenda: "mx-auto w-full max-w-screen-sm",
      calendar: "hidden",
      header: "mx-auto max-w-screen-sm",
    });
  });

  it("forced calendar hides the agenda and restores the wide grid column", () => {
    expect(resolveViewContainerClasses("calendar")).toEqual({
      agenda: "hidden",
      calendar: "mx-auto w-full max-w-screen-sm lg:max-w-5xl",
      header: "mx-auto max-w-screen-sm lg:max-w-5xl",
    });
  });
});

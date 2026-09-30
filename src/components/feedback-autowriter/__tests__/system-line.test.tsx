import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

// A closed popover renders nothing on the server: show the menu's content inline.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render }: { render: (props: Record<string, unknown>) => React.ReactNode }) => <>{render({})}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div data-testid="controls-menu">{children}</div>,
}));

import { SystemLine } from "../system-line";
import { dashboardFixture, reviewFixture } from "./fixtures";

const LAST_RUN = reviewFixture().lastRun;

function render(options: { canControl?: boolean; control?: Partial<ReturnType<typeof dashboardFixture>["control"]>; lastRun?: typeof LAST_RUN | undefined } = {}): string {
  const dashboard = dashboardFixture();
  return renderToStaticMarkup(
    <SystemLine dashboard={{ ...dashboard, control: { ...dashboard.control, ...options.control } }}
      lastRun={"lastRun" in options ? options.lastRun : LAST_RUN} canControl={options.canControl ?? false} busy={false} onControl={() => undefined} />,
  );
}

describe("SystemLine", () => {
  it("states what the autowriter runs with: mode, models and efforts, evidence switches, versions, last run and last webhook", () => {
    const html = render();
    expect(html).toContain("Mode LIVE");
    expect(html).toContain("Writer GPT-6.1 Sol (low)");
    expect(html).toContain("Fallback GPT-6 Luna (max)");
    expect(html).toContain("Judge GLM Flash (medium + high)");
    expect(html).toContain("Transcript first: on");
    expect(html).toContain("Second pass: on");
    expect(html).toContain("Prompt v5 · Judge v5");
    expect(html).toContain('title="Commit abc1234"');
    expect(html).toContain("Last review run 6 Oct, 15:27 · succeeded");
    expect(html).toContain("Last Wise webhook 6 Oct, 15:31");
    expect(html).not.toContain("Halted");
    expect(html).not.toContain("Posting is halted");
  });

  it("says what it cannot know: a review job that never ran, or review data that did not load", () => {
    expect(render({ lastRun: null })).toContain("Review job has not run yet");
    expect(render({ lastRun: undefined })).toContain("Last review run: unknown");
    expect(render({ control: { mode: "shadow" } })).toContain("Mode SHADOW");
    expect(render({ control: { mode: "off" } })).toContain("Mode OFF");
  });

  it("shows the owner's Controls only to the owner: the other modes, and Pause", () => {
    const viewer = render();
    const owner = render({ canControl: true });
    expect(viewer).not.toContain("Controls");
    expect(viewer).not.toContain("Go live");
    expect(viewer).not.toContain(">Pause<");
    expect(owner).toContain("Controls");
    // Live now: the menu offers the two other modes.
    expect(owner).toContain(">Shadow<");
    expect(owner).toContain(">Turn off<");
    expect(owner).not.toContain("Go live");
    expect(owner).toContain(">Pause<");
    expect(owner).toContain("Last changed by owner@example.com");
    const shadow = render({ canControl: true, control: { mode: "shadow" } });
    expect(shadow).toContain("Go live");
    expect(shadow).toContain(">Turn off<");
    expect(shadow).not.toContain(">Shadow<");
  });

  it("makes a halt impossible to miss, with Resume for the owner", () => {
    const halt = { haltedAt: "2026-10-06T02:00:00.000Z", haltReason: "unknown outcome for the feedback POST on x" };
    const owner = render({ canControl: true, control: halt });
    expect(owner).toContain('role="alert"');
    expect(owner).toContain("Posting is halted");
    expect(owner).toContain("since 6 Oct, 09:00");
    expect(owner).toContain("unknown outcome for the feedback POST on x");
    expect(owner).toContain(">Halted<");
    // Resume sits on the banner and in the menu; Pause is gone while halted.
    expect(owner.match(/>Resume</gu)).toHaveLength(2);
    expect(owner).not.toContain(">Pause<");
    const viewer = render({ control: halt });
    expect(viewer).toContain("Posting is halted");
    expect(viewer).not.toContain(">Resume<");
    expect(render({ control: { haltedAt: halt.haltedAt, haltReason: null } })).toContain("no reason recorded");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClassroomReadiness, GroupedFindingList, ReadinessStatusBar, WeekendDetails } from "../readiness-notice";
import { groupReadinessFindings, summarizeWeekendReadiness, type ReadinessSummary, type WeekendView } from "../readiness-summary";

const day: ReadinessSummary = { label: "1 class", severity: "danger", affectedClasses: 1,
  groups: groupReadinessFindings([{ date: "2026-09-12", wiseSessionId: "session", tutor: "Teacher", className: "Student", kind: "no_room", message: "No compatible classroom" }]) };
const notChecked: WeekendView = { check: null, dates: ["2026-09-12", "2026-09-13"], error: null, loading: false };

describe("compact classroom status and drawer", () => {
  it("shows all three statuses together without rendering the warning lists on the page", () => {
    const html = renderToStaticMarkup(<ReadinessStatusBar day={day} weekend={summarizeWeekendReadiness(notChecked)}
      wise={{ label: "Stale · review", severity: "warning" }} action={<button>Review issues</button>} />);
    expect(html).toContain('aria-label="Day: 1 class"');
    expect(html).toContain('aria-label="Weekend: Not checked"');
    expect(html).toContain('aria-label="Wise: Stale · review"');
    expect(html).toContain("Review issues");
    expect(html).not.toContain("No compatible classroom");
  });
  it("starts the actual drawer closed even when the selected day has a blocking issue", () => {
    const html = renderToStaticMarkup(<ClassroomReadiness detail={null} day={day} date="2026-09-12" loading={false} />);
    expect(html).toContain("Review issues");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("No compatible classroom");
  });
  it("groups a class once while preserving distinct time-specific reasons", () => {
    const base = { date: "2026-09-12", wiseSessionId: "session", tutor: "Teacher", className: "Student", kind: "conflict" as const };
    const groups = groupReadinessFindings([{ ...base, startMinute: 600, endMinute: 630, message: "First overlap" },
      { ...base, startMinute: 640, endMinute: 660, message: "Second overlap" }]);
    const html = renderToStaticMarkup(<GroupedFindingList groups={groups} />);
    expect(html.match(/Teacher/g)).toHaveLength(1);
    expect(html).toContain("10:00–10:30");
    expect(html).toContain("10:40–11:00");
    expect(html).not.toContain("overflow-y-auto");
  });
  it("does not render an unchecked or unavailable report as an all-clear", () => {
    expect(renderToStaticMarkup(<WeekendDetails view={notChecked} summary={summarizeWeekendReadiness(notChecked)} />)).toContain("has not been verified yet");
    const failed = { ...notChecked, error: "Failed to load" };
    const html = renderToStaticMarkup(<WeekendDetails view={failed} summary={summarizeWeekendReadiness(failed)} />);
    expect(html).toContain("could not be verified");
    expect(html).not.toContain("found no room blockers");
  });
  it("keeps saved findings, timestamps, delivery state and date-specific links in the drawer", () => {
    const view: WeekendView = { ...notChecked, check: { id: "check", checkDate: "2026-09-09", status: "completed", lastError: null,
      delivery: { status: "sent", sentAt: "2026-09-09T02:00:00Z", kind: "warning" },
      report: { checkedAt: "2026-09-09T02:00:00Z", dates: ["2026-09-12", "2026-09-13"], readiness: "unverified", snapshotId: null, snapshotFinishedAt: null,
        days: [], findings: [{ date: "2026-09-12", kind: "unverified", message: "Teacher could not be resolved" }] } } };
    const html = renderToStaticMarkup(<WeekendDetails view={view} summary={summarizeWeekendReadiness(view)} />);
    expect(html).toContain("Teacher could not be resolved");
    expect(html).toContain("date=2026-09-13&amp;weekendCheck=check");
    expect(html).toContain("later booking changes");
    expect(html).toContain("Private notification: ");
    expect(html).not.toContain("@gmail.com");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navState = vi.hoisted(() => ({
  params: null as URLSearchParams | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => "/admissions/6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa"),
  useSearchParams: vi.fn(() => navState.params),
}));

import {
  CASE_TABS,
  CaseDetailShell,
  CaseDetailSkeleton,
  ProfileConflictBanner,
  buildProfileFormValues,
  canSubmitNote,
  formatDateOnly,
  parseAttendees,
  parseProfileConflict,
  resolveCaseTab,
  type ProfileFormValues,
} from "../case-detail-shell";
import type { CalendarItem } from "@/lib/admissions/calendar";
import type { AdmissionsTaskDto } from "@/lib/admissions/checklists";
import type {
  AdmissionsCaseDetail,
  AdmissionsMeetingDto,
  AdmissionsNoteDto,
} from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

const CASE_DETAIL: AdmissionsCaseDetail = {
  caseId: CASE_ID,
  status: "active",
  statusChangedAt: "2026-07-01T03:00:00.000Z",
  committedListItemId: null,
  committedCollegeName: null,
  driveFolder: null,
  student: {
    id: "11111111-1111-4111-8111-111111111111",
    fullName: "Ploy Srisuwan",
    preferredName: "Ploy",
    studentEmail: "ploy@example.com",
    phone: "+66 81 000 0000",
    school: "Bangkok Prep",
    schoolCounselor: null,
    wiseStudentKey: null,
    externalLinks: {},
  },
  cohort: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Class of 2027",
    graduationYear: 2027,
  },
  members: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      caseId: CASE_ID,
      email: "counselor.may@example.com",
      role: "counselor",
      status: "active",
      invitedAt: null,
      activatedAt: "2026-06-01T03:00:00.000Z",
      revokedAt: null,
      addedByEmail: "admin@example.com",
      createdAt: "2026-06-01T03:00:00.000Z",
      updatedAt: "2026-06-01T03:00:00.000Z",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      caseId: CASE_ID,
      email: "ploy@example.com",
      role: "student",
      status: "active",
      invitedAt: "2026-06-01T03:00:00.000Z",
      activatedAt: "2026-06-02T03:00:00.000Z",
      revokedAt: null,
      addedByEmail: "admin@example.com",
      createdAt: "2026-06-01T03:00:00.000Z",
      updatedAt: "2026-06-02T03:00:00.000Z",
    },
  ],
  collegeList: [],
  applicationWarnings: [],
  progress: { done: 0, total: 0, percent: 0, verifiedCount: 0 },
  progressPercent: 0,
  nextDeadline: null,
  upcomingDeadlines: [],
  announcements: [],
  lastMeetingDate: "2026-07-05",
  createdAt: "2026-06-01T03:00:00.000Z",
  updatedAt: "2026-07-05T03:00:00.000Z",
};

const MEETINGS: AdmissionsMeetingDto[] = [
  {
    id: "55555555-5555-4555-8555-555555555555",
    caseId: CASE_ID,
    meetingDate: "2026-07-05",
    mode: "Online",
    attendees: ["Ploy", "Counselor May"],
    notes: "Discussed the college research plan.",
    nextMeetingDate: "2026-07-19",
    createdAt: "2026-07-05T04:00:00.000Z",
    updatedAt: "2026-07-05T04:00:00.000Z",
  },
];

const NOTES: AdmissionsNoteDto[] = [
  {
    id: "66666666-6666-4666-8666-666666666666",
    caseId: CASE_ID,
    authorEmail: "counselor.may@example.com",
    body: "Family prefers ED at a reach school.",
    visibility: "staff_only",
    createdAt: "2026-07-04T04:00:00.000Z",
    updatedAt: "2026-07-04T04:00:00.000Z",
  },
  {
    id: "77777777-7777-4777-8777-777777777777",
    caseId: CASE_ID,
    authorEmail: "counselor.may@example.com",
    body: "Great progress on the activities list this week.",
    visibility: "shared_with_family",
    createdAt: "2026-07-03T04:00:00.000Z",
    updatedAt: "2026-07-03T04:00:00.000Z",
  },
];

function renderShell(overrides: {
  tab?: string | null;
  viewerRole?: "counselor" | "student" | "parent" | "admin";
  caseDetail?: AdmissionsCaseDetail;
  meetings?: AdmissionsMeetingDto[];
  notes?: AdmissionsNoteDto[];
  tasks?: AdmissionsTaskDto[];
  calendarItems?: CalendarItem[];
} = {}): string {
  navState.params = overrides.tab != null
    ? new URLSearchParams(`tab=${overrides.tab}`)
    : null;
  return renderToStaticMarkup(
    <CaseDetailShell
      caseDetail={overrides.caseDetail ?? CASE_DETAIL}
      meetings={overrides.meetings ?? MEETINGS}
      notes={overrides.notes ?? NOTES}
      tasks={overrides.tasks ?? []}
      calendarMonth="2026-07"
      calendarItems={overrides.calendarItems ?? []}
      recommenders={[]}
      collegeDocs={[]}
      applicationEvents={{}}
      viewerRole={overrides.viewerRole ?? "counselor"}
      viewerEmail="counselor.may@example.com"
    />,
  );
}

beforeEach(() => {
  navState.params = null;
});

// ── Pure helpers ────────────────────────────────────────────────────────

describe("resolveCaseTab", () => {
  it("defaults to overview when the param is missing", () => {
    expect(resolveCaseTab(null)).toBe("overview");
  });

  it("passes known tab keys through", () => {
    for (const tab of CASE_TABS) {
      expect(resolveCaseTab(tab.key)).toBe(tab.key);
    }
  });

  it("falls back to overview for unknown values (fail-closed)", () => {
    expect(resolveCaseTab("bogus")).toBe("overview");
    expect(resolveCaseTab("")).toBe("overview");
    expect(resolveCaseTab("NOTES")).toBe("overview");
  });
});

describe("canSubmitNote", () => {
  it("blocks submit when no visibility has been chosen", () => {
    expect(canSubmitNote("A perfectly good note", null)).toBe(false);
  });

  it("blocks submit when the body is blank", () => {
    expect(canSubmitNote("", "staff_only")).toBe(false);
    expect(canSubmitNote("   ", "shared_with_family")).toBe(false);
  });

  it("allows submit only with body AND explicit visibility", () => {
    expect(canSubmitNote("A note", "staff_only")).toBe(true);
    expect(canSubmitNote("A note", "shared_with_family")).toBe(true);
  });
});

describe("formatDateOnly / parseAttendees", () => {
  it("formats YYYY-MM-DD as D/M/YYYY", () => {
    expect(formatDateOnly("2026-07-05")).toBe("5/7/2026");
    expect(formatDateOnly("2026-12-25")).toBe("25/12/2026");
  });

  it("passes non-date strings through unchanged", () => {
    expect(formatDateOnly("not-a-date")).toBe("not-a-date");
  });

  it("parses comma-separated attendees, dropping blanks", () => {
    expect(parseAttendees("Ploy, Counselor May,, ")).toEqual(["Ploy", "Counselor May"]);
    expect(parseAttendees("")).toEqual([]);
  });
});

describe("parseProfileConflict", () => {
  const YOURS: ProfileFormValues = {
    fullName: "Ploy S.",
    preferredName: "Ploy",
    phone: "+66 81 000 0000",
    school: "Bangkok Prep",
    schoolCounselor: "",
    wiseStudentKey: "",
  };

  it("extracts the current student version and updatedAt from a 409 payload", () => {
    const conflict = parseProfileConflict(
      {
        error: "Conflict",
        current: {
          updatedAt: "2026-07-06T03:00:00.000Z",
          student: {
            fullName: "Ploy Srisuwan",
            preferredName: "Ploy",
            phone: "+66 81 999 9999",
            school: "Bangkok Prep",
            schoolCounselor: null,
            wiseStudentKey: null,
          },
        },
      },
      YOURS,
    );
    expect(conflict.yourVersion).toEqual(YOURS);
    expect(conflict.currentUpdatedAt).toBe("2026-07-06T03:00:00.000Z");
    expect(conflict.currentVersion).toEqual({
      fullName: "Ploy Srisuwan",
      preferredName: "Ploy",
      phone: "+66 81 999 9999",
      school: "Bangkok Prep",
      schoolCounselor: "",
      wiseStudentKey: "",
    });
  });

  it("returns a null currentVersion for malformed payloads (never guesses)", () => {
    expect(parseProfileConflict(null, YOURS).currentVersion).toBeNull();
    expect(parseProfileConflict({ error: "Conflict" }, YOURS).currentVersion).toBeNull();
    expect(
      parseProfileConflict({ current: "not-an-object" }, YOURS).currentVersion,
    ).toBeNull();
    expect(parseProfileConflict({ current: {} }, YOURS).currentUpdatedAt).toBeNull();
  });
});

describe("buildProfileFormValues", () => {
  it("maps nulls to empty strings", () => {
    const values = buildProfileFormValues(CASE_DETAIL.student);
    expect(values).toEqual({
      fullName: "Ploy Srisuwan",
      preferredName: "Ploy",
      phone: "+66 81 000 0000",
      school: "Bangkok Prep",
      schoolCounselor: "",
      wiseStudentKey: "",
    });
  });
});

// ── Shell rendering ─────────────────────────────────────────────────────

describe("CaseDetailShell header + tabs", () => {
  it("renders the sticky header and all 10 tabs", () => {
    const html = renderShell();
    expect(html).toContain("Ploy Srisuwan (Ploy)");
    expect(html).toContain("Class of 2027");
    expect(html).toContain("Active");
    expect(html).toContain("counselor.may@example.com");
    for (const tab of CASE_TABS) {
      expect(html).toContain(`>${tab.label}</button>`);
    }
    expect(html).toContain('role="tablist"');
    expect(CASE_TABS).toHaveLength(10);
  });

  it("marks the URL-selected tab as active and renders its panel", () => {
    const html = renderShell({ tab: "meetings" });
    const meetingsTab = html.match(/<button[^>]*id="case-tab-meetings"[^>]*>/);
    expect(meetingsTab).not.toBeNull();
    expect(meetingsTab![0]).toContain('aria-selected="true"');
    expect(html).toContain('id="case-panel-meetings"');
  });

  it("defaults to the overview panel for unknown tab params", () => {
    const html = renderShell({ tab: "bogus" });
    expect(html).toContain('id="case-panel-overview"');
    expect(html).toContain("Upcoming deadlines");
    expect(html).toContain("Recent notes");
    expect(html).toContain("Last meeting");
  });
});

describe("CaseDetailShell overview deadlines + calendar", () => {
  const DEADLINE_DETAIL: AdmissionsCaseDetail = {
    ...CASE_DETAIL,
    nextDeadline: "2026-07-02",
    upcomingDeadlines: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        caseId: CASE_ID,
        source: "task",
        title: "Submit FAFSA draft",
        date: "2026-07-02",
        overdue: true,
        ownerRole: "student",
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        caseId: CASE_ID,
        source: "task",
        title: "Essay outline",
        date: "2026-07-20",
        overdue: false,
        ownerRole: "student",
      },
    ],
  };

  it("lists upcoming deadlines with overdue flagged in red", () => {
    const html = renderShell({ caseDetail: DEADLINE_DETAIL });
    const items = html.match(/data-testid="upcoming-deadline"/g) ?? [];
    expect(items).toHaveLength(2);
    expect(html).toContain("Submit FAFSA draft");
    expect(html).toContain("2/7/2026 · Overdue");
    expect(html).toContain("text-conflict");
    expect(html).toContain("20/7/2026");
  });

  it("renders an empty state and no phase-2 stub copy without deadlines", () => {
    const html = renderShell();
    expect(html).toContain("No open deadlines");
    expect(html).not.toContain("appear here from phase 2");
  });

  it("offers the calendar toggle to staff and students but not parents", () => {
    expect(renderShell({ viewerRole: "counselor" })).toContain(
      'data-testid="calendar-toggle"',
    );
    expect(renderShell({ viewerRole: "student" })).toContain(
      'data-testid="calendar-toggle"',
    );
    expect(renderShell({ viewerRole: "parent" })).not.toContain(
      'data-testid="calendar-toggle"',
    );
  });

  it("keeps the month grid collapsed until toggled", () => {
    // Static render = initial state; the CalendarTab sub-view mounts only
    // after the toggle flips showCalendar.
    const html = renderShell();
    expect(html).not.toContain('data-testid="calendar-tab"');
  });
});

describe("CaseDetailShell overview announcements", () => {
  const ANNOUNCEMENT_DETAIL: AdmissionsCaseDetail = {
    ...CASE_DETAIL,
    announcements: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        cohortId: CASE_DETAIL.cohort.id,
        caseId: null,
        title: "Common App opens Friday",
        body: "Everyone should create an account this week.",
        authorEmail: "counselor.may@example.com",
        createdAt: "2026-07-05T03:00:00.000Z",
        updatedAt: "2026-07-05T03:00:00.000Z",
      },
    ],
  };

  it("renders the announcements panel with the composer for staff", () => {
    const html = renderShell({ caseDetail: ANNOUNCEMENT_DETAIL, viewerRole: "counselor" });
    expect(html).toContain('data-testid="announcements-panel"');
    expect(html).toContain("Common App opens Friday");
    expect(html).toContain("Cohort broadcast");
    expect(html).toContain('data-testid="announcement-submit"');
    expect(html).toContain("Whole cohort (Class of 2027)");
  });

  it("renders a read-only announcements list for family viewers", () => {
    const html = renderShell({ caseDetail: ANNOUNCEMENT_DETAIL, viewerRole: "parent" });
    expect(html).toContain("Common App opens Friday");
    expect(html).not.toContain('data-testid="announcement-submit"');
  });
});

describe("CaseDetailShell placeholder tabs", () => {
  it("renders the live checklist tab instead of a placeholder", () => {
    const html = renderShell({ tab: "checklist" });
    expect(html).not.toContain("Coming in phase 2");
    // Counselor viewers get the add-task action from the real checklist tab.
    expect(html).toContain('data-testid="checklist-add-task"');
  });

  it("renders the live colleges tab instead of a placeholder", () => {
    const html = renderShell({ tab: "colleges" });
    expect(html).not.toContain("Coming in phase 3");
    // The Colleges tab hosts the recommenders & documents panel.
    expect(html).toContain('data-testid="recommenders-panel"');
    expect(html).toContain('data-testid="add-college"');
  });

  it("renders the live applications tab instead of a placeholder", () => {
    const html = renderShell({ tab: "applications" });
    expect(html).not.toContain("Coming in phase 3");
    expect(html).toContain("Committed college");
  });

  it("renders structured coming-in-phase placeholders", () => {
    expect(renderShell({ tab: "essays" })).toContain("Coming in phase 4");
    expect(renderShell({ tab: "activities" })).toContain("Coming in phase 4");
    expect(renderShell({ tab: "testing" })).toContain("Coming in phase 4");
  });
});

describe("CaseDetailShell profile tab", () => {
  it("shows the edit button for staff viewers", () => {
    const html = renderShell({ tab: "profile", viewerRole: "counselor" });
    expect(html).toContain("Edit profile");
    expect(html).toContain("Bangkok Prep");
  });

  it("hides the edit button for family viewers", () => {
    const html = renderShell({ tab: "profile", viewerRole: "parent" });
    expect(html).not.toContain("Edit profile");
    expect(html).toContain("Bangkok Prep");
  });
});

describe("CaseDetailShell meetings tab", () => {
  it("shows the meeting log and the log-meeting action for staff", () => {
    const html = renderShell({ tab: "meetings", viewerRole: "counselor" });
    expect(html).toContain("Log meeting");
    expect(html).toContain("5/7/2026");
    expect(html).toContain("Discussed the college research plan.");
    expect(html).toContain("Attendees: Ploy, Counselor May");
  });

  it("shows a restricted message for family viewers", () => {
    const html = renderShell({ tab: "meetings", viewerRole: "student", meetings: [] });
    expect(html).toContain("visible to counselors and admins only");
    expect(html).not.toContain("Log meeting");
  });
});

describe("CaseDetailShell notes tab", () => {
  it("renders the composer with NO preselected visibility and a disabled submit", () => {
    const html = renderShell({ tab: "notes", viewerRole: "counselor" });
    expect(html).toContain("Staff only");
    expect(html).toContain("Shared with family");
    // Neither radio is checked — the author must choose explicitly.
    expect(html).not.toContain('checked=""');
    // Submit is blocked until body + visibility are provided.
    const submit = html.match(/<button[^>]*data-testid="note-submit"[^>]*>/);
    expect(submit).not.toBeNull();
    expect(submit![0]).toContain("disabled");
  });

  it("badges staff_only rows and hides the composer for family viewers", () => {
    const staffHtml = renderShell({ tab: "notes", viewerRole: "counselor" });
    expect(staffHtml).toContain("Family prefers ED at a reach school.");
    expect(staffHtml).toContain("Staff only");

    const familyHtml = renderShell({
      tab: "notes",
      viewerRole: "parent",
      notes: NOTES.filter((note) => note.visibility === "shared_with_family"),
    });
    expect(familyHtml).not.toContain("Add a note");
    expect(familyHtml).not.toContain('data-testid="note-submit"');
    expect(familyHtml).toContain("Great progress on the activities list this week.");
  });
});

describe("ProfileConflictBanner", () => {
  const YOURS: ProfileFormValues = {
    fullName: "Ploy S.",
    preferredName: "Ploy",
    phone: "+66 81 000 0000",
    school: "Bangkok Prep",
    schoolCounselor: "",
    wiseStudentKey: "",
  };
  const LATEST: ProfileFormValues = {
    fullName: "Ploy Srisuwan",
    preferredName: "Ploy",
    phone: "+66 81 999 9999",
    school: "Bangkok Prep",
    schoolCounselor: "",
    wiseStudentKey: "",
  };

  it("renders both versions side by side on a 409", () => {
    const html = renderToStaticMarkup(
      <ProfileConflictBanner
        conflict={{
          yourVersion: YOURS,
          currentVersion: LATEST,
          currentUpdatedAt: "2026-07-06T03:00:00.000Z",
        }}
        onUseLatest={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("Edit conflict");
    expect(html).toContain("Your version");
    expect(html).toContain("Latest version");
    expect(html).toContain("Ploy S.");
    expect(html).toContain("Ploy Srisuwan");
    expect(html).toContain("+66 81 000 0000");
    expect(html).toContain("+66 81 999 9999");
    expect(html).toContain("Use latest version");
    expect(html).toContain("Keep my edits");
  });

  it("falls back to a reload message when the latest version is unavailable", () => {
    const html = renderToStaticMarkup(
      <ProfileConflictBanner
        conflict={{ yourVersion: YOURS, currentVersion: null, currentUpdatedAt: null }}
        onUseLatest={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("Edit conflict");
    expect(html).toContain("reload the page to compare");
    expect(html).not.toContain("Use latest version");
  });
});

describe("CaseDetailSkeleton", () => {
  it("renders a tab-shaped skeleton", () => {
    const html = renderToStaticMarkup(<CaseDetailSkeleton />);
    expect(html).toContain("animate-pulse");
  });
});

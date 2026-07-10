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
  MORE_SUBVIEWS,
  STUDENT_VIEWS,
  StudentPortalShell,
  THIS_WEEK_DISPLAY_LIMIT,
  resolveActionDestination,
  resolveActionView,
  resolveMoreSubView,
  resolveStudentView,
} from "../portal-shell";
import type { AdmissionsTaskDto } from "@/lib/admissions/checklists";
import type { AdmissionsCollegeListRowDto } from "@/lib/admissions/colleges";
import type { AdmissionsEssayListRowDto } from "@/lib/admissions/essays";
import {
  getSectionDefinition,
  type AdmissionsSectionStateDto,
} from "@/lib/admissions/sections";
import type { AdmissionsResourceTopicGroup } from "@/lib/admissions/resources";
import type { ThisWeekAction } from "@/lib/admissions/student-home";
import type { AdmissionsBestScore } from "@/lib/admissions/testing";
import type { AdmissionsStudentCaseDetail, CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

// Six actions: one overdue task first, then five more — the shell must cap
// the rendered list at THIS_WEEK_DISPLAY_LIMIT (5) and drop the sixth.
const THIS_WEEK: ThisWeekAction[] = [
  {
    kind: "task",
    title: "Submit the transcript request",
    dueDate: "2026-07-01",
    overdue: true,
    anchor: "task:11111111-aaaa-4aaa-8aaa-111111111111",
  },
  {
    kind: "application",
    title: "Harvard University — REA deadline",
    dueDate: "2026-07-10",
    overdue: false,
    anchor: "application:22222222-bbbb-4bbb-8bbb-222222222222",
  },
  {
    kind: "essay",
    title: "Update essay: Personal statement",
    dueDate: "2026-07-12",
    overdue: false,
    anchor: "essay:33333333-cccc-4ccc-8ccc-333333333333",
  },
  {
    kind: "testing",
    title: "SAT registration closes",
    dueDate: "2026-07-13",
    overdue: false,
    anchor: "testing:44444444-dddd-4ddd-8ddd-444444444444",
  },
  {
    kind: "section",
    title: "Complete section: About You",
    dueDate: null,
    overdue: false,
    anchor: "section:about_you",
  },
  {
    kind: "section",
    title: "Complete section: Personality",
    dueDate: null,
    overdue: false,
    anchor: "section:personality",
  },
];

const COLLEGE_ROW: AdmissionsCollegeListRowDto = {
  id: "55555555-5555-4555-8555-555555555555",
  caseId: CASE_ID,
  unitId: 166027,
  instName: "Harvard University",
  city: "Cambridge",
  stateAbbr: "MA",
  country: "USA",
  isManual: false,
  round: "rea",
  deadline: "2026-11-01",
  appStatus: "researching",
  category: "reach",
  firstChoiceMajor: null,
  secondChoiceMajor: null,
  admissionsUrl: null,
  portalUrl: null,
  aidOffered: null,
  aidNotes: null,
  createdAt: "2026-06-01T03:00:00.000Z",
  updatedAt: "2026-06-01T03:00:00.000Z",
  stats: null,
  stale: false,
  completeness: null,
};

const CASE_DETAIL: AdmissionsStudentCaseDetail = {
  caseId: CASE_ID,
  status: "active",
  driveFolder: "https://drive.google.com/drive/folders/abc",
  updatedAt: "2026-07-05T03:00:00.000Z",
  student: {
    fullName: "Ploy Srisuwan",
    preferredName: "Ploy",
    studentEmail: "ploy@example.com",
    phone: null,
    school: "Bangkok Prep",
    schoolCounselor: null,
    externalLinks: {},
  },
  cohort: {
    name: "Class of 2027",
    graduationYear: 2027,
  },
  counselors: [{ email: "counselor.may@example.com" }],
  collegeList: [COLLEGE_ROW],
  announcements: [
    {
      id: "66666666-6666-4666-8666-666666666666",
      cohortId: "22222222-2222-4222-8222-222222222222",
      caseId: null,
      title: "Common App opens August 1",
      body: "Get your account ready before the season starts.",
      authorEmail: "counselor.may@example.com",
      createdAt: "2026-07-01T03:00:00.000Z",
      updatedAt: "2026-07-01T03:00:00.000Z",
    },
  ],
  essays: [],
  activities: [],
  testSittings: [
    {
      id: "77777777-7777-4777-8777-777777777777",
      caseId: CASE_ID,
      testType: "sat",
      testDate: "2026-10-03",
      registrationDeadline: "2026-08-29",
      targetScore: "1500",
      actualScore: null,
      scoreReleasedToParent: false,
      accommodations: null,
      createdAt: "2026-06-01T03:00:00.000Z",
      updatedAt: "2026-06-01T03:00:00.000Z",
    },
  ],
  thisWeek: THIS_WEEK,
  phaseProgress: [
    {
      phase: "about_you",
      label: "About You",
      done: 2,
      total: 4,
      percent: 50,
      verifiedCount: 1,
    },
    {
      phase: "essays",
      label: "Essays",
      done: 0,
      total: 6,
      percent: 0,
      verifiedCount: 0,
    },
  ],
};

const BEST_SCORES: AdmissionsBestScore[] = [
  {
    testType: "sat",
    sittingId: "77777777-7777-4777-8777-777777777777",
    testDate: "2026-10-03",
    actualScore: "1480",
    numericScore: 1480,
    scoreReleasedToParent: false,
  },
];

const SECTION_STATES: AdmissionsSectionStateDto[] = [
  {
    caseId: CASE_ID,
    sectionKey: "about_you",
    definition: getSectionDefinition("about_you")!,
    payload: {},
    state: "draft",
    submittedAt: null,
    reviewedByEmail: null,
    updatedAt: null,
  },
];

const RESOURCE_GROUPS: AdmissionsResourceTopicGroup[] = [
  {
    topic: "essays",
    label: "Essays",
    resources: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        topic: "essays",
        title: "College Essay Guy",
        url: "https://www.collegeessayguy.com",
        sortOrder: 0,
        createdAt: "2026-07-01T03:00:00.000Z",
        updatedAt: "2026-07-01T03:00:00.000Z",
      },
    ],
  },
];

const ESSAY_ROW: AdmissionsEssayListRowDto = {
  id: "99999999-9999-4999-8999-999999999999",
  caseId: CASE_ID,
  listItemId: null,
  prompt: "Personal statement",
  status: "drafting",
  counselorStage: null,
  deadline: null,
  driveUrl: null,
  lastStudentUpdateAt: null,
  createdAt: "2026-07-01T03:00:00.000Z",
  updatedAt: "2026-07-01T03:00:00.000Z",
  stalenessDays: null,
  effectiveStage: "drafting",
};

function makeTask(
  overrides: Partial<AdmissionsTaskDto> & { id: string },
): AdmissionsTaskDto {
  return {
    caseId: CASE_ID,
    templateId: "88888888-8888-4888-8888-888888888888",
    templateVersion: 1,
    itemKey: "template_item",
    phase: "about_you",
    title: "Task",
    description: null,
    owner: "student",
    status: "not_started",
    dueDate: null,
    verifiedByEmail: null,
    verifiedAt: null,
    recurrence: null,
    sortOrder: 0,
    createdAt: "2026-07-01T03:00:00.000Z",
    updatedAt: "2026-07-01T03:00:00.000Z",
    ...overrides,
  };
}

const STUDENT_TASK = makeTask({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  itemKey: "complete_intake_questionnaire",
  title: "Complete the intake questionnaire",
  owner: "student",
});

const COUNSELOR_TASK = makeTask({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  itemKey: "record_current_transcript",
  phase: "academics",
  title: "Record the current transcript",
  owner: "counselor",
  dueDate: "2000-01-01",
});

function renderShell(overrides: {
  view?: string | null;
  sub?: string | null;
  tasks?: AdmissionsTaskDto[];
  caseDetail?: AdmissionsStudentCaseDetail;
  viewerRole?: CaseRole;
} = {}): string {
  const params = new URLSearchParams();
  if (overrides.view != null) params.set("view", overrides.view);
  if (overrides.sub != null) params.set("sub", overrides.sub);
  navState.params = params.toString() ? params : null;
  return renderToStaticMarkup(
    <StudentPortalShell
      caseDetail={overrides.caseDetail ?? CASE_DETAIL}
      tasks={overrides.tasks ?? [STUDENT_TASK, COUNSELOR_TASK]}
      bestScores={BEST_SCORES}
      sectionStates={SECTION_STATES}
      resourceGroups={RESOURCE_GROUPS}
      viewerRole={overrides.viewerRole ?? "student"}
      viewerEmail="ploy@example.com"
    />,
  );
}

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function findCheckbox(html: string, taskId: string): string {
  const match = html.match(
    new RegExp(`<input[^>]*data-testid="task-checkbox-${taskId}"[^>]*>`),
  );
  expect(match).not.toBeNull();
  return match![0];
}

beforeEach(() => {
  navState.params = null;
});

// ── Pure helpers ────────────────────────────────────────────────────────

describe("resolveStudentView", () => {
  it("defaults to home when the param is missing", () => {
    expect(resolveStudentView(null)).toBe("home");
  });

  it("passes known view keys through", () => {
    for (const view of STUDENT_VIEWS) {
      expect(resolveStudentView(view.key)).toBe(view.key);
    }
  });

  it("falls back to home for unknown values (fail-closed)", () => {
    expect(resolveStudentView("bogus")).toBe("home");
    expect(resolveStudentView("")).toBe("home");
    expect(resolveStudentView("TASKS")).toBe("home");
  });
});

describe("resolveActionView", () => {
  it("routes every action kind to its owning view", () => {
    expect(resolveActionView("task")).toBe("tasks");
    expect(resolveActionView("application")).toBe("colleges");
    expect(resolveActionView("essay")).toBe("essays");
    expect(resolveActionView("testing")).toBe("more");
    expect(resolveActionView("section")).toBe("more");
  });

  it("deep-links testing and sections to their exact More sub-view", () => {
    expect(
      resolveActionDestination(
        "testing",
        "testing:44444444-dddd-4ddd-8ddd-444444444444",
      ),
    ).toEqual({
      view: "more",
      sub: "testing",
      item: "44444444-dddd-4ddd-8ddd-444444444444",
    });
    expect(resolveActionDestination("section", "section:about_you")).toEqual({
      view: "more",
      sub: "sections",
      item: "about_you",
    });
  });
});

describe("resolveMoreSubView", () => {
  it("passes known sub-view keys through", () => {
    expect(MORE_SUBVIEWS).toHaveLength(7);
    for (const entry of MORE_SUBVIEWS) {
      expect(resolveMoreSubView(entry.key)).toBe(entry.key);
    }
  });

  it("returns null (the stacked menu) for unknown or missing values", () => {
    expect(resolveMoreSubView(null)).toBeNull();
    expect(resolveMoreSubView("")).toBeNull();
    expect(resolveMoreSubView("bogus")).toBeNull();
    expect(resolveMoreSubView("TESTING")).toBeNull();
  });
});

// ── Bottom nav ──────────────────────────────────────────────────────────

describe("StudentPortalShell bottom nav", () => {
  it("renders all 5 nav items with labels and icons", () => {
    const html = renderShell();
    expect(STUDENT_VIEWS).toHaveLength(5);
    for (const view of STUDENT_VIEWS) {
      expect(html).toContain(`data-testid="student-nav-${view.key}"`);
      expect(html).toContain(`aria-label="${view.label}"`);
    }
  });

  it("marks Home active by default (aria-current)", () => {
    const html = renderShell();
    expect(countOccurrences(html, 'aria-current="page"')).toBe(1);
    const homeButton = html.match(
      /<button[^>]*data-testid="student-nav-home"[^>]*>/,
    );
    expect(homeButton).not.toBeNull();
    expect(homeButton![0]).toContain('aria-current="page"');
  });

  it("marks the ?view= view active and falls back to home for unknown views", () => {
    const tasksHtml = renderShell({ view: "tasks" });
    const tasksButton = tasksHtml.match(
      /<button[^>]*data-testid="student-nav-tasks"[^>]*>/,
    );
    expect(tasksButton![0]).toContain('aria-current="page"');

    const bogusHtml = renderShell({ view: "bogus" });
    const homeButton = bogusHtml.match(
      /<button[^>]*data-testid="student-nav-home"[^>]*>/,
    );
    expect(homeButton![0]).toContain('aria-current="page"');
  });
});

// ── Home view ───────────────────────────────────────────────────────────

describe("StudentPortalShell home view", () => {
  it("caps This Week at 5 actions and drops the sixth", () => {
    const html = renderShell();
    expect(THIS_WEEK).toHaveLength(THIS_WEEK_DISPLAY_LIMIT + 1);
    expect(countOccurrences(html, 'data-testid="this-week-action"')).toBe(
      THIS_WEEK_DISPLAY_LIMIT,
    );
    expect(html).toContain("Submit the transcript request");
    expect(html).toContain("Complete section: About You");
    expect(html).not.toContain("Complete section: Personality");
  });

  it("styles overdue actions red with an Overdue marker", () => {
    const html = renderShell();
    expect(html).toContain("1/7/2026 · Overdue");
    expect(html).toContain("text-conflict");
  });

  it("renders season-relevant phase rings and read-only announcements", () => {
    const html = renderShell();
    expect(countOccurrences(html, 'data-testid="phase-ring"')).toBe(2);
    expect(html).toContain("About You: 50% done");
    expect(html).toContain("Essays: 0% done");
    expect(html).toContain("Common App opens August 1");
    // Read-only: no announcement composer.
    expect(html).not.toContain("New announcement");
    expect(html).not.toContain("Post announcement");
  });

  it("shows an empty state when nothing is due", () => {
    const html = renderShell({
      caseDetail: { ...CASE_DETAIL, thisWeek: [], phaseProgress: [], announcements: [] },
    });
    expect(html).toContain("Nothing due this week");
    expect(html).toContain("No announcements yet.");
    expect(countOccurrences(html, 'data-testid="phase-ring"')).toBe(0);
  });
});

// ── Tasks view ──────────────────────────────────────────────────────────

describe("StudentPortalShell tasks view", () => {
  it("enables checkboxes only on student-owned tasks (CM-22)", () => {
    const html = renderShell({ view: "tasks" });
    expect(findCheckbox(html, STUDENT_TASK.id)).not.toContain("disabled");
    expect(findCheckbox(html, COUNSELOR_TASK.id)).toContain("disabled");
    expect(html).toContain("Counselor task");
  });

  it("groups tasks by phase with due chips and overdue styling", () => {
    const html = renderShell({ view: "tasks" });
    expect(html).toContain("About You");
    expect(html).toContain("Academics");
    expect(html).toContain("Due 1/1/2000 · Overdue");
  });

  it("shows no staff-only checklist affordances", () => {
    const html = renderShell({ view: "tasks" });
    expect(html).not.toContain("Add task");
    expect(html).not.toContain("Verify");
    expect(html).not.toContain("Delete task");
  });
});

// ── Colleges view (read-only) ───────────────────────────────────────────

describe("StudentPortalShell colleges view", () => {
  it("lists colleges with round, deadline, and status chips", () => {
    const html = renderShell({ view: "colleges" });
    expect(countOccurrences(html, 'data-testid="college-row"')).toBe(1);
    expect(html).toContain("Harvard University");
    expect(html).toContain("Cambridge, MA");
    expect(html).toContain("REA");
    expect(html).toContain("Due 1/11/2026");
    expect(html).toContain("Researching");
  });

  it("keeps list composition counselor-only while exposing student-owned research", () => {
    const html = renderShell({ view: "colleges" });
    expect(html).toContain('data-testid="college-details-panel"');
    expect(html).toContain("Save research");
    expect(html).toContain("Add event");
    expect(html).not.toContain("Add requirement");
    expect(html).not.toContain("Add college");
    expect(html).not.toContain("Remove college");
  });

  it("shows an empty state when the list is empty", () => {
    const html = renderShell({
      view: "colleges",
      caseDetail: { ...CASE_DETAIL, collegeList: [] },
    });
    expect(html).toContain("No colleges on your list yet");
  });
});

// ── Staff-surface isolation ─────────────────────────────────────────────

describe("StudentPortalShell staff-surface isolation", () => {
  it("never renders staff-only surfaces on any view or sub-view", () => {
    const surfaces: { view: string; sub?: string }[] = [
      ...STUDENT_VIEWS.map((view) => ({ view: view.key })),
      ...MORE_SUBVIEWS.map((entry) => ({ view: "more", sub: entry.key })),
    ];
    for (const surface of surfaces) {
      const html = renderShell({ view: surface.view, sub: surface.sub });
      // Notes composer (staff shell "Add a note" / "Post note").
      expect(html).not.toContain("Add a note");
      expect(html).not.toContain("Post note");
      // Meeting log + member management + staff profile dialog.
      expect(html).not.toContain("Log meeting");
      expect(html).not.toContain("Edit profile");
      expect(html).not.toContain("Invite");
      expect(html).not.toContain("Revoke");
      expect(html).not.toContain("Staff only");
    }
  });
});

// ── More view + sub-views ───────────────────────────────────────────────

describe("StudentPortalShell more view", () => {
  it("shows the stacked sub-view menu plus case info, links, and sign-out", () => {
    const html = renderShell({ view: "more" });
    for (const entry of MORE_SUBVIEWS) {
      expect(html).toContain(`data-testid="more-menu-${entry.key}"`);
      expect(html).toContain(entry.label.replace("&", "&amp;"));
    }
    expect(html).toContain("Ploy Srisuwan");
    expect(html).toContain('data-testid="student-profile-editor"');
    expect(html).toContain("Save profile");
    expect(html).toContain("counselor.may@example.com");
    expect(html).toContain("https://drive.google.com/drive/folders/abc");
    expect(html).toContain("Sign out");
    expect(html).toContain("/api/auth/signout");
  });

  it("keeps the menu for unknown sub params (fail-closed)", () => {
    const html = renderShell({ view: "more", sub: "bogus" });
    expect(html).toContain('data-testid="more-menu-activities"');
    expect(html).not.toContain('data-testid="more-back"');
  });
});

describe("StudentPortalShell more sub-views", () => {
  it("opens Activities full-screen (portal variant) with a back affordance", () => {
    const html = renderShell({ view: "more", sub: "activities" });
    expect(html).toContain('data-testid="more-back"');
    expect(html).toContain('data-variant="portal"');
    expect(html).toContain('data-testid="activities-cap"');
    // The menu is replaced by the sub-view.
    expect(html).not.toContain('data-testid="more-menu-activities"');
  });

  it("opens Testing full-screen on the student variant (no release toggle)", () => {
    const html = renderShell({ view: "more", sub: "testing" });
    expect(html).toContain('data-testid="more-back"');
    expect(html).toContain('data-testid="testing-view"');
    expect(html).toContain('data-testid="best-score-sat"');
    expect(countOccurrences(html, 'data-testid="sitting-row"')).toBe(1);
    // CM-83 release-to-parent is staff-only — never on the student variant.
    expect(html).not.toContain("release-toggle");
  });

  it("opens the self-report sections list full-screen", () => {
    const html = renderShell({ view: "more", sub: "sections" });
    expect(html).toContain('data-testid="more-back"');
    expect(html).toContain('data-testid="sections-list"');
    expect(html).toContain('data-testid="section-card-about_you"');
  });

  it("opens the resource library full-screen as a read-only link list (CM-92)", () => {
    const html = renderShell({ view: "more", sub: "resources" });
    expect(html).toContain('data-testid="more-back"');
    expect(html).toContain('data-testid="resources-panel"');
    expect(html).toContain('data-testid="resource-group-essays"');
    expect(html).toContain('href="https://www.collegeessayguy.com"');
    // Student viewers never see the staff manage affordances.
    expect(html).not.toContain('data-testid="resource-add-form"');
    expect(html).not.toContain("Add resource");
    expect(html).not.toContain("Delete");
  });

  it("ignores sub params outside the More view (fail-closed)", () => {
    const html = renderShell({ view: "tasks", sub: "testing" });
    expect(html).not.toContain('data-testid="testing-view"');
    expect(html).not.toContain('data-testid="more-back"');
  });
});

// ── Essays view (shared EssaysView, student variant) ────────────────────

describe("StudentPortalShell essays view", () => {
  it("renders the live student essay tracker with the add action", () => {
    const html = renderShell({ view: "essays" });
    expect(html).toContain('data-testid="add-essay"');
    expect(html).toContain(
      "No essays yet — add your first prompt to start tracking.",
    );
  });

  it("renders essay rows as student cards with the status select", () => {
    const html = renderShell({
      view: "essays",
      caseDetail: { ...CASE_DETAIL, essays: [ESSAY_ROW] },
    });
    expect(countOccurrences(html, 'data-testid="essay-row"')).toBe(1);
    expect(html).toContain("Personal statement");
    expect(html).toContain('data-testid="essay-staleness"');
    expect(html).toContain("Never updated");
    expect(html).toContain('aria-label="Status for Personal statement"');
  });
});

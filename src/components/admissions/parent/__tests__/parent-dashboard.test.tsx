import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/room-capacity/dates", () => ({ todayBangkok: vi.fn(() => "2026-07-08") }));

import {
  PARENT_SECTION_TEST_IDS,
  ParentDashboardView,
  groupParentDeadlinesByWeek,
} from "../parent-dashboard";
import {
  PARENT_APP_STATUS_STRINGS,
  PARENT_CASE_STATUS_STRINGS,
  PARENT_DEADLINE_SOURCE_STRINGS,
  PARENT_DECISION_STRINGS,
  PARENT_ESSAY_STATUS_STRINGS,
  PARENT_LOCALE_STORAGE_KEY,
  PARENT_RECOMMENDER_STATUS_STRINGS,
  PARENT_SCHOLARSHIP_STATUS_STRINGS,
  PARENT_STRINGS,
  PARENT_TASK_OWNER_STRINGS,
  PARENT_TASK_STATUS_STRINGS,
  PARENT_TEST_STATUS_STRINGS,
  PARENT_TEST_TYPE_STRINGS,
  formatParentString,
  pickParentString,
  readStoredParentLocale,
  resolveParentLocale,
  writeStoredParentLocale,
  type ParentBilingualString,
} from "../strings";
import type { LinkedFamilyCase } from "@/lib/admissions/family-cases";
import type { ParentDashboard, ParentDeadline } from "@/lib/admissions/parent-projection";

const CURRENT_HREF = "/admissions/11111111-1111-4111-8111-111111111111";
const LINKED_CASES: LinkedFamilyCase[] = [
  {
    href: CURRENT_HREF,
    studentName: "Ploy Srisuwan",
    preferredName: "Ploy",
    cohortName: "Class of 2027",
    caseStatus: "active",
  },
  {
    href: "/admissions/22222222-2222-4222-8222-222222222222",
    studentName: "Pat Srisuwan",
    preferredName: "Pat",
    cohortName: "Class of 2029",
    caseStatus: "completed",
  },
];

const DASHBOARD: ParentDashboard = {
  studentName: "Ploy Srisuwan",
  cohortName: "Class of 2027",
  caseStatus: "active",
  profile: {
    preferredName: "Ploy",
    phone: "+66 81 234 5678",
    school: "Bangkok International School",
    schoolCounselor: "Ms. Chen",
    graduationYear: 2027,
    sharedDetails: [
      { key: "hometown", label: "Hometown", value: "Bangkok, Thailand" },
      { key: "languages", label: "Languages", value: ["Thai", "English"] },
    ],
  },
  academics: [{
    system: "us",
    effectiveDate: "2026-06-01",
    payload: {
      system: "us",
      gpaScale: 4,
      unweightedGpa: 3.8,
      weightedGpa: 4.2,
      classRank: 5,
      classSize: 120,
      courseRigor: "most_demanding",
      fourYearCoursePlan: [{
        gradeLevel: "11",
        courseTitle: "AP Biology",
        level: "AP",
        finalGrade: "A",
      }],
      transcriptUrl: "https://drive.google.com/transcript",
      schoolProfileUrl: null,
    },
  }],
  progress: { done: 3, total: 8, percent: 38 },
  phaseProgress: [
    { phase: "about_you", label: "About You", done: 2, total: 4, percent: 50 },
    { phase: "essays", label: "Essays", done: 0, total: 6, percent: 0 },
  ],
  checklist: [{
    phase: "applications",
    title: "Submit the Common App",
    description: "Review each answer before submitting.",
    owner: "student",
    status: "in_progress",
    dueDate: "2026-11-01",
    recurrence: null,
  }],
  collegeList: [{
    instName: "Brown University",
    round: "ed",
    roundLabel: "ED",
    appStatus: "applying",
    deadline: "2026-11-01",
    category: "reach",
    firstChoiceMajor: "Public Health",
    secondChoiceMajor: "Economics",
    admissionsUrl: "https://admission.brown.edu",
    portalUrl: "https://apply.college.example/login",
    completeness: {
      recsAgreed: 1,
      recsSubmitted: 1,
      recsTotal: 1,
      transcriptSent: true,
      schoolReportSent: false,
      scoreSendsSent: 1,
      complete: false,
    },
    decisions: [{ event: "accepted", eventDate: "2027-03-20" }],
    requirements: [{
      kind: "css_profile",
      title: "Submit CSS Profile",
      status: "in_progress",
      owner: "student",
      dueDate: "2026-11-01",
      required: true,
      sourceUrl: "https://cssprofile.collegeboard.org",
    }],
  }],
  recommenders: [{
    name: "Dr. Rivera",
    roleSubject: "Biology",
    askStatus: "agreed",
    colleges: [{ collegeName: "Brown University", submitted: true, submittedAt: "2026-10-20T00:00:00.000Z" }],
  }],
  essays: [{
    collegeName: "Brown University",
    prompt: "Why Brown?",
    status: "drafting",
    deadline: "2026-11-01",
    googleDocUrl: "https://docs.google.com/shared-essay",
  }],
  activities: [{
    name: "Robotics Club",
    fullDescription: "Led a team of five students.",
    commonApp: null,
    uc: null,
    commonAppRank: 1,
  }],
  awards: [{
    title: "National Biology Olympiad Finalist",
    organization: "Biology Society",
    gradeLevels: ["11"],
    recognitionLevels: ["national"],
    awardDate: "2026-04-01",
    commonAppRank: 1,
    ucEligibilityNarrative: "Top students were invited.",
    ucAchievementNarrative: "Placed in the national final.",
  }],
  upcomingDeadlines: [
    { source: "task", title: "Submit transcript request", date: "2026-07-01", overdue: true },
    { source: "essay", title: "Update personal statement", date: "2026-07-09", overdue: false },
    { source: "application", title: "Brown ED deadline", date: "2026-07-13", overdue: false },
    { source: "testing", title: "SAT registration closes", date: "2026-07-21", overdue: false },
  ],
  announcements: [{
    title: "Common App opens August 1",
    body: "Get your account ready before the season starts.",
    createdAt: "2026-07-01T03:00:00.000Z",
  }],
  testingMilestones: [{
    testType: "sat",
    subject: null,
    testDate: "2026-06-06",
    registrationDeadline: "2026-05-01",
    lateRegistrationDeadline: "2026-05-15",
    status: "score_received",
    registered: true,
    taken: true,
    scoreReceived: true,
    score: 1450,
    scoreDetails: { testType: "sat", math: 740, readingWriting: 710, total: 1450 },
  }, {
    testType: "ielts",
    subject: null,
    testDate: "2026-10-03",
    registrationDeadline: "2026-09-19",
    lateRegistrationDeadline: null,
    status: "planned",
    registered: false,
    taken: false,
    scoreReceived: false,
  }],
  scholarships: [{
    collegeName: "Brown University",
    name: "Brown Promise Scholarship",
    provider: "Brown University",
    url: "https://example.edu/scholarship",
    requirements: "Submit financial aid forms",
    deadline: "2026-11-01",
    status: "awarded",
    outcome: "Awarded",
    offeredAmount: "12000.00",
  }],
  financialAid: [{
    collegeName: "Brown University",
    currency: "USD",
    awardYear: 2027,
    costBreakdown: [{ label: "Tuition", amount: 65000 }, { label: "Housing", amount: 12000 }],
    giftAidBreakdown: [{ label: "Institutional grant", amount: 30000 }],
    loanBreakdown: [{ label: "Federal loan", amount: 5500 }],
    workStudyAmount: "2500.00",
    netCost: null,
    remainingBalance: null,
    totalCost: 77000,
    totalGiftAid: 30000,
    totalLoans: 5500,
    derivedNetCost: 47000,
    derivedRemainingBalance: 39000,
  }],
  sharedNotes: [{ body: "Ploy is making great progress.", createdAt: "2026-07-05T03:00:00.000Z" }],
};

const EMPTY_DASHBOARD: ParentDashboard = {
  ...DASHBOARD,
  profile: { ...DASHBOARD.profile, sharedDetails: [] },
  academics: [],
  phaseProgress: [],
  checklist: [],
  collegeList: [],
  recommenders: [],
  essays: [],
  activities: [],
  awards: [],
  upcomingDeadlines: [],
  announcements: [],
  testingMilestones: [],
  scholarships: [],
  financialAid: [],
  sharedNotes: [],
};

function renderDashboard(options: {
  dashboard?: ParentDashboard;
  initialLocale?: "th" | "en";
  linkedCases?: LinkedFamilyCase[];
} = {}) {
  return renderToStaticMarkup(
    <ParentDashboardView
      dashboard={options.dashboard ?? DASHBOARD}
      initialLocale={options.initialLocale}
      linkedCases={options.linkedCases ?? LINKED_CASES}
      currentCaseHref={CURRENT_HREF}
    />,
  );
}

function count(html: string, needle: string) {
  return html.split(needle).length - 1;
}

function fakeStorage(initial: Record<string, string> = {}, throwing = false) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem(key: string) { if (throwing) throw new Error("unavailable"); return store.get(key) ?? null; },
    setItem(key: string, value: string) { if (throwing) throw new Error("unavailable"); store.set(key, value); },
  };
}

describe("parent locale helpers", () => {
  it("defaults to Thai and persists an explicit English choice", () => {
    expect(resolveParentLocale(null)).toBe("th");
    expect(resolveParentLocale("EN")).toBe("th");
    expect(resolveParentLocale("en")).toBe("en");
    const storage = fakeStorage();
    writeStoredParentLocale(storage, "en");
    expect(storage.store.get(PARENT_LOCALE_STORAGE_KEY)).toBe("en");
    expect(readStoredParentLocale(storage)).toBe("en");
  });

  it("fails safely when storage is missing or throws", () => {
    expect(readStoredParentLocale(null)).toBe("th");
    expect(readStoredParentLocale(fakeStorage({}, true))).toBe("th");
    expect(() => writeStoredParentLocale(fakeStorage({}, true), "en")).not.toThrow();
  });

  it("keeps every bilingual table complete", () => {
    const tables: Record<string, ParentBilingualString>[] = [
      PARENT_STRINGS,
      PARENT_CASE_STATUS_STRINGS,
      PARENT_APP_STATUS_STRINGS,
      PARENT_DEADLINE_SOURCE_STRINGS,
      PARENT_DECISION_STRINGS,
      PARENT_ESSAY_STATUS_STRINGS,
      PARENT_RECOMMENDER_STATUS_STRINGS,
      PARENT_SCHOLARSHIP_STATUS_STRINGS,
      PARENT_TASK_OWNER_STRINGS,
      PARENT_TASK_STATUS_STRINGS,
      PARENT_TEST_STATUS_STRINGS,
      PARENT_TEST_TYPE_STRINGS,
    ];
    for (const table of tables) for (const entry of Object.values(table)) {
      expect(entry.th.trim()).not.toBe("");
      expect(entry.en.trim()).not.toBe("");
    }
    expect(pickParentString(PARENT_STRINGS.moneyTitle, "en")).toBe("Scholarships & financial aid");
    expect(formatParentString(PARENT_STRINGS.checklistDue, "en", { date: "1/11/2026" })).toBe("Due 1/11/2026");
  });
});

describe("groupParentDeadlinesByWeek", () => {
  const TODAY = "2026-07-08";
  it("orders overdue, current, next, and later weeks", () => {
    const groups = groupParentDeadlinesByWeek(DASHBOARD.upcomingDeadlines, TODAY);
    expect(groups.map((group) => group.key)).toEqual(["overdue", "week-0", "week-1", "week-2"]);
    expect(groups[3].weekStart).toBe("2026-07-20");
  });

  it("keeps unknown dates visible in a trailing group", () => {
    const rows: ParentDeadline[] = [{ source: "task", title: "Unknown", date: "soon", overdue: false }];
    expect(groupParentDeadlinesByWeek(rows, TODAY)[0].key).toBe("week-unknown");
  });
});

describe("ParentDashboardView complete family surface", () => {
  it("renders every approved section in a stable single-scroll order", () => {
    const html = renderDashboard();
    let previous = -1;
    for (const testId of PARENT_SECTION_TEST_IDS) {
      const index = html.indexOf(`data-testid="${testId}"`);
      expect(index, testId).toBeGreaterThan(previous);
      previous = index;
    }
    expect(html).toContain("overflow-x-hidden");
  });

  it("renders complete profile, application, testing, and money data", () => {
    const html = renderDashboard({ initialLocale: "en" });
    for (const value of [
      "Bangkok, Thailand",
      "AP Biology",
      "Submit the Common App",
      "Brown University",
      "Public Health",
      "Submit CSS Profile",
      "Dr. Rivera",
      "Why Brown?",
      "Robotics Club",
      "National Biology Olympiad Finalist",
      "Brown Promise Scholarship",
      "$47,000.00",
      "Ploy is making great progress.",
    ]) expect(html).toContain(value);
    expect(html).toContain('data-testid="parent-score-details"');
    expect(html).toContain("740");
  });

  it("is Thai-first and can server-render the English locale", () => {
    const thai = renderDashboard();
    expect(thai).toContain(PARENT_STRINGS.profileTitle.th);
    expect(thai).toContain(PARENT_STRINGS.moneyTitle.th);
    expect(thai).not.toContain("Scholarships &amp; financial aid");
    const english = renderDashboard({ initialLocale: "en" });
    expect(english).toContain("Student profile");
    expect(english).toContain("Scholarships &amp; financial aid");
  });

  it("shows the role, sign-out, and sibling switcher without mutation controls", () => {
    const html = renderDashboard({ initialLocale: "en" });
    expect(html).toContain("Parent · View only");
    expect(html).toContain('data-testid="parent-sign-out"');
    expect(html).toContain('href="/api/auth/signout"');
    expect(html).toContain('data-testid="parent-child-switcher"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Pat");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<textarea");
    expect(count(html, "<button")).toBe(2);
    for (const forbidden of ["Add a note", "Log meeting", "Invite", "Revoke", "Verify", "Staff only"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("renders only approved navigation and explicitly shared external links", () => {
    const html = renderDashboard({ initialLocale: "en" });
    expect(html).toContain('href="https://docs.google.com/shared-essay"');
    expect(html).toContain('href="https://drive.google.com/transcript"');
    expect(html).toContain('href="https://apply.college.example/login"');
    expect(html).toContain(`href="${LINKED_CASES[1].href}"`);
    expect(html).not.toContain("password");
    expect(html).not.toContain("oauth");
  });

  it("renders no score detail for an unreleased milestone shape", () => {
    const dashboard: ParentDashboard = {
      ...DASHBOARD,
      testingMilestones: [{
        testType: "sat",
        subject: null,
        testDate: "2026-06-06",
        registrationDeadline: null,
        lateRegistrationDeadline: null,
        status: "score_received",
        registered: true,
        taken: true,
        scoreReceived: true,
      }],
    };
    const html = renderDashboard({ dashboard });
    expect(html).not.toContain('data-testid="parent-milestone-score"');
    expect(html).not.toContain('data-testid="parent-score-details"');
    expect(html).not.toContain("1450");
  });

  it("keeps every section visible with a useful empty state", () => {
    const html = renderDashboard({ dashboard: EMPTY_DASHBOARD, initialLocale: "en", linkedCases: [] });
    for (const text of [
      "No academic records yet.",
      "No checklist items yet.",
      "No upcoming deadlines yet.",
      "No colleges on the list yet.",
      "No recommenders yet.",
      "No essays yet.",
      "No activities yet.",
      "No awards yet.",
      "No test sittings yet.",
      "No scholarship or aid information yet.",
      "No announcements yet.",
      "No shared notes yet.",
    ]) expect(html).toContain(text);
    for (const testId of PARENT_SECTION_TEST_IDS) expect(html).toContain(`data-testid="${testId}"`);
  });
});

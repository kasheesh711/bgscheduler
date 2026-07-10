import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/academics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/academics")>()),
  listAcademicRecordsForCase: vi.fn(),
}));
vi.mock("@/lib/admissions/activities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/activities")>()),
  listActivitiesForCase: vi.fn(),
}));
vi.mock("@/lib/admissions/announcements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/announcements")>()),
  listAnnouncementsForCase: vi.fn(),
}));
vi.mock("@/lib/admissions/awards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/awards")>()),
  listAwardsForCase: vi.fn(),
}));
vi.mock("@/lib/admissions/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/calendar")>()),
  getUpcomingDeadlines: vi.fn(),
}));
vi.mock("@/lib/admissions/checklists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/checklists")>()),
  computeProgress: vi.fn(),
  listCaseTasks: vi.fn(),
}));
vi.mock("@/lib/admissions/essays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/essays")>()),
  listEssaysForCase: vi.fn(),
}));
vi.mock("@/lib/admissions/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/notes")>()),
  listNotesForRole: vi.fn(),
}));
vi.mock("@/lib/admissions/recommenders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/recommenders")>()),
  computeCollegeCompleteness: vi.fn(),
  listRecommenders: vi.fn(),
}));
vi.mock("@/lib/admissions/student-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/student-home")>()),
  getPhaseProgress: vi.fn(),
}));
vi.mock("@/lib/admissions/testing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/testing")>()),
  listSittingsForCase: vi.fn(),
}));

import { listAcademicRecordsForCase } from "@/lib/admissions/academics";
import { listActivitiesForCase } from "@/lib/admissions/activities";
import { listAnnouncementsForCase } from "@/lib/admissions/announcements";
import { listAwardsForCase } from "@/lib/admissions/awards";
import { getUpcomingDeadlines } from "@/lib/admissions/calendar";
import { computeProgress, listCaseTasks } from "@/lib/admissions/checklists";
import { listEssaysForCase } from "@/lib/admissions/essays";
import { listNotesForRole } from "@/lib/admissions/notes";
import {
  computeCollegeCompleteness,
  listRecommenders,
} from "@/lib/admissions/recommenders";
import {
  buildParentDashboard,
  PARENT_ANNOUNCEMENTS_LIMIT,
  PARENT_UPCOMING_DEADLINES_LIMIT,
} from "@/lib/admissions/parent-projection";
import { getPhaseProgress } from "@/lib/admissions/student-home";
import { listSittingsForCase } from "@/lib/admissions/testing";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const COLLEGE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-09T05:00:00Z");

const POISON = {
  staffNote: "SECRET-STAFF-NOTE",
  internalAward: "SECRET-AWARD-NOTES",
  counselorStage: "SECRET-COUNSELOR-STAGE",
  counselorEmail: "secret.counselor@example.com",
  wise: "WISE-KEY-SECRET",
  unreleasedScore: "1590",
  accommodations: "SECRET-ACCOMMODATIONS",
  privateEssayUrl: "https://docs.google.com/private-family-hidden",
  portalPassword: "PORTAL-PASSWORD-SECRET",
};

function fakeDb(queue: unknown[][]) {
  let i = 0;
  function builder(rows: unknown[]) {
    const value: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      value[method] = () => value;
    }
    (value as { then: unknown }).then = (
      resolve: (result: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return value;
  }
  return { select: () => builder(queue[i++] ?? []) };
}

function directRows(options: { sharedAboutYou?: boolean; header?: boolean } = {}) {
  const header = options.header === false ? [] : [{
    status: "active",
    studentFullName: "Nong Prae",
    preferredName: "Prae",
    phone: "+66 81 234 5678",
    school: "Bangkok International School",
    schoolCounselor: "Ms. Chen",
    cohortName: "Class of 2027",
    graduationYear: 2027,
    wiseStudentKey: POISON.wise,
    studentEmail: "student.secret@example.com",
  }];
  return [
    header,
    [{
      id: COLLEGE_ID,
      instName: "Brown University",
      round: "ed",
      deadline: "2026-11-01",
      appStatus: "applying",
      category: "reach",
      firstChoiceMajor: "Public Health",
      secondChoiceMajor: "Economics",
      admissionsUrl: "https://admission.brown.edu",
      portalUrl: "https://apply.college.example/login",
      portalPassword: POISON.portalPassword,
      aidNotes: "SECRET-AID-NOTES",
    }],
    [{
      sharedWithFamily: options.sharedAboutYou ?? true,
      payload: {
        hometown: "Bangkok, Thailand",
        languages: ["Thai", "English"],
        citizenship_status: "Non-US citizen",
        private_reflection: "THIS-MUST-NOT-LEAK",
        passport_number: "P123456789",
        wiseStudentKey: POISON.wise,
      },
    }],
    [{
      listItemId: COLLEGE_ID,
      name: "Brown Promise Scholarship",
      provider: "Brown University",
      url: "https://example.edu/scholarship",
      requirements: "Submit the aid application",
      deadline: "2026-11-01",
      status: "submitted",
      outcome: "awarded",
      offeredAmount: "12000.00",
      notes: "SECRET-SCHOLARSHIP-NOTES",
    }],
    [{
      listItemId: COLLEGE_ID,
      kind: "css_profile",
      title: "Submit CSS Profile",
      status: "in_progress",
      owner: "student",
      dueDate: "2026-11-01",
      required: true,
      sourceUrl: "https://cssprofile.collegeboard.org",
      sortOrder: 1,
      notes: "SECRET-REQUIREMENT-NOTES",
      verifiedByEmail: POISON.counselorEmail,
    }],
    [{
      listItemId: COLLEGE_ID,
      currency: "USD",
      awardYear: 2027,
      costBreakdown: {
        Tuition: 65000,
        Housing: 12000,
        portalPassword: 999,
      },
      giftAidBreakdown: { "Institutional grant": 30000 },
      loanBreakdown: { "Federal loan": 5500 },
      workStudyAmount: "2500.00",
      netCost: null,
      remainingBalance: null,
      notes: "SECRET-FINANCIAL-AID-NOTES",
    }],
    [{
      listItemId: COLLEGE_ID,
      event: "accepted",
      eventDate: "2027-03-20",
      createdAt: new Date("2027-03-20T10:00:00Z"),
      notes: "SECRET-DECISION-NOTES",
    }],
  ];
}

function seedDomainMocks() {
  vi.mocked(computeProgress).mockResolvedValue({
    done: 3,
    total: 10,
    percent: 30,
    verifiedCount: 2,
  });
  vi.mocked(getPhaseProgress).mockResolvedValue([{
    phase: "about_you",
    label: "About You",
    done: 1,
    total: 2,
    percent: 50,
    verifiedCount: 1,
  }]);
  vi.mocked(listCaseTasks).mockResolvedValue([{
    id: "33333333-3333-4333-8333-333333333333",
    caseId: CASE_ID,
    templateId: null,
    templateVersion: null,
    itemKey: null,
    phase: "applications",
    title: "Submit Common App",
    description: "Review before submitting",
    owner: "student",
    status: "in_progress",
    dueDate: "2026-11-01",
    verifiedByEmail: POISON.counselorEmail,
    verifiedAt: "2026-07-01T00:00:00.000Z",
    recurrence: null,
    sortOrder: 1,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  }]);
  vi.mocked(getUpcomingDeadlines).mockResolvedValue([{
    id: "44444444-4444-4444-8444-444444444444",
    caseId: CASE_ID,
    source: "task",
    title: "Submit Common App",
    date: "2026-11-01",
    overdue: false,
    ownerRole: "student",
  }]);
  vi.mocked(listAnnouncementsForCase).mockResolvedValue([{
    id: "55555555-5555-4555-8555-555555555555",
    cohortId: null,
    caseId: CASE_ID,
    title: "Family webinar",
    body: "Join us on Saturday.",
    authorEmail: POISON.counselorEmail,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  }]);
  vi.mocked(listSittingsForCase).mockResolvedValue([
    {
      id: "66666666-6666-4666-8666-666666666666",
      caseId: CASE_ID,
      testType: "sat",
      subject: null,
      testDate: "2026-06-06",
      registrationDeadline: "2026-05-01",
      lateRegistrationDeadline: "2026-05-15",
      status: "score_received",
      targetScore: "1500",
      actualScore: "1450",
      scoreDetails: { testType: "sat", math: 740, readingWriting: 710, total: 1450 },
      scoreReleasedToParent: true,
      accommodations: POISON.accommodations,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
    {
      id: "77777777-7777-4777-8777-777777777777",
      caseId: CASE_ID,
      testType: "sat",
      subject: null,
      testDate: "2026-08-22",
      registrationDeadline: "2026-07-18",
      lateRegistrationDeadline: null,
      status: "score_received",
      targetScore: "1600",
      actualScore: POISON.unreleasedScore,
      scoreDetails: { testType: "sat", math: 800, readingWriting: 790, total: 1590 },
      scoreReleasedToParent: false,
      accommodations: POISON.accommodations,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  ]);
  vi.mocked(listNotesForRole).mockResolvedValue([
    {
      id: "88888888-8888-4888-8888-888888888888",
      caseId: CASE_ID,
      authorEmail: POISON.counselorEmail,
      body: "Ploy is making strong progress.",
      visibility: "shared_with_family",
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
    },
    {
      id: "99999999-9999-4999-8999-999999999999",
      caseId: CASE_ID,
      authorEmail: POISON.counselorEmail,
      body: POISON.staffNote,
      visibility: "staff_only",
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
    },
  ]);
  vi.mocked(listAcademicRecordsForCase).mockResolvedValue([{
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    caseId: CASE_ID,
    system: "us",
    effectiveDate: "2026-06-01",
    payload: {
      system: "us",
      gpaScale: 4,
      unweightedGpa: 3.8,
      classRank: 5,
      classSize: 120,
      fourYearCoursePlan: [],
      transcriptUrl: "https://drive.google.com/transcript",
      schoolProfileUrl: null,
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  }]);
  vi.mocked(listAwardsForCase).mockResolvedValue([{
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    caseId: CASE_ID,
    title: "National Biology Olympiad Finalist",
    organization: "Biology Society",
    gradeLevels: ["11"],
    recognitionLevels: ["national"],
    awardDate: "2026-04-01",
    commonAppRank: 1,
    ucEligibilityNarrative: "Top students were invited.",
    ucAchievementNarrative: "Placed in the national final.",
    internalNotes: POISON.internalAward,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  }]);
  vi.mocked(listActivitiesForCase).mockResolvedValue([{
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    caseId: CASE_ID,
    name: "Robotics Club",
    fullDescription: "Led a team of five students.",
    commonApp: null,
    uc: null,
    commonAppRank: 1,
    sortOrder: 0,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  }]);
  vi.mocked(listEssaysForCase).mockResolvedValue([
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      caseId: CASE_ID,
      listItemId: COLLEGE_ID,
      prompt: "Why Brown?",
      status: "drafting",
      counselorStage: "feedback",
      deadline: "2026-11-01",
      driveUrl: "https://docs.google.com/shared-essay",
      sharedWithFamily: true,
      lastStudentUpdateAt: null,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      stalenessDays: null,
      effectiveStage: "feedback",
    },
    {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      caseId: CASE_ID,
      listItemId: null,
      prompt: "Personal statement",
      status: "brainstorming",
      counselorStage: "feedback",
      deadline: null,
      driveUrl: POISON.privateEssayUrl,
      sharedWithFamily: false,
      lastStudentUpdateAt: null,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      stalenessDays: null,
      effectiveStage: "feedback",
    },
  ]);
  vi.mocked(listRecommenders).mockResolvedValue([{
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    caseId: CASE_ID,
    name: "Dr. Rivera",
    roleSubject: "Biology",
    contact: POISON.counselorEmail,
    askStatus: "agreed",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    colleges: [{
      id: "12121212-1212-4212-8212-121212121212",
      recommenderId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      listItemId: COLLEGE_ID,
      submitted: true,
      submittedAt: "2026-10-20T00:00:00.000Z",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
    }],
  }]);
  vi.mocked(computeCollegeCompleteness).mockResolvedValue(new Map([[COLLEGE_ID, {
    recsAgreed: 1,
    recsSubmitted: 1,
    recsTotal: 1,
    transcriptSent: true,
    schoolReportSent: true,
    scoreSendsSent: 1,
    complete: true,
  }]]));
}

beforeEach(() => {
  vi.resetAllMocks();
  seedDomainMocks();
});

describe("buildParentDashboard complete family projection", () => {
  it("assembles every approved family section without internal identifiers", async () => {
    const dashboard = await buildParentDashboard(
      CASE_ID,
      { now: NOW },
      fakeDb(directRows()) as never,
    );

    expect(dashboard.profile).toEqual(expect.objectContaining({
      preferredName: "Prae",
      school: "Bangkok International School",
      graduationYear: 2027,
      sharedDetails: [
        { key: "hometown", label: "Hometown", value: "Bangkok, Thailand" },
        { key: "languages", label: "Languages", value: ["Thai", "English"] },
        { key: "citizenship_status", label: "Citizenship or residency", value: "Non-US citizen" },
      ],
    }));
    expect(dashboard.academics[0]).toEqual(expect.objectContaining({ system: "us", effectiveDate: "2026-06-01" }));
    expect(dashboard.checklist[0]).toEqual(expect.objectContaining({ title: "Submit Common App", status: "in_progress" }));
    expect(dashboard.collegeList[0]).toEqual(expect.objectContaining({
      instName: "Brown University",
      firstChoiceMajor: "Public Health",
      completeness: expect.objectContaining({ complete: true }),
      decisions: [{ event: "accepted", eventDate: "2027-03-20" }],
      requirements: [expect.objectContaining({ kind: "css_profile" })],
    }));
    expect(dashboard.recommenders[0]).toEqual(expect.objectContaining({
      name: "Dr. Rivera",
      colleges: [expect.objectContaining({ collegeName: "Brown University", submitted: true })],
    }));
    expect(dashboard.essays[0].googleDocUrl).toBe("https://docs.google.com/shared-essay");
    expect("googleDocUrl" in dashboard.essays[1]).toBe(false);
    expect(dashboard.activities[0].name).toBe("Robotics Club");
    expect(dashboard.awards[0].title).toContain("Biology Olympiad");
    expect(dashboard.testingMilestones[0]).toEqual(expect.objectContaining({
      status: "score_received",
      score: 1450,
      scoreDetails: expect.objectContaining({ math: 740 }),
    }));
    expect("score" in dashboard.testingMilestones[1]).toBe(false);
    expect("scoreDetails" in dashboard.testingMilestones[1]).toBe(false);
    expect(dashboard.scholarships[0]).toEqual(expect.objectContaining({
      name: "Brown Promise Scholarship",
      offeredAmount: "12000.00",
    }));
    expect(dashboard.financialAid[0]).toEqual(expect.objectContaining({
      totalCost: 77000,
      totalGiftAid: 30000,
      totalLoans: 5500,
      derivedNetCost: 47000,
      derivedRemainingBalance: 39000,
    }));
    expect(dashboard.financialAid[0].costBreakdown).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "portalPassword" })]),
    );
    expect(getUpcomingDeadlines).toHaveBeenCalledWith(
      CASE_ID,
      PARENT_UPCOMING_DEADLINES_LIMIT,
      NOW,
      expect.anything(),
    );
    expect(listAwardsForCase).toHaveBeenCalledWith(
      CASE_ID,
      { includeInternalNotes: false },
      expect.anything(),
    );
  });

  it("fails closed on credential-bearing legacy URLs in every family section", async () => {
    const rows = directRows();
    (rows[1] as Array<Record<string, unknown>>)[0]!.admissionsUrl =
      "https://student:college-secret@admission.example.edu/";
    (rows[1] as Array<Record<string, unknown>>)[0]!.portalUrl =
      "https://student:portal-secret@portal.example.edu/";
    (rows[3] as Array<Record<string, unknown>>)[0]!.url =
      "https://student:scholarship-secret@example.edu/";
    (rows[4] as Array<Record<string, unknown>>)[0]!.sourceUrl =
      "https://student:requirement-secret@example.edu/";
    vi.mocked(listAcademicRecordsForCase).mockResolvedValue([{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      caseId: CASE_ID,
      system: "us",
      effectiveDate: "2026-06-01",
      payload: {
        system: "us",
        gpaScale: 4,
        fourYearCoursePlan: [],
        transcriptUrl: "https://student:transcript-secret@drive.google.com/file",
        schoolProfileUrl: "https://student:profile-secret@drive.google.com/file",
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    }]);
    vi.mocked(listEssaysForCase).mockResolvedValue([{
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      caseId: CASE_ID,
      listItemId: COLLEGE_ID,
      prompt: "Why Brown?",
      status: "drafting",
      counselorStage: null,
      deadline: "2026-11-01",
      driveUrl: "https://student:essay-secret@docs.google.com/document/d/abc",
      sharedWithFamily: true,
      lastStudentUpdateAt: null,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      stalenessDays: null,
      effectiveStage: "drafting",
    }]);

    const dashboard = await buildParentDashboard(CASE_ID, { now: NOW }, fakeDb(rows) as never);

    expect(dashboard.collegeList[0]).toMatchObject({ admissionsUrl: null, portalUrl: null });
    expect(dashboard.collegeList[0]?.requirements[0]?.sourceUrl).toBeNull();
    expect(dashboard.scholarships[0]?.url).toBeNull();
    expect(dashboard.academics[0]?.payload.transcriptUrl).toBeNull();
    expect(dashboard.academics[0]?.payload.schoolProfileUrl).toBeNull();
    expect("googleDocUrl" in dashboard.essays[0]!).toBe(false);
    expect(JSON.stringify(dashboard)).not.toMatch(/college-secret|portal-secret|essay-secret/);
  });

  it("has the exact closed top-level key set", async () => {
    const dashboard = await buildParentDashboard(CASE_ID, { now: NOW }, fakeDb(directRows()) as never);
    expect(Object.keys(dashboard).sort()).toEqual([
      "academics", "activities", "announcements", "awards", "caseStatus",
      "checklist", "cohortName", "collegeList", "essays", "financialAid",
      "phaseProgress", "profile", "progress", "recommenders", "scholarships",
      "sharedNotes", "studentName", "testingMilestones", "upcomingDeadlines",
    ].sort());
  });

  it("withholds About You details until explicitly shared", async () => {
    const dashboard = await buildParentDashboard(
      CASE_ID,
      { now: NOW },
      fakeDb(directRows({ sharedAboutYou: false })) as never,
    );
    expect(dashboard.profile.sharedDetails).toEqual([]);
  });

  it("caps announcements at the parent limit", async () => {
    vi.mocked(listAnnouncementsForCase).mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        id: `announcement-${index}`,
        cohortId: null,
        caseId: CASE_ID,
        title: `Announcement ${index}`,
        body: "Body",
        authorEmail: POISON.counselorEmail,
        createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        updatedAt: "2026-07-01T00:00:00.000Z",
      })),
    );
    const dashboard = await buildParentDashboard(CASE_ID, { now: NOW }, fakeDb(directRows()) as never);
    expect(dashboard.announcements).toHaveLength(PARENT_ANNOUNCEMENTS_LIMIT);
  });

  it("throws NotFound for malformed and missing cases", async () => {
    await expect(buildParentDashboard("nope", { now: NOW }, fakeDb([]) as never)).rejects.toThrow("NotFound");
    await expect(buildParentDashboard(
      CASE_ID,
      { now: NOW },
      fakeDb(directRows({ header: false }).slice(0, 4)) as never,
    )).rejects.toThrow("NotFound");
  });
});

describe("parent payload leak matrix", () => {
  const forbiddenKeys = [
    "id", "caseId", "studentId", "unitId", "studentEmail", "wiseStudentKey",
    "authorEmail", "verifiedByEmail", "verifiedAt", "reviewedByEmail",
    "counselorStage", "effectiveStage", "stalenessDays", "internalNotes",
    "contact", "notes", "actualScore", "targetScore", "accommodations",
    "scoreReleasedToParent", "portalPassword", "audit", "actorEmail", "diff",
  ];
  const forbiddenValues = [
    ...Object.values(POISON),
    "THIS-MUST-NOT-LEAK",
    "P123456789",
    "SECRET-AID-NOTES",
    "SECRET-SCHOLARSHIP-NOTES",
    "SECRET-REQUIREMENT-NOTES",
    "SECRET-FINANCIAL-AID-NOTES",
    "SECRET-DECISION-NOTES",
  ];

  it("contains zero forbidden keys and zero poisoned values", async () => {
    const serialized = JSON.stringify(
      await buildParentDashboard(CASE_ID, { now: NOW }, fakeDb(directRows()) as never),
    );
    for (const key of forbiddenKeys) {
      expect(serialized, `forbidden key leaked: ${key}`).not.toContain(`"${key}":`);
    }
    for (const value of forbiddenValues) {
      expect(serialized, `forbidden value leaked: ${value}`).not.toContain(value);
    }
  });

  it("defense-in-depth filters staff-only notes returned by the notes domain", async () => {
    const dashboard = await buildParentDashboard(CASE_ID, { now: NOW }, fakeDb(directRows()) as never);
    expect(dashboard.sharedNotes).toEqual([{
      body: "Ploy is making strong progress.",
      createdAt: "2026-07-05T00:00:00.000Z",
    }]);
  });
});

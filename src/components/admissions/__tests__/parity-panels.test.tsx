import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ refresh: vi.fn(), replace: vi.fn() })),
}));

import { AcademicsPanel, buildAcademicPayload } from "../academics-panel";
import { AwardsPanel, buildAwardPayload } from "../awards-panel";
import { CollegeDetailsPanel } from "../college-details-panel";
import {
  DirectMessageComposer,
  NotificationPreferencesPanel,
} from "../communications-panel";
import { MoneyPanel } from "../money-panel";
import type { AdmissionsCollegeListRowDto } from "@/lib/admissions/colleges";
import type { AdmissionsMemberDto } from "@/lib/admissions/types";

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

const COLLEGE: AdmissionsCollegeListRowDto = {
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
  firstChoiceMajor: "Economics",
  secondChoiceMajor: null,
  admissionsUrl: "https://college.harvard.edu/admissions",
  portalUrl: null,
  aidOffered: null,
  aidNotes: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  stats: null,
  stale: false,
  completeness: null,
};

const MEMBERS: AdmissionsMemberDto[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    caseId: CASE_ID,
    email: "counselor@example.com",
    role: "counselor",
    status: "active",
    invitedAt: null,
    activatedAt: "2026-07-01T00:00:00.000Z",
    revokedAt: null,
    addedByEmail: "admin@example.com",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    caseId: CASE_ID,
    email: "student@example.com",
    role: "student",
    status: "active",
    invitedAt: null,
    activatedAt: "2026-07-01T00:00:00.000Z",
    revokedAt: null,
    addedByEmail: "admin@example.com",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
];

describe("academic payload builder", () => {
  const common = {
    effectiveDate: "2026-07-10",
    transcriptUrl: "https://drive.google.com/transcript",
    schoolProfileUrl: "",
    gpaScale: "4",
    unweightedGpa: "3.8",
    weightedGpa: "4.4",
    coreGpa: "3.9",
    classRank: "5",
    classSize: "120",
    courseRigor: "most_demanding" as const,
    fourYearCoursePlan: [],
    ibProgram: "dp" as const,
    ibSubjects: [],
    tokGrade: "" as const,
    extendedEssayGrade: "" as const,
    casCompleted: "" as const,
    predictedTotal: "",
    finalTotal: "",
    ukSubjects: [],
    curriculumNotes: "",
  };

  it("builds the validated US GPA variant", () => {
    expect(buildAcademicPayload({ ...common, system: "us" })).toMatchObject({
      system: "us",
      gpaScale: 4,
      unweightedGpa: 3.8,
      weightedGpa: 4.4,
      classRank: 5,
      classSize: 120,
      transcriptUrl: "https://drive.google.com/transcript",
    });
  });

  it("builds IB and A-level variants without leaking fields across systems", () => {
    const ib = buildAcademicPayload({
      ...common,
      system: "ib",
      predictedTotal: "42",
      casCompleted: "yes",
      ibSubjects: [{ subject: "Economics", level: "HL", predictedGrade: 7, finalGrade: null }],
    });
    expect(ib).toMatchObject({ system: "ib", predictedTotal: 42, casCompleted: true });
    expect(ib).not.toHaveProperty("gpaScale");

    const uk = buildAcademicPayload({
      ...common,
      system: "a_level_igcse",
      ukSubjects: [{ qualification: "a_level", subject: "Mathematics", board: "Cambridge", predictedGrade: "A*", achievedGrade: null }],
    });
    expect(uk).toMatchObject({ system: "a_level_igcse", subjects: [{ board: "Cambridge" }] });
    expect(uk).not.toHaveProperty("predictedTotal");
  });
});

describe("award payload builder", () => {
  const form = {
    title: "National Economics Challenge",
    organization: "CEE",
    gradeLevels: ["11"] as "11"[],
    recognitionLevels: ["national"] as "national"[],
    awardDate: "2026-05-01",
    commonAppRank: "1",
    ucEligibilityNarrative: "Qualified through the regional round.",
    ucAchievementNarrative: "Led the team to the national final.",
    internalNotes: "Counselor-only verification note",
  };

  it("omits internal notes from student-authored payloads", () => {
    expect(buildAwardPayload(form, false)).not.toHaveProperty("internalNotes");
    expect(buildAwardPayload(form, false)).toMatchObject({ commonAppRank: 1 });
  });

  it("includes internal notes for staff", () => {
    expect(buildAwardPayload(form, true)).toHaveProperty(
      "internalNotes",
      "Counselor-only verification note",
    );
  });
});

describe("parity panels role shaping", () => {
  it("renders academics and awards as student-editable records", () => {
    const academics = renderToStaticMarkup(
      <AcademicsPanel caseId={CASE_ID} viewerRole="student" />,
    );
    const awards = renderToStaticMarkup(
      <AwardsPanel caseId={CASE_ID} viewerRole="student" />,
    );
    expect(academics).toContain("Academic record");
    expect(academics).not.toContain("Add record");
    expect(awards).toContain("Add award");
  });

  it("keeps financial-aid mutation controls counselor-only", () => {
    const student = renderToStaticMarkup(
      <MoneyPanel caseId={CASE_ID} colleges={[COLLEGE]} viewerRole="student" />,
    );
    const staff = renderToStaticMarkup(
      <MoneyPanel caseId={CASE_ID} colleges={[COLLEGE]} viewerRole="counselor" />,
    );
    expect(student).toContain("Financial aid comparison");
    expect(student).not.toContain("Save aid offer");
    expect(staff).toContain("Financial aid comparison");
  });

  it("shows research fields to a student without official-plan save controls", () => {
    const html = renderToStaticMarkup(
      <CollegeDetailsPanel caseId={CASE_ID} colleges={[COLLEGE]} viewerRole="student" />,
    );
    expect(html).toContain("College research &amp; requirements");
    expect(html).toContain("Research &amp; fit");
    expect(html).not.toContain("Save application plan");
    expect(html).toContain("Save research");
  });

  it("offers messaging only to other active case members", () => {
    const html = renderToStaticMarkup(
      <DirectMessageComposer
        caseId={CASE_ID}
        members={MEMBERS}
        viewerEmail="counselor@example.com"
      />,
    );
    expect(html).toContain("student@example.com · student");
    expect(html).not.toContain("counselor@example.com · counselor");
  });

  it("renders self-service notification preferences", () => {
    const html = renderToStaticMarkup(
      <NotificationPreferencesPanel caseId={CASE_ID} />,
    );
    expect(html).toContain('data-testid="notification-preferences"');
    expect(html).toContain("Loading preferences");
  });
});

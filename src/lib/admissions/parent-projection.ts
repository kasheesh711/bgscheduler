// Admissions Case Management — the ONLY builder of family-facing case data.
//
// Parent payloads are a closed whitelist. Database/domain rows are never
// spread into the response: every approved field is copied deliberately and
// staff notes, audit attribution, internal ids, membership emails, Wise/OAuth
// data, unreleased scores, accommodations, and private self-reflection stay
// structurally unreachable.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsApplicationEvents,
  admissionsCases,
  admissionsCollegeListItems,
  admissionsCollegeRequirements,
  admissionsCohorts,
  admissionsFinancialAidOffers,
  admissionsScholarships,
  admissionsSelfReportSections,
  admissionsStudents,
} from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import {
  listAcademicRecordsForCase,
  type AcademicRecordPayload,
  type AdmissionsAcademicSystem,
} from "./academics";
import {
  listActivitiesForCase,
  type AdmissionsCommonAppBlock,
  type AdmissionsUcBlock,
} from "./activities";
import { listAnnouncementsForCase } from "./announcements";
import { listAwardsForCase } from "./awards";
import {
  getUpcomingDeadlines,
  type CalendarItemSource,
} from "./calendar";
import {
  computeProgress,
  listCaseTasks,
  type AdmissionsTaskRecurrence,
  type AdmissionsTaskStatus,
} from "./checklists";
import {
  ADMISSIONS_APP_ROUND_LABELS,
  type AdmissionsAppRound,
  type AdmissionsAppStatus,
  type AdmissionsCollegeCategory,
  type AdmissionsDecisionEvent,
} from "./colleges";
import type { AdmissionsPhaseKey } from "./config";
import { listEssaysForCase, type AdmissionsEssayStatus } from "./essays";
import { isUuidShaped } from "./members";
import type { AdmissionsTaskOwner } from "./meetings";
import { listNotesForRole } from "./notes";
import {
  computeCollegeCompleteness,
  listRecommenders,
  type AdmissionsCollegeCompleteness,
  type AdmissionsRecommenderAskStatus,
} from "./recommenders";
import type { CollegeRequirementKind, ScholarshipStatus } from "./shared/college-details";
import type {
  AdmissionsAwardGradeLevel,
  AdmissionsAwardRecognitionLevel,
} from "./shared/awards";
import type {
  AdmissionsTestScoreDetails,
  AdmissionsTestSittingStatus,
} from "./shared/testing";
import {
  isSafeAdmissionsUrl,
  normalizeAdmissionsUrl,
} from "./shared/urls";
import { getPhaseProgress } from "./student-home";
import {
  listSittingsForCase,
  parseScoreValue,
  type AdmissionsTestType,
} from "./testing";
import type { AdmissionsCaseStatus } from "./types";

/** Full open-deadline feed, capped at the calendar domain's hard maximum. */
export const PARENT_UPCOMING_DEADLINES_LIMIT = 100;
export const PARENT_ANNOUNCEMENTS_LIMIT = 10;

export interface ParentProgressSummary {
  done: number;
  total: number;
  percent: number;
}

export interface ParentPhaseProgress {
  phase: AdmissionsPhaseKey;
  label: string;
  done: number;
  total: number;
  percent: number;
}

export interface ParentProfileField {
  key: string;
  label: string;
  value: string | string[];
}

export interface ParentProfile {
  preferredName: string | null;
  phone: string | null;
  school: string | null;
  schoolCounselor: string | null;
  graduationYear: number;
  /** Present only when About You was explicitly shared with family. */
  sharedDetails: ParentProfileField[];
}

export interface ParentAcademicRecord {
  system: AdmissionsAcademicSystem;
  effectiveDate: string;
  payload: AcademicRecordPayload;
}

export interface ParentChecklistItem {
  phase: string;
  title: string;
  description: string | null;
  owner: AdmissionsTaskOwner;
  status: AdmissionsTaskStatus;
  dueDate: string | null;
  recurrence: AdmissionsTaskRecurrence | null;
}

export interface ParentCollegeDecision {
  event: AdmissionsDecisionEvent;
  eventDate: string;
}

export interface ParentCollegeRequirement {
  kind: CollegeRequirementKind;
  title: string;
  status: AdmissionsTaskStatus;
  owner: AdmissionsTaskOwner;
  dueDate: string | null;
  required: boolean;
  sourceUrl: string | null;
}

export interface ParentCollegeListEntry {
  instName: string;
  round: AdmissionsAppRound;
  roundLabel: string;
  appStatus: AdmissionsAppStatus;
  deadline: string | null;
  category: AdmissionsCollegeCategory;
  firstChoiceMajor: string | null;
  secondChoiceMajor: string | null;
  admissionsUrl: string | null;
  portalUrl: string | null;
  completeness: AdmissionsCollegeCompleteness;
  decisions: ParentCollegeDecision[];
  requirements: ParentCollegeRequirement[];
}

export interface ParentRecommenderCollege {
  collegeName: string;
  submitted: boolean;
  submittedAt: string | null;
}

export interface ParentRecommender {
  name: string;
  roleSubject: string | null;
  askStatus: AdmissionsRecommenderAskStatus;
  colleges: ParentRecommenderCollege[];
}

export interface ParentEssay {
  collegeName: string | null;
  prompt: string;
  status: AdmissionsEssayStatus;
  deadline: string | null;
  /** Omitted unless the counselor explicitly shared this essay with family. */
  googleDocUrl?: string;
}

export interface ParentActivity {
  name: string;
  fullDescription: string | null;
  commonApp: AdmissionsCommonAppBlock | null;
  uc: AdmissionsUcBlock | null;
  commonAppRank: number | null;
}

export interface ParentAward {
  title: string;
  organization: string | null;
  gradeLevels: AdmissionsAwardGradeLevel[];
  recognitionLevels: AdmissionsAwardRecognitionLevel[];
  awardDate: string | null;
  commonAppRank: number | null;
  ucEligibilityNarrative: string | null;
  ucAchievementNarrative: string | null;
}

export interface ParentDeadline {
  source: CalendarItemSource;
  title: string;
  date: string;
  overdue: boolean;
}

export interface ParentAnnouncement {
  title: string;
  body: string;
  createdAt: string;
}

export interface ParentTestingMilestone {
  testType: AdmissionsTestType;
  subject: string | null;
  testDate: string;
  registrationDeadline: string | null;
  lateRegistrationDeadline: string | null;
  status: AdmissionsTestSittingStatus;
  registered: boolean;
  taken: boolean;
  scoreReceived: boolean;
  /** Present only when scoreReleasedToParent is true. */
  score?: number;
  /** Present only when scoreReleasedToParent is true. */
  scoreDetails?: AdmissionsTestScoreDetails;
}

export interface ParentScholarship {
  collegeName: string | null;
  name: string;
  provider: string | null;
  url: string | null;
  requirements: string | null;
  deadline: string | null;
  status: ScholarshipStatus;
  outcome: string | null;
  offeredAmount: string | null;
}

export interface ParentMoneyBreakdownItem {
  label: string;
  amount: number | null;
}

export interface ParentFinancialAidOffer {
  collegeName: string;
  currency: string;
  awardYear: number;
  costBreakdown: ParentMoneyBreakdownItem[];
  giftAidBreakdown: ParentMoneyBreakdownItem[];
  loanBreakdown: ParentMoneyBreakdownItem[];
  workStudyAmount: string | null;
  netCost: string | null;
  remainingBalance: string | null;
  totalCost: number;
  totalGiftAid: number;
  totalLoans: number;
  derivedNetCost: number;
  derivedRemainingBalance: number;
}

export interface ParentSharedNote {
  body: string;
  createdAt: string;
}

/** Complete, closed family-facing case contract. */
export interface ParentDashboard {
  studentName: string;
  cohortName: string;
  caseStatus: AdmissionsCaseStatus;
  profile: ParentProfile;
  academics: ParentAcademicRecord[];
  progress: ParentProgressSummary;
  phaseProgress: ParentPhaseProgress[];
  checklist: ParentChecklistItem[];
  collegeList: ParentCollegeListEntry[];
  recommenders: ParentRecommender[];
  essays: ParentEssay[];
  activities: ParentActivity[];
  awards: ParentAward[];
  upcomingDeadlines: ParentDeadline[];
  announcements: ParentAnnouncement[];
  testingMilestones: ParentTestingMilestone[];
  scholarships: ParentScholarship[];
  financialAid: ParentFinancialAidOffer[];
  sharedNotes: ParentSharedNote[];
}

export interface BuildParentDashboardOptions {
  now?: Date;
}

const PROFILE_FIELDS = [
  ["preferred_name", "Preferred name"],
  ["hometown", "Hometown"],
  ["languages", "Languages"],
  ["family_background", "Family background"],
  ["school_life", "School life"],
  ["date_of_birth", "Date of birth"],
  ["pronouns", "Pronouns"],
  ["gender_identity", "Gender identity"],
  ["citizenship_status", "Citizenship or residency"],
  ["countries_of_citizenship", "Countries of citizenship"],
  ["birth_country", "Country of birth"],
  ["years_in_current_country", "Years in current country"],
  ["personal_email", "Personal email"],
  ["primary_phone", "Primary phone"],
  ["home_address", "Home address"],
  ["household_members", "Household members"],
  ["parent_guardian_education", "Parent or guardian education"],
  ["parent_guardian_occupations", "Parent or guardian occupations"],
  ["household_context", "Household context"],
  ["current_school", "Current school"],
  ["expected_graduation_date", "Expected graduation date"],
  ["previous_schools", "Previous schools"],
  ["curriculum_history", "Curriculum history"],
  ["school_counselor_contact", "School counselor contact"],
  ["first_language", "First language"],
  ["language_proficiency", "Language proficiency"],
] as const;

const SENSITIVE_BREAKDOWN_KEY =
  /password|credential|oauth|token|secret|passport|national[ _-]?id/i;

function getBangkokDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function sharedProfileFields(
  row: { payload: Record<string, unknown>; sharedWithFamily: boolean } | undefined,
): ParentProfileField[] {
  if (!row?.sharedWithFamily) return [];
  const fields: ParentProfileField[] = [];
  for (const [key, label] of PROFILE_FIELDS) {
    const value = row.payload[key];
    if (typeof value === "string" && value.trim()) {
      fields.push({ key, label, value: value.trim() });
      continue;
    }
    if (Array.isArray(value)) {
      const values = value.filter((part): part is string => typeof part === "string" && part.trim() !== "");
      if (values.length > 0) fields.push({ key, label, value: values });
    }
  }
  return fields;
}

/** Legacy rows can predate current write validation; family reads fail closed. */
function safeFamilyUrl(value: string | null | undefined): string | null {
  if (!value || !isSafeAdmissionsUrl(value)) return null;
  return normalizeAdmissionsUrl(value, "family URL") ?? null;
}

function sanitizeAcademicPayload(payload: AcademicRecordPayload): AcademicRecordPayload {
  return {
    ...payload,
    transcriptUrl: safeFamilyUrl(payload.transcriptUrl),
    schoolProfileUrl: safeFamilyUrl(payload.schoolProfileUrl),
  } as AcademicRecordPayload;
}

function moneyBreakdown(value: Record<string, number | null>): ParentMoneyBreakdownItem[] {
  return Object.entries(value).flatMap(([rawLabel, amount]) => {
    const label = rawLabel.trim();
    if (!label || SENSITIVE_BREAKDOWN_KEY.test(label)) return [];
    if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount))) return [];
    return [{ label, amount }];
  });
}

function sumBreakdown(value: ParentMoneyBreakdownItem[]): number {
  return value.reduce((sum, item) => sum + (item.amount ?? 0), 0);
}

function moneyNumber(value: string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const EMPTY_COMPLETENESS: AdmissionsCollegeCompleteness = {
  recsAgreed: 0,
  recsSubmitted: 0,
  recsTotal: 0,
  transcriptSent: false,
  schoolReportSent: false,
  scoreSendsSent: 0,
  complete: false,
};

/** Builds the family DTO field-by-field. Call only after requireCaseAccess. */
export async function buildParentDashboard(
  caseId: string,
  options: BuildParentDashboardOptions = {},
  db: Database = getDb(),
): Promise<ParentDashboard> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");
  const now = options.now ?? new Date();
  const todayKey = getBangkokDateKey(now);

  const [
    headerRows,
    collegeRows,
    aboutYouRows,
    scholarshipRows,
    fullProgress,
    rings,
    taskRows,
    deadlineRows,
    announcementRows,
    sittingRows,
    noteRows,
    academicRows,
    awardRows,
    activityRows,
    essayRows,
    recommenderRows,
    completenessMap,
  ] = await Promise.all([
    db.select({
      status: admissionsCases.status,
      studentFullName: admissionsStudents.fullName,
      preferredName: admissionsStudents.preferredName,
      phone: admissionsStudents.phone,
      school: admissionsStudents.school,
      schoolCounselor: admissionsStudents.schoolCounselor,
      cohortName: admissionsCohorts.name,
      graduationYear: admissionsCohorts.graduationYear,
    }).from(admissionsCases)
      .innerJoin(admissionsStudents, eq(admissionsCases.studentId, admissionsStudents.id))
      .innerJoin(admissionsCohorts, eq(admissionsCases.cohortId, admissionsCohorts.id))
      .where(and(
        eq(admissionsCases.id, caseId),
        isNull(admissionsCases.deletedAt),
        isNull(admissionsStudents.deletedAt),
      )).limit(1),
    db.select({
      id: admissionsCollegeListItems.id,
      instName: admissionsCollegeListItems.instName,
      round: admissionsCollegeListItems.round,
      deadline: admissionsCollegeListItems.deadline,
      appStatus: admissionsCollegeListItems.appStatus,
      category: admissionsCollegeListItems.category,
      firstChoiceMajor: admissionsCollegeListItems.firstChoiceMajor,
      secondChoiceMajor: admissionsCollegeListItems.secondChoiceMajor,
      admissionsUrl: admissionsCollegeListItems.admissionsUrl,
      portalUrl: admissionsCollegeListItems.portalUrl,
    }).from(admissionsCollegeListItems).where(and(
      eq(admissionsCollegeListItems.caseId, caseId),
      isNull(admissionsCollegeListItems.deletedAt),
    )).orderBy(asc(admissionsCollegeListItems.deadline), asc(admissionsCollegeListItems.instName)),
    db.select({
      payload: admissionsSelfReportSections.payload,
      sharedWithFamily: admissionsSelfReportSections.sharedWithFamily,
    }).from(admissionsSelfReportSections).where(and(
      eq(admissionsSelfReportSections.caseId, caseId),
      eq(admissionsSelfReportSections.sectionKey, "about_you"),
    )).limit(1),
    db.select({
      listItemId: admissionsScholarships.listItemId,
      name: admissionsScholarships.name,
      provider: admissionsScholarships.provider,
      url: admissionsScholarships.url,
      requirements: admissionsScholarships.requirements,
      deadline: admissionsScholarships.deadline,
      status: admissionsScholarships.status,
      outcome: admissionsScholarships.outcome,
      offeredAmount: admissionsScholarships.offeredAmount,
    }).from(admissionsScholarships).where(and(
      eq(admissionsScholarships.caseId, caseId),
      isNull(admissionsScholarships.deletedAt),
    )).orderBy(asc(admissionsScholarships.deadline), asc(admissionsScholarships.name)),
    computeProgress(caseId, db),
    getPhaseProgress(caseId, { now }, db),
    listCaseTasks(caseId, db),
    getUpcomingDeadlines(caseId, PARENT_UPCOMING_DEADLINES_LIMIT, now, db),
    listAnnouncementsForCase(caseId, db),
    listSittingsForCase(caseId, { now }, db),
    listNotesForRole(caseId, "parent", db),
    listAcademicRecordsForCase(caseId, db),
    listAwardsForCase(caseId, { includeInternalNotes: false }, db),
    listActivitiesForCase(caseId, db),
    listEssaysForCase(caseId, { now }, db),
    listRecommenders(caseId, db),
    computeCollegeCompleteness(caseId, db),
  ]);

  const header = headerRows[0];
  if (!header) throw new Error("NotFound");
  const collegeIds = collegeRows.map((row) => row.id);

  const [requirementRows, aidRows, eventRows] = collegeIds.length === 0
    ? [[], [], []] as const
    : await Promise.all([
        db.select({
          listItemId: admissionsCollegeRequirements.listItemId,
          kind: admissionsCollegeRequirements.kind,
          title: admissionsCollegeRequirements.title,
          status: admissionsCollegeRequirements.status,
          owner: admissionsCollegeRequirements.owner,
          dueDate: admissionsCollegeRequirements.dueDate,
          required: admissionsCollegeRequirements.required,
          sourceUrl: admissionsCollegeRequirements.sourceUrl,
          sortOrder: admissionsCollegeRequirements.sortOrder,
        }).from(admissionsCollegeRequirements).where(and(
          inArray(admissionsCollegeRequirements.listItemId, collegeIds),
          isNull(admissionsCollegeRequirements.deletedAt),
        )).orderBy(asc(admissionsCollegeRequirements.sortOrder)),
        db.select({
          listItemId: admissionsFinancialAidOffers.listItemId,
          currency: admissionsFinancialAidOffers.currency,
          awardYear: admissionsFinancialAidOffers.awardYear,
          costBreakdown: admissionsFinancialAidOffers.costBreakdown,
          giftAidBreakdown: admissionsFinancialAidOffers.giftAidBreakdown,
          loanBreakdown: admissionsFinancialAidOffers.loanBreakdown,
          workStudyAmount: admissionsFinancialAidOffers.workStudyAmount,
          netCost: admissionsFinancialAidOffers.netCost,
          remainingBalance: admissionsFinancialAidOffers.remainingBalance,
        }).from(admissionsFinancialAidOffers).where(
          inArray(admissionsFinancialAidOffers.listItemId, collegeIds),
        ),
        db.select({
          listItemId: admissionsApplicationEvents.listItemId,
          event: admissionsApplicationEvents.event,
          eventDate: admissionsApplicationEvents.eventDate,
          createdAt: admissionsApplicationEvents.createdAt,
        }).from(admissionsApplicationEvents).where(
          inArray(admissionsApplicationEvents.listItemId, collegeIds),
        ).orderBy(asc(admissionsApplicationEvents.eventDate), asc(admissionsApplicationEvents.createdAt)),
      ]);

  const collegeNameById = new Map(collegeRows.map((row) => [row.id, row.instName]));
  const requirementsByCollege = new Map<string, ParentCollegeRequirement[]>();
  for (const row of requirementRows) {
    const requirement: ParentCollegeRequirement = {
      kind: row.kind as CollegeRequirementKind,
      title: row.title,
      status: row.status,
      owner: row.owner,
      dueDate: row.dueDate,
      required: row.required,
      sourceUrl: safeFamilyUrl(row.sourceUrl),
    };
    const list = requirementsByCollege.get(row.listItemId);
    if (list) list.push(requirement);
    else requirementsByCollege.set(row.listItemId, [requirement]);
  }

  const decisionsByCollege = new Map<string, ParentCollegeDecision[]>();
  for (const row of eventRows) {
    const decision: ParentCollegeDecision = { event: row.event, eventDate: row.eventDate };
    const list = decisionsByCollege.get(row.listItemId);
    if (list) list.push(decision);
    else decisionsByCollege.set(row.listItemId, [decision]);
  }

  const collegeList: ParentCollegeListEntry[] = collegeRows.map((row) => ({
    instName: row.instName,
    round: row.round,
    roundLabel: ADMISSIONS_APP_ROUND_LABELS[row.round],
    appStatus: row.appStatus,
    deadline: row.deadline,
    category: row.category,
    firstChoiceMajor: row.firstChoiceMajor,
    secondChoiceMajor: row.secondChoiceMajor,
    admissionsUrl: safeFamilyUrl(row.admissionsUrl),
    portalUrl: safeFamilyUrl(row.portalUrl),
    completeness: completenessMap.get(row.id) ?? { ...EMPTY_COMPLETENESS },
    decisions: decisionsByCollege.get(row.id) ?? [],
    requirements: requirementsByCollege.get(row.id) ?? [],
  }));

  const profile: ParentProfile = {
    preferredName: header.preferredName,
    phone: header.phone,
    school: header.school,
    schoolCounselor: header.schoolCounselor,
    graduationYear: header.graduationYear,
    sharedDetails: sharedProfileFields(aboutYouRows[0]),
  };

  const academics: ParentAcademicRecord[] = academicRows.map((row) => ({
    system: row.system,
    effectiveDate: row.effectiveDate,
    payload: sanitizeAcademicPayload(row.payload),
  }));

  const checklist: ParentChecklistItem[] = taskRows.map((row) => ({
    phase: row.phase,
    title: row.title,
    description: row.description,
    owner: row.owner,
    status: row.status,
    dueDate: row.dueDate,
    recurrence: row.recurrence,
  }));

  const recommenders: ParentRecommender[] = recommenderRows.map((row) => ({
    name: row.name,
    roleSubject: row.roleSubject,
    askStatus: row.askStatus,
    colleges: row.colleges.flatMap((link) => {
      const collegeName = collegeNameById.get(link.listItemId);
      return collegeName
        ? [{ collegeName, submitted: link.submitted, submittedAt: link.submittedAt }]
        : [];
    }),
  }));

  const essays: ParentEssay[] = essayRows.map((row) => {
    const essay: ParentEssay = {
      collegeName: row.listItemId ? collegeNameById.get(row.listItemId) ?? null : null,
      prompt: row.prompt,
      status: row.status,
      deadline: row.deadline,
    };
    const googleDocUrl = row.sharedWithFamily ? safeFamilyUrl(row.driveUrl) : null;
    if (googleDocUrl) essay.googleDocUrl = googleDocUrl;
    return essay;
  });

  const activities: ParentActivity[] = activityRows.map((row) => ({
    name: row.name,
    fullDescription: row.fullDescription,
    commonApp: row.commonApp,
    uc: row.uc,
    commonAppRank: row.commonAppRank,
  }));

  const awards: ParentAward[] = awardRows.map((row) => ({
    title: row.title,
    organization: row.organization,
    gradeLevels: row.gradeLevels,
    recognitionLevels: row.recognitionLevels,
    awardDate: row.awardDate,
    commonAppRank: row.commonAppRank,
    ucEligibilityNarrative: row.ucEligibilityNarrative,
    ucAchievementNarrative: row.ucAchievementNarrative,
  }));

  const testingMilestones: ParentTestingMilestone[] = sittingRows.map((sitting) => {
    const status = sitting.status ?? "planned";
    const milestone: ParentTestingMilestone = {
      testType: sitting.testType,
      subject: sitting.subject ?? null,
      testDate: sitting.testDate,
      registrationDeadline: sitting.registrationDeadline,
      lateRegistrationDeadline: sitting.lateRegistrationDeadline ?? null,
      status,
      registered:
        status !== "planned" && status !== "canceled" ||
        sitting.registrationDeadline === null ||
        sitting.registrationDeadline < todayKey,
      taken:
        status === "taken" ||
        status === "score_received" ||
        sitting.testDate < todayKey,
      scoreReceived: sitting.actualScore !== null || (sitting.scoreDetails ?? null) !== null,
    };
    if (sitting.scoreReleasedToParent) {
      if (sitting.scoreDetails != null) milestone.scoreDetails = sitting.scoreDetails;
      if (sitting.actualScore !== null) {
        const numericScore = parseScoreValue(sitting.actualScore);
        if (numericScore !== null) milestone.score = numericScore;
      }
    }
    return milestone;
  });

  const scholarships: ParentScholarship[] = scholarshipRows.map((row) => ({
    collegeName: row.listItemId ? collegeNameById.get(row.listItemId) ?? null : null,
    name: row.name,
    provider: row.provider,
    url: safeFamilyUrl(row.url),
    requirements: row.requirements,
    deadline: row.deadline,
    status: row.status as ScholarshipStatus,
    outcome: row.outcome,
    offeredAmount: row.offeredAmount,
  }));

  const financialAid: ParentFinancialAidOffer[] = aidRows.flatMap((row) => {
    const collegeName = collegeNameById.get(row.listItemId);
    if (!collegeName) return [];
    const costBreakdown = moneyBreakdown(row.costBreakdown);
    const giftAidBreakdown = moneyBreakdown(row.giftAidBreakdown);
    const loanBreakdown = moneyBreakdown(row.loanBreakdown);
    const totalCost = sumBreakdown(costBreakdown);
    const totalGiftAid = sumBreakdown(giftAidBreakdown);
    const totalLoans = sumBreakdown(loanBreakdown);
    const derivedNetCost = row.netCost === null
      ? Math.max(0, totalCost - totalGiftAid)
      : moneyNumber(row.netCost);
    const derivedRemainingBalance = row.remainingBalance === null
      ? Math.max(0, derivedNetCost - totalLoans - moneyNumber(row.workStudyAmount))
      : moneyNumber(row.remainingBalance);
    return [{
      collegeName,
      currency: row.currency,
      awardYear: row.awardYear,
      costBreakdown,
      giftAidBreakdown,
      loanBreakdown,
      workStudyAmount: row.workStudyAmount,
      netCost: row.netCost,
      remainingBalance: row.remainingBalance,
      totalCost,
      totalGiftAid,
      totalLoans,
      derivedNetCost,
      derivedRemainingBalance,
    }];
  });

  return {
    studentName: header.studentFullName,
    cohortName: header.cohortName,
    caseStatus: header.status,
    profile,
    academics,
    progress: {
      done: fullProgress.done,
      total: fullProgress.total,
      percent: fullProgress.percent,
    },
    phaseProgress: rings.map((ring) => ({
      phase: ring.phase,
      label: ring.label,
      done: ring.done,
      total: ring.total,
      percent: ring.percent,
    })),
    checklist,
    collegeList,
    recommenders,
    essays,
    activities,
    awards,
    upcomingDeadlines: deadlineRows.map((item) => ({
      source: item.source,
      title: item.title,
      date: item.date,
      overdue: item.overdue,
    })),
    announcements: announcementRows.slice(0, PARENT_ANNOUNCEMENTS_LIMIT).map((row) => ({
      title: row.title,
      body: row.body,
      createdAt: row.createdAt,
    })),
    testingMilestones,
    scholarships,
    financialAid,
    sharedNotes: noteRows
      .filter((note) => note.visibility === "shared_with_family")
      .map((note) => ({ body: note.body, createdAt: note.createdAt })),
  };
}

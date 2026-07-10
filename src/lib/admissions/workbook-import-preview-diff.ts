import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "@/lib/db";
import {
  admissionsActivities,
  admissionsAwards,
  admissionsCaseMeetings,
  admissionsCaseTasks,
  admissionsCollegeDocs,
  admissionsCollegeListItems,
  admissionsCollegeRequirements,
  admissionsCollegeResearch,
  admissionsEssays,
  admissionsFinancialAidOffers,
  admissionsImportMappings,
  admissionsImportRuns,
  admissionsInterestEvents,
  admissionsScholarships,
  admissionsTestSittings,
} from "@/lib/db/schema";
import {
  ADMISSIONS_ACTIVITY_GRADES,
  COMMON_APP_HOURS_PER_WEEK_MAX,
  COMMON_APP_WEEKS_PER_YEAR_MAX,
  MAX_ACTIVE_ACTIVITIES_PER_CASE,
  type AdmissionsCommonAppBlock,
  type AdmissionsUcBlock,
  type UcActivityCategory,
} from "./shared/activities";
import { getScoreDetailsAggregate } from "./shared/testing";
import {
  importedApplicationRequirements,
  joinImportedNotes,
  mapImportedApplicationStatus,
  mapImportedEssayStatus,
  mapImportedRound,
  mapImportedScholarshipStatus,
  mapImportedTaskStatus,
  mapImportedUcCategory,
  sumImportedValues,
} from "./workbook-import-commit";
import {
  normalizeImportedSentStatus,
  normalizeImportedTestScoreDetails,
  type AdmissionsWorkbookPreview,
} from "./workbook-import";

function normalizedKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sourceIdentity(value: { sourceRef?: string }, fallback: string): string {
  return value.sourceRef?.trim() || fallback;
}

function lookupKey(sourceType: string, sourceKey: string): string {
  return `${sourceType}\u0000${sourceKey}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function appendFieldChanges(
  preview: AdmissionsWorkbookPreview,
  target: string,
  current: Record<string, unknown> | null | undefined,
  desired: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const oldValue = current?.[field] ?? null;
    const newValue = desired[field] ?? null;
    if (!sameValue(oldValue, newValue)) {
      preview.changes.push({ target, field, oldValue, newValue });
    }
  }
}

interface PriorTarget {
  sourceType: string;
  sourceKey: string;
  targetType: string;
  targetId: string;
}

async function loadPriorTargets(
  db: Database,
  caseId: string,
  spreadsheetId: string,
): Promise<Map<string, PriorTarget>> {
  const runs = await db.select({
    id: admissionsImportRuns.id,
    committedAt: admissionsImportRuns.committedAt,
    createdAt: admissionsImportRuns.createdAt,
  }).from(admissionsImportRuns).where(and(
    eq(admissionsImportRuns.caseId, caseId),
    eq(admissionsImportRuns.spreadsheetId, spreadsheetId),
    eq(admissionsImportRuns.status, "committed"),
  )).orderBy(desc(admissionsImportRuns.committedAt), desc(admissionsImportRuns.createdAt));
  if (!runs.length) return new Map();

  const rows = await db.select({
    runId: admissionsImportMappings.runId,
    sourceType: admissionsImportMappings.sourceType,
    sourceKey: admissionsImportMappings.sourceKey,
    targetType: admissionsImportMappings.targetType,
    targetId: admissionsImportMappings.targetId,
  }).from(admissionsImportMappings).where(inArray(
    admissionsImportMappings.runId,
    runs.map((run) => run.id),
  ));
  const priority = new Map(runs.map((run, index) => [run.id, index]));
  rows.sort((left, right) =>
    (priority.get(left.runId) ?? Number.MAX_SAFE_INTEGER) -
    (priority.get(right.runId) ?? Number.MAX_SAFE_INTEGER));
  const result = new Map<string, PriorTarget>();
  for (const row of rows) {
    const key = lookupKey(row.sourceType, row.sourceKey);
    if (!result.has(key)) result.set(key, row);
  }
  return result;
}

function mappedTargetId(
  mappings: Map<string, PriorTarget>,
  sourceType: string,
  sourceKey: string,
  targetType: string,
): string | null {
  const mapping = mappings.get(lookupKey(sourceType, sourceKey));
  return mapping?.targetType === targetType ? mapping.targetId : null;
}

/**
 * Adds the exact field-level mutations a confirmed overwrite import can make.
 * Stable worksheet references plus committed source mappings ensure a renamed
 * or edited row is compared with its original target instead of a new record.
 */
export async function appendAdmissionsWorkbookEntityChanges(input: {
  db: Database;
  caseId: string;
  preview: AdmissionsWorkbookPreview;
  /** Lightweight rows already loaded by the case-aware preview service. */
  activityCapRows?: Array<{ id: string; name: string }>;
}): Promise<void> {
  const { db, caseId, preview } = input;
  const [
    priorTargets,
    meetingRows,
    taskRows,
    activityRows,
    awardRows,
    testRows,
    essayRows,
    scholarshipRows,
    collegeRows,
  ] = await Promise.all([
    loadPriorTargets(db, caseId, preview.spreadsheetId),
    db.select().from(admissionsCaseMeetings).where(and(
      eq(admissionsCaseMeetings.caseId, caseId),
      isNull(admissionsCaseMeetings.deletedAt),
    )),
    db.select().from(admissionsCaseTasks).where(and(
      eq(admissionsCaseTasks.caseId, caseId),
      isNull(admissionsCaseTasks.deletedAt),
    )),
    db.select().from(admissionsActivities).where(and(
      eq(admissionsActivities.caseId, caseId),
      isNull(admissionsActivities.deletedAt),
    )),
    db.select().from(admissionsAwards).where(and(
      eq(admissionsAwards.caseId, caseId),
      isNull(admissionsAwards.deletedAt),
    )),
    db.select().from(admissionsTestSittings).where(and(
      eq(admissionsTestSittings.caseId, caseId),
      isNull(admissionsTestSittings.deletedAt),
    )),
    db.select().from(admissionsEssays).where(and(
      eq(admissionsEssays.caseId, caseId),
      isNull(admissionsEssays.deletedAt),
    )),
    db.select().from(admissionsScholarships).where(and(
      eq(admissionsScholarships.caseId, caseId),
      isNull(admissionsScholarships.deletedAt),
    )),
    db.select().from(admissionsCollegeListItems).where(and(
      eq(admissionsCollegeListItems.caseId, caseId),
      isNull(admissionsCollegeListItems.deletedAt),
    )),
  ]);

  const capRows = input.activityCapRows ?? activityRows;
  const capActivityById = new Map(capRows.map((row) => [row.id, row]));
  const capActivityByName = new Map(capRows.map((row) => [normalizedKey(row.name), row]));
  const newActivityNames = new Set<string>();
  for (const [index, activity] of preview.activities.entries()) {
    const nameKey = normalizedKey(activity.name);
    if (!nameKey) continue;
    const sourceKey = sourceIdentity(activity, `${index}:${nameKey}`);
    const mappedId = mappedTargetId(
      priorTargets,
      "activity",
      sourceKey,
      "activity",
    );
    if ((mappedId && capActivityById.has(mappedId)) || capActivityByName.has(nameKey)) continue;
    newActivityNames.add(nameKey);
  }
  const liveActivitiesAfterImport = capRows.length + newActivityNames.size;
  preview.counts.liveActivitiesAfterImport = liveActivitiesAfterImport;
  if (liveActivitiesAfterImport > MAX_ACTIVE_ACTIVITIES_PER_CASE) {
    preview.issues.push({
      severity: "error",
      code: "activity_limit_exceeded",
      sheetName: "Activities -",
      range: "A1:U278",
      message: `Import would create ${liveActivitiesAfterImport} live activities; the case limit is ${MAX_ACTIVE_ACTIVITIES_PER_CASE}.`,
    });
  }

  const presentSourceKeys = new Map<string, Set<string>>();
  const markPresent = (sourceType: string, values: Array<{ sourceRef?: string }>) => {
    const keys = new Set(values.flatMap((value) => {
      const sourceRef = value.sourceRef?.trim();
      return sourceRef ? [sourceRef] : [];
    }));
    presentSourceKeys.set(sourceType, keys);
  };
  markPresent("meeting", preview.meetings);
  markPresent("task", preview.tasks);
  markPresent("activity", preview.activities);
  markPresent("award", preview.awards);
  markPresent("test_sitting", preview.tests);
  markPresent("application", preview.applications);
  markPresent("college_research", preview.research);
  markPresent("interest_event", preview.interestEvents);
  markPresent("essay_prompt", preview.essayPrompts);
  markPresent("financial_aid", preview.financialAid);
  markPresent("scholarship", preview.scholarships);
  const sourceSheets: Record<string, string> = {
    meeting: "Meetings",
    task: "Tasks",
    activity: "Activities -",
    award: "Activities -",
    test_sitting: "Tests",
    application: "ApplicationTracker",
    college_research: "Research Notes",
    interest_event: "Demonstrate Interest",
    essay_prompt: "Essay Prompts",
    financial_aid: " FinAidComparisons",
    scholarship: "ScholarshipTracker",
  };
  const targetsStillRepresented = new Set<string>();
  for (const [key, mapping] of priorTargets) {
    const separator = key.indexOf("\u0000");
    const sourceType = separator >= 0 ? key.slice(0, separator) : mapping.sourceType;
    const sourceKey = separator >= 0 ? key.slice(separator + 1) : mapping.sourceKey;
    if (presentSourceKeys.get(sourceType)?.has(sourceKey)) {
      targetsStillRepresented.add(`${sourceType}\u0000${mapping.targetId}`);
    }
  }
  for (const mapping of priorTargets.values()) {
    const sheetName = sourceSheets[mapping.sourceType];
    if (!sheetName || presentSourceKeys.get(mapping.sourceType)?.has(mapping.sourceKey)) continue;
    if (targetsStillRepresented.has(`${mapping.sourceType}\u0000${mapping.targetId}`)) continue;
    preview.issues.push({
      severity: "warning",
      code: "previously_imported_source_missing",
      sheetName,
      range: mapping.sourceKey,
      message: `Previously imported source ${mapping.sourceKey} is absent from this workbook preview. Its existing application record will be kept; delete it manually if removal is intended.`,
    });
  }

  const collegeIds = collegeRows.map((row) => row.id);
  const [researchRows, interestRows, requirementRows, aidRows, transcriptRows] =
    collegeIds.length
      ? await Promise.all([
          db.select().from(admissionsCollegeResearch).where(inArray(
            admissionsCollegeResearch.listItemId,
            collegeIds,
          )),
          db.select().from(admissionsInterestEvents).where(and(
            inArray(admissionsInterestEvents.listItemId, collegeIds),
            isNull(admissionsInterestEvents.deletedAt),
          )),
          db.select().from(admissionsCollegeRequirements).where(and(
            inArray(admissionsCollegeRequirements.listItemId, collegeIds),
            isNull(admissionsCollegeRequirements.deletedAt),
          )),
          db.select().from(admissionsFinancialAidOffers).where(inArray(
            admissionsFinancialAidOffers.listItemId,
            collegeIds,
          )),
          db.select().from(admissionsCollegeDocs).where(and(
            inArray(admissionsCollegeDocs.listItemId, collegeIds),
            eq(admissionsCollegeDocs.docType, "transcript"),
            isNull(admissionsCollegeDocs.testSittingId),
          )),
        ])
      : [[], [], [], [], []] as const;

  const collegeById = new Map(collegeRows.map((row) => [row.id, row]));
  const collegeByName = new Map(collegeRows.map((row) => [normalizedKey(row.instName), row]));
  const collegeTargetByName = new Map<string, string>();
  const collegeSources = [
    ...preview.applications.map((item, index) => ({
      item,
      sourceType: "application",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
    })),
    ...preview.research.map((item, index) => ({
      item,
      sourceType: "college_research_list_item",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
    })),
    ...preview.interestEvents.map((item, index) => ({
      item,
      sourceType: "interest_event_list_item",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
    })),
    ...preview.essayPrompts.map((item, index) => ({
      item,
      sourceType: "essay_prompt_list_item",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
    })),
    ...preview.financialAid.map((item, index) => ({
      item,
      sourceType: "financial_aid_list_item",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
    })),
    ...preview.scholarships.flatMap((item, index) => item.collegeName ? [{
      item: { ...item, collegeName: item.collegeName },
      sourceType: "scholarship_list_item",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
    }] : []),
  ];
  const collegeSourcesByName = new Map<string, typeof collegeSources>();
  for (const source of collegeSources) {
    const nameKey = normalizedKey(source.item.collegeName);
    collegeSourcesByName.set(nameKey, [
      ...(collegeSourcesByName.get(nameKey) ?? []),
      source,
    ]);
  }
  for (const [nameKey, sources] of collegeSourcesByName) {
    const mappedId = sources.flatMap((source) => {
      const targetId = mappedTargetId(
        priorTargets,
        source.sourceType,
        source.sourceKey,
        "college_list_item",
      );
      return targetId ? [targetId] : [];
    })[0];
    const current = (mappedId ? collegeById.get(mappedId) : undefined) ??
      collegeByName.get(nameKey);
    if (current) collegeTargetByName.set(nameKey, current.id);
    const applicationSource = sources.find((source) => source.sourceType === "application");
    const application = applicationSource?.item;
    if (applicationSource && application && "overallStatus" in application) {
      appendFieldChanges(preview, `college:${applicationSource.sourceKey}`, current, {
        instName: application.collegeName.trim(),
        round: mapImportedRound(application.round),
        deadline: application.deadline,
        appStatus: mapImportedApplicationStatus(application.overallStatus),
        firstChoiceMajor: application.firstChoiceMajor,
        secondChoiceMajor: application.secondChoiceMajor,
        admissionsUrl: application.admissionsUrl,
        portalUrl: application.portalUrl,
        aidOffered: application.scholarshipAmount == null
          ? null
          : String(application.scholarshipAmount),
        aidNotes: joinImportedNotes(
          application.scholarshipType
            ? `Scholarship type: ${application.scholarshipType}`
            : null,
          application.notes,
        ),
      }, [
        "instName",
        "round",
        "deadline",
        "appStatus",
        "firstChoiceMajor",
        "secondChoiceMajor",
        "admissionsUrl",
        "portalUrl",
        "aidOffered",
        "aidNotes",
      ]);
    }
  }
  // The basic service warns for unknown names before mappings are loaded. A
  // renamed source row that still maps to a live college is not a new manual
  // college, so remove that now-proven false warning.
  for (let index = preview.issues.length - 1; index >= 0; index -= 1) {
    const issue = preview.issues[index];
    if (
      issue?.code === "unresolved_college" &&
      issue.range &&
      collegeTargetByName.has(normalizedKey(issue.range))
    ) {
      preview.issues.splice(index, 1);
    }
  }

  const meetingsById = new Map(meetingRows.map((row) => [row.id, row]));
  const meetingsByNaturalKey = new Map(meetingRows.map((row) => [
    `${row.meetingDate}|${normalizedKey(row.notes)}`,
    row,
  ]));
  for (const [index, meeting] of preview.meetings.filter((item) => item.meetingDate).entries()) {
    const notes = joinImportedNotes(
      meeting.notes,
      meeting.nextSteps ? `Next steps: ${meeting.nextSteps}` : null,
    );
    const naturalKey = `${meeting.meetingDate}|${normalizedKey(notes)}`;
    const sourceKey = sourceIdentity(meeting, `${index}:${naturalKey}`);
    const current = meetingsById.get(mappedTargetId(
      priorTargets,
      "meeting",
      sourceKey,
      "meeting",
    ) ?? "") ?? meetingsByNaturalKey.get(naturalKey);
    appendFieldChanges(preview, `meeting:${sourceKey}`, current, {
      meetingDate: meeting.meetingDate,
      mode: joinImportedNotes(meeting.status, meeting.time),
      attendees: [],
      notes,
    }, ["meetingDate", "mode", "attendees", "notes"]);
  }

  const tasksById = new Map(taskRows.map((row) => [row.id, row]));
  const tasksByNaturalKey = new Map(taskRows.map((row) => [
    `${normalizedKey(row.title)}|${row.dueDate ?? ""}`,
    row,
  ]));
  for (const [index, task] of preview.tasks.entries()) {
    const naturalKey = `${normalizedKey(task.title)}|${task.dueDate ?? ""}`;
    const sourceKey = sourceIdentity(task, `${index}:${naturalKey}`);
    const current = tasksById.get(mappedTargetId(
      priorTargets,
      "task",
      sourceKey,
      "task",
    ) ?? "") ?? tasksByNaturalKey.get(naturalKey);
    appendFieldChanges(preview, `task:${sourceKey}`, current, {
      phase: "about_you",
      title: task.title,
      description: joinImportedNotes(
        task.instructions,
        task.resourceUrl ? `Resource: ${task.resourceUrl}` : null,
        task.notes,
        task.startDate ? `Legacy start date: ${task.startDate}` : null,
      ),
      owner: "student",
      status: mapImportedTaskStatus(task.status),
      dueDate: task.dueDate,
      sortOrder: index,
    }, ["phase", "title", "description", "owner", "status", "dueDate", "sortOrder"]);
  }

  const activitiesById = new Map(activityRows.map((row) => [row.id, row]));
  const activitiesByName = new Map(activityRows.map((row) => [normalizedKey(row.name), row]));
  for (const [index, activity] of preview.activities.entries()) {
    const naturalKey = normalizedKey(activity.name);
    const sourceKey = sourceIdentity(activity, `${index}:${naturalKey}`);
    const current = activitiesById.get(mappedTargetId(
      priorTargets,
      "activity",
      sourceKey,
      "activity",
    ) ?? "") ?? activitiesByName.get(naturalKey);
    const commonApp: AdmissionsCommonAppBlock = {
      ...(activity.commonApp?.position ? { position: activity.commonApp.position } : {}),
      ...(activity.commonApp?.organization ? { organization: activity.commonApp.organization } : {}),
      ...(activity.commonApp?.description ? { description: activity.commonApp.description } : {}),
      grades: activity.gradeLevels.filter((grade): grade is (typeof ADMISSIONS_ACTIVITY_GRADES)[number] =>
        ADMISSIONS_ACTIVITY_GRADES.includes(grade as (typeof ADMISSIONS_ACTIVITY_GRADES)[number])),
      ...(activity.hoursPerWeek !== null &&
      activity.hoursPerWeek >= 0 &&
      activity.hoursPerWeek <= COMMON_APP_HOURS_PER_WEEK_MAX
        ? { hrsWeek: activity.hoursPerWeek }
        : {}),
      ...(activity.weeksPerYear !== null &&
      Number.isInteger(activity.weeksPerYear) &&
      activity.weeksPerYear >= 0 &&
      activity.weeksPerYear <= COMMON_APP_WEEKS_PER_YEAR_MAX
        ? { weeksYear: activity.weeksPerYear }
        : {}),
    };
    const ucCategory = activity.uc?.category
      ? mapImportedUcCategory(activity.uc.category) as UcActivityCategory | null
      : null;
    const uc: AdmissionsUcBlock | null = activity.uc
      ? {
          ...(ucCategory ? { category: ucCategory } : {}),
          ...(activity.uc.description ? { description: activity.uc.description } : {}),
        }
      : null;
    appendFieldChanges(preview, `activity:${sourceKey}`, current, {
      name: activity.name,
      fullDescription: joinImportedNotes(
        activity.fullDescription,
        activity.uc?.category && !ucCategory
          ? `Legacy UC category: ${activity.uc.category}`
          : null,
      ),
      commonApp,
      uc,
      sortOrder: index,
    }, ["name", "fullDescription", "commonApp", "uc", "sortOrder"]);
  }

  const awardsById = new Map(awardRows.map((row) => [row.id, row]));
  const awardsByNaturalKey = new Map(awardRows.map((row) => [
    `${normalizedKey(row.title)}|${normalizedKey(row.organization)}`,
    row,
  ]));
  for (const [index, award] of preview.awards.entries()) {
    const naturalKey = `${normalizedKey(award.title)}|${normalizedKey(award.organization)}`;
    const sourceKey = sourceIdentity(award, `${index}:${naturalKey}`);
    const current = awardsById.get(mappedTargetId(
      priorTargets,
      "award",
      sourceKey,
      "award",
    ) ?? "") ?? awardsByNaturalKey.get(naturalKey);
    appendFieldChanges(preview, `award:${sourceKey}`, current, {
      title: award.title,
      organization: award.organization,
      gradeLevels: award.gradeLevels,
      recognitionLevels: award.recognitionLevels,
      ucEligibilityNarrative: award.eligibilityNarrative,
      ucAchievementNarrative: award.achievementNarrative,
    }, [
      "title",
      "organization",
      "gradeLevels",
      "recognitionLevels",
      "ucEligibilityNarrative",
      "ucAchievementNarrative",
    ]);
  }

  const testsById = new Map(testRows.map((row) => [row.id, row]));
  const testsByNaturalKey = new Map(testRows.map((row) => [
    `${row.testType}|${row.testDate}|${normalizedKey(row.subject)}`,
    row,
  ]));
  for (const [index, sitting] of preview.tests.filter((item) => item.testDate).entries()) {
    const testType = ["sat", "act", "ap", "ib", "toefl", "ielts"].includes(sitting.testType)
      ? sitting.testType
      : "other";
    const naturalKey = `${testType}|${sitting.testDate}|${normalizedKey(sitting.subject)}`;
    const sourceKey = sourceIdentity(sitting, `${index}:${naturalKey}`);
    const current = testsById.get(mappedTargetId(
      priorTargets,
      "test_sitting",
      sourceKey,
      "test_sitting",
    ) ?? "") ?? testsByNaturalKey.get(naturalKey);
    const details = normalizeImportedTestScoreDetails({ ...sitting, testType });
    appendFieldChanges(preview, `test_sitting:${sourceKey}`, current, {
      testType,
      testDate: sitting.testDate,
      subject: sitting.subject,
      actualScore: details ? getScoreDetailsAggregate(details) : null,
      scoreDetails: details,
      status: details ? "score_received" : "taken",
      // Workbook rows never own counselor targets or the explicit family
      // release switch. Inserts use the safe defaults; updates retain the
      // stored values and therefore must not advertise a reset in preview.
      targetScore: current?.targetScore ?? "",
      scoreReleasedToParent: current?.scoreReleasedToParent ?? false,
    }, [
      "testType",
      "testDate",
      "subject",
      "targetScore",
      "actualScore",
      "scoreDetails",
      "status",
      "scoreReleasedToParent",
    ]);
  }

  const researchById = new Map(researchRows.map((row) => [row.id, row]));
  const researchByCollege = new Map(researchRows.map((row) => [row.listItemId, row]));
  for (const [index, research] of preview.research.entries()) {
    const sourceKey = sourceIdentity(research, `${index}:${normalizedKey(research.collegeName)}`);
    const listItemId = collegeTargetByName.get(normalizedKey(research.collegeName)) ?? null;
    const current = researchById.get(mappedTargetId(
      priorTargets,
      "college_research",
      sourceKey,
      "college_research",
    ) ?? "") ?? (listItemId ? researchByCollege.get(listItemId) : undefined);
    appendFieldChanges(preview, `college_research:${sourceKey}`, current, {
      sources: research.sources.map((label) => ({ label })),
      campusVisitNotes: research.campusVisitNotes,
      academicNotes: research.academicNotes,
      questions: research.questions,
      notes: joinImportedNotes(
        research.fitAssessment ? `Fit assessment: ${research.fitAssessment}` : null,
        research.generalNotes,
      ),
    }, ["sources", "campusVisitNotes", "academicNotes", "questions", "notes"]);
  }

  const interestById = new Map(interestRows.map((row) => [row.id, row]));
  const interestByNaturalKey = new Map(interestRows.map((row) => [
    `${row.listItemId}|${row.eventDate}|${normalizedKey(row.notes)}`,
    row,
  ]));
  for (const [index, event] of preview.interestEvents.filter((item) => item.eventDate).entries()) {
    const listItemId = collegeTargetByName.get(normalizedKey(event.collegeName)) ?? null;
    const naturalKey = `${listItemId ?? ""}|${event.eventDate}|${normalizedKey(event.notes)}`;
    const sourceKey = sourceIdentity(
      event,
      `${index}:${normalizedKey(event.collegeName)}:${event.eventDate}`,
    );
    const current = interestById.get(mappedTargetId(
      priorTargets,
      "interest_event",
      sourceKey,
      "interest_event",
    ) ?? "") ?? interestByNaturalKey.get(naturalKey);
    appendFieldChanges(preview, `interest_event:${sourceKey}`, current, {
      listItemId,
      type: "other",
      eventDate: event.eventDate,
      notes: event.notes,
    }, ["listItemId", "type", "eventDate", "notes"]);
  }

  const requirementsById = new Map(requirementRows.map((row) => [row.id, row]));
  const requirementsByNaturalKey = new Map(requirementRows.map((row) => [
    `${row.listItemId}|${row.kind}|${normalizedKey(row.title)}`,
    row,
  ]));
  const importedRequirements = preview.applications.flatMap((application) =>
    importedApplicationRequirements(application).map((requirement) => ({ application, requirement })));
  for (const [index, { application, requirement }] of importedRequirements.entries()) {
    const listItemId = collegeTargetByName.get(normalizedKey(application.collegeName)) ?? null;
    const sourceKey = `${sourceIdentity(
      application,
      normalizedKey(application.collegeName),
    )}:${requirement.kind}`;
    const naturalKey = `${listItemId ?? ""}|${requirement.kind}|${normalizedKey(requirement.title)}`;
    const current = requirementsById.get(mappedTargetId(
      priorTargets,
      "college_requirement",
      sourceKey,
      "college_requirement",
    ) ?? "") ?? requirementsByNaturalKey.get(naturalKey);
    appendFieldChanges(preview, `college_requirement:${sourceKey}`, current, {
      listItemId,
      kind: requirement.kind,
      title: requirement.title,
      status: mapImportedTaskStatus(requirement.status),
      owner: "student",
      dueDate: requirement.dueDate,
      required: true,
      sourceUrl: requirement.sourceUrl,
      notes: requirement.notes,
      sortOrder: index,
    }, [
      "listItemId",
      "kind",
      "title",
      "status",
      "owner",
      "dueDate",
      "required",
      "sourceUrl",
      "notes",
      "sortOrder",
    ]);
  }

  const essaysById = new Map(essayRows.map((row) => [row.id, row]));
  const essaysByNaturalKey = new Map(essayRows.map((row) => [
    `${row.listItemId ?? ""}|${normalizedKey(row.prompt)}`,
    row,
  ]));
  const applicationByName = new Map(preview.applications.map((application) => [
    normalizedKey(application.collegeName),
    application,
  ]));
  for (const [index, essay] of preview.essayPrompts.entries()) {
    const listItemId = collegeTargetByName.get(normalizedKey(essay.collegeName)) ?? null;
    const naturalKey = `${listItemId ?? ""}|${normalizedKey(essay.prompt)}`;
    const sourceKey = sourceIdentity(
      essay,
      `${index}:${normalizedKey(essay.collegeName)}:${normalizedKey(essay.prompt)}`,
    );
    const current = essaysById.get(mappedTargetId(
      priorTargets,
      "essay_prompt",
      sourceKey,
      "essay",
    ) ?? "") ?? essaysByNaturalKey.get(naturalKey);
    appendFieldChanges(preview, `essay:${sourceKey}`, current, {
      listItemId,
      prompt: essay.prompt,
      status: mapImportedEssayStatus(essay.status),
      deadline: applicationByName.get(normalizedKey(essay.collegeName))?.deadline ?? null,
    }, ["listItemId", "prompt", "status", "deadline"]);
  }

  const aidById = new Map(aidRows.map((row) => [row.id, row]));
  const aidByCollege = new Map(aidRows.map((row) => [row.listItemId, row]));
  for (const [index, offer] of preview.financialAid.entries()) {
    const sourceKey = sourceIdentity(offer, `${index}:${normalizedKey(offer.collegeName)}`);
    const listItemId = collegeTargetByName.get(normalizedKey(offer.collegeName)) ?? null;
    const current = aidById.get(mappedTargetId(
      priorTargets,
      "financial_aid",
      sourceKey,
      "financial_aid_offer",
    ) ?? "") ?? (listItemId ? aidByCollege.get(listItemId) : undefined);
    const { workStudy = 0, ...loanBreakdown } = offer.loans;
    appendFieldChanges(preview, `financial_aid:${sourceKey}`, current, {
      listItemId,
      currency: "USD",
      awardYear: offer.awardYear ?? current?.awardYear ?? null,
      costBreakdown: offer.cost,
      giftAidBreakdown: offer.giftAid,
      loanBreakdown,
      workStudyAmount: String(workStudy),
      netCost: String(Math.max(0, sumImportedValues(offer.cost) - sumImportedValues(offer.giftAid))),
      remainingBalance: offer.remainingBalance == null ? null : String(offer.remainingBalance),
      notes: "Imported from the archived student workbook.",
    }, [
      "listItemId",
      "currency",
      "awardYear",
      "costBreakdown",
      "giftAidBreakdown",
      "loanBreakdown",
      "workStudyAmount",
      "netCost",
      "remainingBalance",
      "notes",
    ]);
  }

  const scholarshipsById = new Map(scholarshipRows.map((row) => [row.id, row]));
  const scholarshipsByNaturalKey = new Map(scholarshipRows.map((row) => [
    `${normalizedKey(row.name)}|${normalizedKey(row.provider)}`,
    row,
  ]));
  for (const [index, scholarship] of preview.scholarships.entries()) {
    const naturalKey = `${normalizedKey(scholarship.name)}|${normalizedKey(scholarship.provider)}`;
    const sourceKey = sourceIdentity(scholarship, `${index}:${naturalKey}`);
    const current = scholarshipsById.get(mappedTargetId(
      priorTargets,
      "scholarship",
      sourceKey,
      "scholarship",
    ) ?? "") ?? scholarshipsByNaturalKey.get(naturalKey);
    const listItemId = scholarship.collegeName
      ? collegeTargetByName.get(normalizedKey(scholarship.collegeName)) ?? null
      : null;
    appendFieldChanges(preview, `scholarship:${sourceKey}`, current, {
      listItemId,
      name: scholarship.name,
      provider: scholarship.provider,
      url: scholarship.url ?? null,
      requirements: joinImportedNotes(
        scholarship.requirements,
        scholarship.providerAddress ? `Provider address: ${scholarship.providerAddress}` : null,
        scholarship.contact ? `Contact: ${scholarship.contact}` : null,
      ),
      deadline: scholarship.deadline,
      status: mapImportedScholarshipStatus(scholarship.outcome, scholarship.submittedDate),
      outcome: scholarship.outcome,
      offeredAmount: scholarship.offeredAmount == null
        ? null
        : String(scholarship.offeredAmount),
      notes: joinImportedNotes(
        scholarship.submittedDate ? `Submitted: ${scholarship.submittedDate}` : null,
        scholarship.notes,
      ),
    }, [
      "listItemId",
      "name",
      "provider",
      "url",
      "requirements",
      "deadline",
      "status",
      "outcome",
      "offeredAmount",
      "notes",
    ]);
  }

  const transcriptsByCollege = new Map(transcriptRows.map((row) => [row.listItemId, row]));
  const transcriptsById = new Map(transcriptRows.map((row) => [row.id, row]));
  for (const application of preview.applications) {
    const sent = normalizeImportedSentStatus(application.transcriptStatus);
    if (sent === null) continue;
    const listItemId = collegeTargetByName.get(normalizedKey(application.collegeName)) ?? null;
    const sourceKey = sourceIdentity(application, normalizedKey(application.collegeName));
    const current = transcriptsById.get(mappedTargetId(
      priorTargets,
      "application_transcript_status",
      sourceKey,
      "college_doc",
    ) ?? "") ?? (listItemId ? transcriptsByCollege.get(listItemId) : undefined);
    appendFieldChanges(preview, `college_doc:${sourceKey}:transcript`, current, {
      listItemId,
      sent,
    }, ["listItemId", "sent"]);
  }
}

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import {
  admissionsActivities,
  admissionsAcademicRecords,
  admissionsCases,
  admissionsCohorts,
  admissionsCollegeListItems,
  admissionsImportIssues,
  admissionsImportRuns,
  admissionsSelfReportSections,
  admissionsStudents,
} from "@/lib/db/schema";
import {
  fetchGoogleSheetRange,
  getGoogleSheetMetadata,
} from "@/lib/sales-dashboard/sheets";
import {
  ADMISSIONS_WORKBOOK_RANGES,
  buildAdmissionsWorkbookPreview,
  deriveCanonicalStudentProfile,
  extractAdmissionsSpreadsheetId,
  type AdmissionsWorkbookRangeKey,
  type AdmissionsWorkbookRanges,
  type AdmissionsWorkbookPreview,
  type AdmissionsImportFieldChange,
} from "./workbook-import";
import {
  commitAdmissionsWorkbookPreview,
  type AdmissionsImportCommitResult,
  type AdmissionsImportConflictPolicy,
} from "./workbook-import-commit";
import type { CaseAccess } from "./types";
import { appendAdmissionsWorkbookEntityChanges } from "./workbook-import-preview-diff";

/** Keep concurrent Sheets reads below the app-wide Wise/Google API burst size. */
const IMPORT_READ_CONCURRENCY = 4;
const APPLICATION_TRACKER_LEFT_WIDTH = 97; // D:CV
const APPLICATION_TRACKER_RIGHT_WIDTH = 7; // CX:DD

function createReadLimiter(maxConcurrent: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

function hasCellValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function isFormula(value: unknown): boolean {
  return typeof value === "string" && value.trimStart().startsWith("=");
}

/**
 * Google returns formulas when FORMULA is requested and literal values for
 * cells that are genuinely owned by the student. Blank formula cells before
 * parsing so reference/master data cannot affect either entities or the
 * source fingerprint. Row/column positions up to the last literal are kept so
 * stable worksheet source references remain stable.
 */
function filterFormulaOwnedCells(
  renderedRows: unknown[][],
  formulaRows: unknown[][],
  fixedWidth?: number,
  trimTrailingRows = true,
): unknown[][] {
  const rowCount = Math.max(renderedRows.length, formulaRows.length);
  const result = Array.from({ length: rowCount }, (_, rowIndex) => {
    const rendered = renderedRows[rowIndex] ?? [];
    const formulas = formulaRows[rowIndex] ?? [];
    const width = fixedWidth ?? Math.max(rendered.length, formulas.length);
    const row = Array.from({ length: width }, (_, columnIndex) => {
      const formulaOrLiteral = formulas[columnIndex];
      if (isFormula(formulaOrLiteral)) return null;
      return rendered[columnIndex] ?? formulaOrLiteral ?? null;
    });
    if (fixedWidth === undefined) {
      while (row.length && !hasCellValue(row[row.length - 1])) row.pop();
    }
    return row;
  });
  if (trimTrailingRows) {
    while (result.length && !result[result.length - 1]!.some(hasCellValue)) result.pop();
  }
  return result;
}

export async function loadAdmissionsWorkbookPreview(input: {
  actorEmail: string;
  caseId: string;
  spreadsheetUrl: string;
}): Promise<AdmissionsWorkbookPreview> {
  const spreadsheetId = extractAdmissionsSpreadsheetId(input.spreadsheetUrl);
  const metadata = await getGoogleSheetMetadata(input.actorEmail, spreadsheetId);
  const sheetTitles = metadata.sheetTitles;
  const titleSet = new Set(sheetTitles);
  const entries = Object.entries(ADMISSIONS_WORKBOOK_RANGES) as Array<[
    AdmissionsWorkbookRangeKey,
    (typeof ADMISSIONS_WORKBOOK_RANGES)[AdmissionsWorkbookRangeKey],
  ]>;
  const ranges: AdmissionsWorkbookRanges = {};
  const limitRead = createReadLimiter(IMPORT_READ_CONCURRENCY);
  const readRange = (
    sheetName: string,
    range: string,
    renderOption?: "FORMATTED_VALUE" | "FORMULA",
  ) => limitRead(() => fetchGoogleSheetRange(
    input.actorEmail,
    spreadsheetId,
    sheetName,
    range,
    renderOption,
  ));

  for (let offset = 0; offset < entries.length; offset += IMPORT_READ_CONCURRENCY) {
    const batch = entries.slice(offset, offset + IMPORT_READ_CONCURRENCY);
    const values = await Promise.all(batch.map(async ([key, spec]) => {
      if (!titleSet.has(spec.sheetName)) return [key, [] as unknown[][]] as const;
      if (key === "applications") {
        // ApplicationTracker column CW contains portal passwords. Never ask
        // Google for it: read the safe rectangles on either side, then insert
        // an empty placeholder so the parser's absolute-column mapping stays
        // aligned from D through DD.
        const [leftRendered, leftFormulas, rightRendered, rightFormulas] = await Promise.all([
          readRange(
            spec.sheetName,
            "D33:CV52",
          ),
          readRange(
            spec.sheetName,
            "D33:CV52",
            "FORMULA",
          ),
          readRange(
            spec.sheetName,
            "CX33:DD52",
          ),
          readRange(
            spec.sheetName,
            "CX33:DD52",
            "FORMULA",
          ),
        ]);
        const left = filterFormulaOwnedCells(
          leftRendered,
          leftFormulas,
          APPLICATION_TRACKER_LEFT_WIDTH,
          false,
        );
        const right = filterFormulaOwnedCells(
          rightRendered,
          rightFormulas,
          APPLICATION_TRACKER_RIGHT_WIDTH,
          false,
        );
        const rowCount = Math.max(left.length, right.length);
        const joined = Array.from({ length: rowCount }, (_, rowIndex) => [
          ...(left[rowIndex] ?? Array(APPLICATION_TRACKER_LEFT_WIDTH).fill(null)),
          null,
          ...(right[rowIndex] ?? Array(APPLICATION_TRACKER_RIGHT_WIDTH).fill(null)),
        ]);
        while (joined.length && !joined[joined.length - 1]!.some(hasCellValue)) joined.pop();
        return [key, joined] as const;
      }
      const [renderedRows, formulaRows] = await Promise.all([
        readRange(
          spec.sheetName,
          spec.range,
        ),
        readRange(
          spec.sheetName,
          spec.range,
          "FORMULA",
        ),
      ]);
      return [
        key,
        filterFormulaOwnedCells(renderedRows, formulaRows),
      ] as const;
    }));
    for (const [key, rows] of values) ranges[key] = rows;
  }

  const preview = buildAdmissionsWorkbookPreview({
    spreadsheetUrlOrId: spreadsheetId,
    sourceTitle: metadata.title,
    sheetTitles,
    ranges,
  });

  const db = getDb();
  const [sectionRows, collegeRows, studentRows, academicRows, activityRows] = await Promise.all([
    db.select({
      sectionKey: admissionsSelfReportSections.sectionKey,
      payload: admissionsSelfReportSections.payload,
    }).from(admissionsSelfReportSections)
      .where(eq(admissionsSelfReportSections.caseId, input.caseId)),
    db.select({
      instName: admissionsCollegeListItems.instName,
      round: admissionsCollegeListItems.round,
      deadline: admissionsCollegeListItems.deadline,
      appStatus: admissionsCollegeListItems.appStatus,
      firstChoiceMajor: admissionsCollegeListItems.firstChoiceMajor,
      secondChoiceMajor: admissionsCollegeListItems.secondChoiceMajor,
      admissionsUrl: admissionsCollegeListItems.admissionsUrl,
      portalUrl: admissionsCollegeListItems.portalUrl,
    })
      .from(admissionsCollegeListItems)
      .where(and(
        eq(admissionsCollegeListItems.caseId, input.caseId),
        isNull(admissionsCollegeListItems.deletedAt),
      )),
    db.select({
      fullName: admissionsStudents.fullName,
      preferredName: admissionsStudents.preferredName,
      phone: admissionsStudents.phone,
      school: admissionsStudents.school,
      schoolCounselor: admissionsStudents.schoolCounselor,
      graduationYear: admissionsCohorts.graduationYear,
    }).from(admissionsCases)
      .innerJoin(admissionsStudents, eq(admissionsStudents.id, admissionsCases.studentId))
      .innerJoin(admissionsCohorts, eq(admissionsCohorts.id, admissionsCases.cohortId))
      .where(eq(admissionsCases.id, input.caseId))
      .limit(1),
    db.select({
      system: admissionsAcademicRecords.system,
      payload: admissionsAcademicRecords.payload,
      effectiveDate: admissionsAcademicRecords.effectiveDate,
    })
      .from(admissionsAcademicRecords)
      .where(and(
        eq(admissionsAcademicRecords.caseId, input.caseId),
        isNull(admissionsAcademicRecords.deletedAt),
      ))
      .orderBy(desc(admissionsAcademicRecords.effectiveDate)),
    db.select({
      id: admissionsActivities.id,
      name: admissionsActivities.name,
    }).from(admissionsActivities).where(and(
      eq(admissionsActivities.caseId, input.caseId),
      isNull(admissionsActivities.deletedAt),
    )),
  ]);
  const importAwardYear = studentRows[0]?.graduationYear;
  if (Number.isInteger(importAwardYear)) {
    preview.financialAid = preview.financialAid.map((offer) => ({
      ...offer,
      awardYear: importAwardYear,
    }));
  }
  const existingSections = new Map(sectionRows.map((row) => [row.sectionKey, row.payload]));
  const importedSections: Array<[string, Record<string, unknown>]> = [
    ["about_you", preview.profile],
    ["legacy_academics", preview.academics],
    ["college_criteria", preview.collegeCriteria],
    ["majors_careers", preview.majorsCareers],
  ];
  for (const [sectionKey, payload] of importedSections) {
    if (!Object.keys(payload).length) continue;
    const current = existingSections.get(sectionKey) ?? {};
    const fields = new Set([...Object.keys(current), ...Object.keys(payload)]);
    for (const field of fields) {
      const oldValue = current[field] ?? null;
      const newValue = payload[field] ?? null;
      if (JSON.stringify(oldValue ?? null) !== JSON.stringify(newValue ?? null)) {
        preview.changes.push({
          target: `self_report:${sectionKey}`,
          field,
          oldValue,
          newValue,
        });
      }
    }
  }
  const currentStudent = studentRows[0];
  const canonicalProfile = deriveCanonicalStudentProfile(preview.profile);
  for (const [field, newValue] of Object.entries(canonicalProfile)) {
    const oldValue = currentStudent?.[field as keyof typeof currentStudent] ?? null;
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      preview.changes.push({
        target: "student_profile",
        field,
        oldValue,
        newValue,
      });
    }
  }
  const latestAcademicBySystem = new Map<string, Record<string, unknown>>();
  for (const row of academicRows) {
    if (!latestAcademicBySystem.has(row.system)) {
      latestAcademicBySystem.set(row.system, row.payload as Record<string, unknown>);
    }
  }
  for (const canonicalAcademic of preview.canonicalAcademicRecords) {
    const current = latestAcademicBySystem.get(canonicalAcademic.system) ?? {};
    const next = canonicalAcademic as Record<string, unknown>;
    const fields = new Set([...Object.keys(current), ...Object.keys(next)]);
    fields.delete("system");
    for (const field of fields) {
      const oldValue = current[field] ?? null;
      const newValue = next[field] ?? null;
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      preview.changes.push({
        target: `academic_record:${canonicalAcademic.system}`,
        field,
        oldValue,
        newValue,
      });
    }
  }
  const normalizeCollegeName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const existingCollegeNames = new Set(collegeRows.map((row) => normalizeCollegeName(row.instName)));
  const referencedColleges = [
    ...preview.applications.map((item) => ({
      name: item.collegeName,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.applications.sheetName,
    })),
    ...preview.research.map((item) => ({
      name: item.collegeName,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.researchNotes.sheetName,
    })),
    ...preview.interestEvents.map((item) => ({
      name: item.collegeName,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.demonstratedInterest.sheetName,
    })),
    ...preview.essayPrompts.map((item) => ({
      name: item.collegeName,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.essayPrompts.sheetName,
    })),
    ...preview.financialAid.map((item) => ({
      name: item.collegeName,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.financialAid.sheetName,
    })),
    ...preview.scholarships.flatMap((item) => item.collegeName ? [{
      name: item.collegeName,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.scholarships.sheetName,
    }] : []),
  ];
  const reportedUnresolved = new Set<string>();
  for (const reference of referencedColleges) {
    const collegeKey = normalizeCollegeName(reference.name);
    if (!collegeKey || existingCollegeNames.has(collegeKey) || reportedUnresolved.has(collegeKey)) {
      continue;
    }
    reportedUnresolved.add(collegeKey);
    preview.issues.push({
      severity: "warning",
      code: "unresolved_college",
      sheetName: reference.sheetName,
      range: reference.name,
      message: `${reference.name} is not on the case yet and will be created as a manual college entry.`,
    });
  }
  // Canonical college diffs (including normalized rounds/statuses, monetary
  // fields, and stable prior-mapping identity) are appended below alongside
  // every other imported entity. Do not also compare raw workbook labels here
  // or the preview would show duplicate, contradictory changes (for example
  // raw "EA" and canonical "ea" for the same round field).
  await appendAdmissionsWorkbookEntityChanges({
    db,
    caseId: input.caseId,
    preview,
    activityCapRows: activityRows,
  });
  return preview;
}

export async function commitAdmissionsWorkbookImport(input: {
  access: CaseAccess;
  spreadsheetUrl: string;
  expectedFingerprint: string;
  conflictPolicy?: AdmissionsImportConflictPolicy;
}): Promise<AdmissionsImportCommitResult> {
  // Confirmation always re-reads every bounded source range. The persistence
  // layer compares this fingerprint with the preview the counselor confirmed,
  // so a workbook edit between steps can never slip into the transaction.
  const preview = await loadAdmissionsWorkbookPreview({
    actorEmail: input.access.email,
    caseId: input.access.caseId,
    spreadsheetUrl: input.spreadsheetUrl,
  });
  return commitAdmissionsWorkbookPreview({
    access: input.access,
    spreadsheetUrl: input.spreadsheetUrl,
    expectedFingerprint: input.expectedFingerprint,
    conflictPolicy: input.conflictPolicy,
    preview,
  });
}

export interface AdmissionsImportRunDto {
  id: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  sourceFingerprint: string;
  status: string;
  conflictPolicy: string | null;
  summary: Record<string, unknown>;
  previewCounts: Record<string, number>;
  changes: AdmissionsImportFieldChange[];
  legacyWorksheetSections: Record<string, Record<string, unknown>>;
  issues: Array<{
    severity: string;
    code: string;
    sheetName: string | null;
    sourceRef: string | null;
    message: string;
  }>;
  createdByEmail: string;
  committedAt: string | null;
  errorSummary: string | null;
  createdAt: string;
}

export async function listAdmissionsWorkbookImports(
  caseId: string,
): Promise<AdmissionsImportRunDto[]> {
  const db = getDb();
  const rows = await db.select().from(admissionsImportRuns)
    .where(eq(admissionsImportRuns.caseId, caseId))
    .orderBy(desc(admissionsImportRuns.createdAt))
    .limit(20);
  if (!rows.length) return [];
  const issueRows = await db.select({
    runId: admissionsImportIssues.runId,
    severity: admissionsImportIssues.severity,
    code: admissionsImportIssues.code,
    sheetName: admissionsImportIssues.sheetName,
    sourceRef: admissionsImportIssues.sourceRef,
    message: admissionsImportIssues.message,
  }).from(admissionsImportIssues).where(inArray(
    admissionsImportIssues.runId,
    rows.map((row) => row.id),
  ));
  const issuesByRun = new Map<string, typeof issueRows>();
  for (const issue of issueRows) {
    const current = issuesByRun.get(issue.runId) ?? [];
    current.push(issue);
    issuesByRun.set(issue.runId, current);
  }
  return rows.map((row) => ({
    id: row.id,
    spreadsheetId: row.spreadsheetId,
    spreadsheetUrl: row.spreadsheetUrl,
    sourceFingerprint: row.sourceFingerprint,
    status: row.status,
    conflictPolicy: row.conflictPolicy,
    summary: row.summary,
    previewCounts: row.sourceMetadata.previewCounts && typeof row.sourceMetadata.previewCounts === "object"
      ? Object.fromEntries(Object.entries(row.sourceMetadata.previewCounts).flatMap(([key, value]) =>
        typeof value === "number" ? [[key, value]] : []))
      : {},
    changes: Array.isArray(row.sourceMetadata.previewChanges)
      ? row.sourceMetadata.previewChanges as AdmissionsImportFieldChange[]
      : [],
    legacyWorksheetSections:
      row.sourceMetadata.legacyWorksheetSections &&
      typeof row.sourceMetadata.legacyWorksheetSections === "object" &&
      !Array.isArray(row.sourceMetadata.legacyWorksheetSections)
        ? Object.fromEntries(Object.entries(row.sourceMetadata.legacyWorksheetSections).flatMap(([key, value]) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [[key, value as Record<string, unknown>]]
            : []))
        : {},
    issues: (issuesByRun.get(row.id) ?? []).map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      sheetName: issue.sheetName,
      sourceRef: issue.sourceRef,
      message: issue.message,
    })),
    createdByEmail: row.createdByEmail,
    committedAt: row.committedAt?.toISOString() ?? null,
    errorSummary: row.errorSummary,
    createdAt: row.createdAt.toISOString(),
  }));
}

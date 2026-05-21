import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  listTutorBusinessProfiles,
  listTutorProfileImportAliases,
  listTutorProfileImportIdentities,
  upsertTutorBusinessProfile,
} from "@/lib/tutor-business-profiles";
import {
  buildTutorProfileImportPreview,
  parseTutorProfileImportWorkbooks,
  type TutorProfileImportPreview,
} from "@/lib/tutor-profile-import";

const DEFAULT_EDUCATION_PATH = "/Users/kevinhsieh/Downloads/BeGifted Tutors-3.xlsx";
const DEFAULT_AVAILABILITY_PATH = "/Users/kevinhsieh/Downloads/Availability.xlsx";
const DEFAULT_VERIFIED_BY = "BeGifted spreadsheet import";
const DEFAULT_REPORT_DIR = "seed-reports";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function optionValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function csvValue(value: unknown): string {
  const stringValue = String(value ?? "");
  return /[",\n]/.test(stringValue) ? `"${stringValue.replace(/"/g, "\"\"")}"` : stringValue;
}

function writeCsv(filePath: string, rows: Array<Record<string, unknown>>): void {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : ["message"];
  const lines = [
    headers.map(csvValue).join(","),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function timestampSlug(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function previewReportRows(preview: TutorProfileImportPreview): Array<Record<string, unknown>> {
  return preview.rows.map((row) => ({
    canonicalKey: row.canonicalKey,
    displayName: row.displayName,
    sourceName: row.sourceName,
    matchMethod: row.matchMethod,
    matchedValue: row.matchEvidence.matchedValue,
    sources: row.sources.join("; "),
    warnings: row.warnings.join("; "),
    englishProficiency: row.patch.englishProficiency,
    youngLearnerFit: row.patch.youngLearnerFit,
    youngestComfortableAge: row.patch.youngestComfortableAge,
  }));
}

async function main(): Promise<void> {
  loadEnvFile(".env.local");
  loadEnvFile(".env");

  const commit = hasFlag("--commit");
  const educationPath = optionValue("--education") ?? DEFAULT_EDUCATION_PATH;
  const availabilityPath = optionValue("--availability") ?? DEFAULT_AVAILABILITY_PATH;
  const verifiedBy = optionValue("--verified-by") ?? DEFAULT_VERIFIED_BY;
  const lastReviewedAt = optionValue("--reviewed-at") ?? new Date().toISOString();
  const reportDir = optionValue("--report-dir") ?? DEFAULT_REPORT_DIR;
  const expectedCount = optionValue("--expect-count");

  if (!fs.existsSync(educationPath)) throw new Error(`Education workbook not found: ${educationPath}`);
  if (!fs.existsSync(availabilityPath)) throw new Error(`Availability workbook not found: ${availabilityPath}`);

  const db = getDb();
  const [activeProfiles, activeIdentities, aliases] = await Promise.all([
    listTutorBusinessProfiles(db),
    listTutorProfileImportIdentities(db),
    listTutorProfileImportAliases(db),
  ]);
  const { educationRows, availabilityRows } = parseTutorProfileImportWorkbooks({
    educationWorkbook: fs.readFileSync(educationPath),
    availabilityWorkbook: fs.readFileSync(availabilityPath),
  });
  const preview = buildTutorProfileImportPreview({
    educationRows,
    availabilityRows,
    activeProfiles,
    activeIdentities,
    aliases,
    verifiedBy,
    lastReviewedAt,
  });

  if (expectedCount && preview.rows.length !== Number(expectedCount)) {
    throw new Error(`Expected ${expectedCount} matched rows, got ${preview.rows.length}. Refusing to seed.`);
  }

  const matchedKeys = new Set(preview.rows.map((row) => row.canonicalKey));
  const activeWithoutSeed = activeProfiles
    .filter((profile) => !matchedKeys.has(profile.canonicalKey))
    .map((profile) => ({
      canonicalKey: profile.canonicalKey,
      displayName: profile.displayName,
      subjects: profile.subjects.join("; "),
    }));

  const slug = timestampSlug(lastReviewedAt);
  fs.mkdirSync(reportDir, { recursive: true });
  const jsonReportPath = path.join(reportDir, `tutor-profile-seed-${slug}.json`);
  const matchedCsvPath = path.join(reportDir, `tutor-profile-seed-matched-${slug}.csv`);
  const reviewCsvPath = path.join(reportDir, `tutor-profile-seed-review-${slug}.csv`);
  fs.writeFileSync(jsonReportPath, JSON.stringify({
    commit,
    educationPath,
    availabilityPath,
    verifiedBy,
    lastReviewedAt,
    summary: preview.summary,
    matchedRows: preview.rows,
    unmatchedRows: preview.unmatchedRows,
    ambiguousRows: preview.ambiguousRows,
    duplicateSourceRows: preview.duplicateSourceRows,
    availabilityOnlyRows: preview.availabilityOnlyRows,
    invalidRows: preview.invalidRows,
    activeWithoutSeed,
  }, null, 2));
  writeCsv(matchedCsvPath, previewReportRows(preview));
  writeCsv(reviewCsvPath, [
    ...preview.ambiguousRows.map((row) => ({
      type: "ambiguous",
      sourceName: row.sourceName,
      reason: row.reason,
      tried: row.tried.join("; "),
      candidates: row.candidates?.map((candidate) => candidate.canonicalKey).join("; ") ?? "",
    })),
    ...preview.unmatchedRows.map((row) => ({
      type: "unmatched",
      sourceName: row.sourceName,
      reason: row.reason,
      tried: row.tried.join("; "),
      candidates: "",
    })),
    ...activeWithoutSeed.map((row) => ({
      type: "active_without_seed",
      sourceName: row.displayName,
      reason: `Active Wise tutor has no deterministic source row. canonicalKey=${row.canonicalKey}`,
      tried: "",
      candidates: "",
    })),
  ]);

  let savedCount = 0;
  if (commit) {
    for (const row of preview.rows) {
      const activeProfile = activeProfiles.find((profile) => profile.canonicalKey === row.canonicalKey);
      if (!activeProfile) continue;
      await upsertTutorBusinessProfile(db, row.canonicalKey, activeProfile.displayName, row.patch);
      savedCount += 1;
    }
  }

  const [profileCount] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(schema.tutorBusinessProfiles);

  console.log(JSON.stringify({
    mode: commit ? "commit" : "dry-run",
    summary: preview.summary,
    savedCount,
    profileTableCount: profileCount?.count ?? "0",
    reports: {
      json: jsonReportPath,
      matchedCsv: matchedCsvPath,
      reviewCsv: reviewCsvPath,
    },
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

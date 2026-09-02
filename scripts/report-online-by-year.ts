// ----------------------------------------------------------------------------
// One-off: how many students in a given school-year band take their classes
// online? Read-only — SELECTs against the active credit-control snapshot plus
// GET-only Wise registration reads for the current grade. Never writes.
//
// Modality comes from the Wise session-title prefix via `deriveSessionModality`
// (verified >99.5% against Wise `session_type` — see student-schedule/data.ts).
// Grade comes live from the Wise registration answer for question `if89sblj`,
// parsed by the promotions module's own `parseWiseGrade` ("Grade N" -> Year N+1).
//
// Usage:
//   npx tsx scripts/report-online-by-year.ts [--since-days=60] [--out=/dir]
// ----------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import { and, eq, gte } from "drizzle-orm";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { createWiseClient, type WiseClient } from "@/lib/wise/client";
import { fetchWiseStudentRegistrationData } from "@/lib/wise/fetchers";
import { deriveSessionModality } from "@/lib/student-schedule/data";
import { parseWiseGrade, WISE_GRADE_REGISTRATION_FIELD_ID } from "@/lib/student-promotions/rules";

loadEnvConfig(process.cwd());

const CANCELLED = new Set(["CANCELLED", "CANCELED"]);
const CONCURRENCY = 4;
const MIN_INTERVAL_MS = 130;

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

interface StudentRow {
  wiseStudentId: string;
  studentName: string;
  online: number;
  onsite: number;
  unknown: number;
  gradeRaw: string;
  year: number | null;
  error: string | null;
}

/** Simple bounded-concurrency map with a shared minimum request interval. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  let nextAllowed = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const now = Date.now();
      const wait = Math.max(0, nextAllowed - now);
      nextAllowed = Math.max(now, nextAllowed) + MIN_INTERVAL_MS;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function gradeFor(client: WiseClient, instituteId: string, studentId: string): Promise<{ raw: string; error: string | null }> {
  try {
    const registration = await fetchWiseStudentRegistrationData(client, instituteId, studentId);
    const fields = registration.registrationData?.fields ?? [];
    const field = fields.find((item) => item.questionId === WISE_GRADE_REGISTRATION_FIELD_ID);
    return { raw: String(field?.answer ?? "").trim(), error: null };
  } catch (error) {
    return { raw: "", error: error instanceof Error ? error.message : "registration fetch failed" };
  }
}

async function main(): Promise<void> {
  const sinceDays = Number(arg("since-days", "60"));
  const outDir = arg("out", path.join(process.cwd(), "reports"));
  const db = getDb();

  const [snapshot] = await db
    .select({ id: schema.creditControlSnapshots.id, generatedAt: schema.creditControlSnapshots.generatedAt })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .limit(1);
  if (!snapshot) throw new Error("No active credit-control snapshot");

  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const sessions = await db
    .select({
      wiseStudentId: schema.creditControlSessions.wiseStudentId,
      studentName: schema.creditControlSessions.studentName,
      title: schema.creditControlSessions.title,
      meetingStatus: schema.creditControlSessions.meetingStatus,
    })
    .from(schema.creditControlSessions)
    .where(and(
      eq(schema.creditControlSessions.snapshotId, snapshot.id),
      gte(schema.creditControlSessions.scheduledStartTime, since),
    ));

  const byStudent = new Map<string, StudentRow>();
  for (const row of sessions) {
    if (CANCELLED.has(row.meetingStatus.trim().toUpperCase())) continue;
    const entry = byStudent.get(row.wiseStudentId) ?? {
      wiseStudentId: row.wiseStudentId,
      studentName: row.studentName,
      online: 0,
      onsite: 0,
      unknown: 0,
      gradeRaw: "",
      year: null,
      error: null,
    };
    const modality = deriveSessionModality(row.title);
    if (modality === "online") entry.online += 1;
    else if (modality === "onsite") entry.onsite += 1;
    else entry.unknown += 1;
    byStudent.set(row.wiseStudentId, entry);
  }

  const students = [...byStudent.values()];
  console.log(`Active snapshot ${snapshot.id} (generated ${snapshot.generatedAt.toISOString()})`);
  console.log(`${students.length} students with a non-cancelled session since ${since.toISOString().slice(0, 10)}`);
  console.log("Fetching live Wise grades...");

  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID!;
  const grades = await mapLimit(students, CONCURRENCY, (student) => gradeFor(client, instituteId, student.wiseStudentId));
  students.forEach((student, index) => {
    const grade = grades[index]!;
    student.gradeRaw = grade.raw;
    student.error = grade.error;
    student.year = parseWiseGrade(grade.raw).currentYear;
  });

  const bucket = (student: StudentRow) =>
    student.online > 0 && student.onsite === 0 ? "only_online"
      : student.online > 0 ? "mixed"
      : student.onsite > 0 ? "only_onsite"
      : "no_signal";

  const years = [...new Set(students.map((s) => s.year))].sort((a, b) => (a ?? 99) - (b ?? 99));
  console.log("\nyear  students  only_online  mixed  only_onsite  no_signal");
  for (const year of years) {
    const group = students.filter((s) => s.year === year);
    const count = (name: string) => group.filter((s) => bucket(s) === name).length;
    console.log(
      `${String(year ?? "n/a").padStart(4)}  ${String(group.length).padStart(8)}  ${String(count("only_online")).padStart(11)}  ${String(count("mixed")).padStart(5)}  ${String(count("only_onsite")).padStart(11)}  ${String(count("no_signal")).padStart(9)}`,
    );
  }

  const band = students.filter((s) => s.year !== null && s.year >= 10 && s.year <= 13);
  const anyOnline = band.filter((s) => s.online > 0);
  const onlyOnline = band.filter((s) => bucket(s) === "only_online");
  console.log(`\nYear 10-13: ${band.length} students | any online ${anyOnline.length} | fully online ${onlyOnline.length}`);
  const unresolved = students.filter((s) => s.year === null);
  console.log(`Grade unresolved for ${unresolved.length} of ${students.length} students (${unresolved.filter((s) => s.error).length} fetch errors)`);

  mkdirSync(outDir, { recursive: true });
  const csv = [
    "wise_student_id,student_name,grade_raw,parsed_year,online_sessions,onsite_sessions,unknown_sessions,bucket,error",
    ...students.map((s) => [
      s.wiseStudentId,
      JSON.stringify(s.studentName),
      JSON.stringify(s.gradeRaw),
      s.year ?? "",
      s.online,
      s.onsite,
      s.unknown,
      bucket(s),
      JSON.stringify(s.error ?? ""),
    ].join(",")),
  ].join("\n");
  const outPath = path.join(outDir, "online-by-year.csv");
  writeFileSync(outPath, csv, "utf8");
  console.log(`\nWrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { loadEnvConfig } from "@next/env";
import { getDb } from "@/lib/db";
import { loadBootstrapModeObservations, recordModeObservations } from "@/lib/classrooms/mode-history-data";

loadEnvConfig(process.cwd());
async function main() {
  const db = getDb();
  const observations = await loadBootstrapModeObservations(db);
  const apply = process.argv.includes("--apply");
  const inserted = apply ? await recordModeObservations(db, observations, "existing-records-bootstrap-v1") : 0;
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", observations: observations.length,
    students: new Set(observations.map(row => row.studentId)).size,
    attendedLessons: new Set(observations.filter(row => row.attended).map(row => `${row.studentId}:${row.wiseSessionId}`)).size,
    inserted, note: "Attendance-only records do not establish an onsite-to-online transition." }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

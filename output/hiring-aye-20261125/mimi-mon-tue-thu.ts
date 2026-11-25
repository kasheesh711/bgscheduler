// Kevin, 25 Nov 2026: Mimi does mock teaching only Monday, Tuesday and Thursday. She is enrolled in Tutor Attendance,
// so saveHeadDays writes a new attendance schedule version from tomorrow (Kevin approved the attendance change).
import { loadEnvConfig } from "@next/env";
import { sql } from "drizzle-orm";
const ROOT = "/Users/kevinhsieh/.bgscheduler-hiring/contract-release/Scheduling/src";
const APPLY = process.argv.includes("--apply");
async function main() {
  loadEnvConfig("/Users/kevinhsieh/Developer/Scheduling");
  const { getDb } = await import(`${ROOT}/lib/db`);
  const { saveHeadDays } = await import(`${ROOT}/lib/hiring/service`);
  const db = getDb();
  const r = await db.execute(sql`select revision from hiring_settings where id='default'`);
  const revision = (r.rows[0] as { revision: number }).revision;
  const show = async (label: string) => {
    const s = await db.execute(sql`select effective_from::text, week from tutor_attendance_schedules where canonical_key='Mimi' order by effective_from`);
    console.log(label, JSON.stringify(s.rows));
  };
  await show("before");
  if (!APPLY) return console.log("dry run, revision", revision);
  const out = await saveHeadDays("Mimi", [true, true, false, true, false], revision, "kevhsh7@gmail.com", db);
  console.log("result", JSON.stringify(out));
  await show("after");
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

/** Scoped persisted-evidence report/recovery. Never decides or publishes money. */
import { readFileSync } from "node:fs";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { feedbackAutoSubmittedSql, staffFeedbackEventSql } from "@/lib/post-class-feedback/feedback-proof";
import { reassessPostClassSessions } from "@/lib/post-class-feedback/reassess";
import { advancePostClassTimingPolicy } from "@/lib/post-class-feedback/settings";
import { loadPayoutScriptEnvironment, optionValue, writeJsonArtifactExclusive } from "./lib/payout-script";

const RECOVERY_FROM = new Date("2026-08-25T17:00:00.000Z");
const PAKGAD_SESSION = "6ab78a1b50dfcefc030d22ff";
const statuses = ["on_time", "late", "not_due", "unknown"] as const;

async function main() {
  loadPayoutScriptEnvironment();
  const db = getDb();
  const apply = process.argv.includes("--apply");
  const output = optionValue("--output");
  if (!output) throw Error("Provide --output with a new private report path.");
  const inputPath = optionValue("--input");
  if (apply && (!inputPath || process.env.POST_CLASS_PAYOUT_AUTOMATION_PAUSED !== "true"
    || process.env.POST_CLASS_AUTO_APPROVE_ENABLED === "true" || process.env.POST_CLASS_PAYOUT_WRITES_ENABLED === "true")) {
    throw Error("Apply requires a saved report and verified paused finance configuration.");
  }
  const [settings] = await db.select().from(schema.postClassSettings).where(eq(schema.postClassSettings.id, "default"));
  if (!settings) throw Error("Post-class settings missing.");
  const eventAuto = feedbackAutoSubmittedSql(schema.wiseActivityEvents.payload);
  const staff = staffFeedbackEventSql(eventAuto, schema.wiseActivityEvents.actorRole);
  const contaminated = sql`exists (
    select 1 from ${schema.wiseActivityEvents}
    where ${schema.wiseActivityEvents.sessionId} = ${schema.postClassSessions.wiseSessionId}
      and ${schema.wiseActivityEvents.eventName} = 'SessionFeedbackSubmittedEvent'
      and (${eventAuto}) is distinct from true and not (${staff})
      and ${schema.wiseActivityEvents.eventTimestamp} <= ${schema.postClassSessions.deadlineAt}
  ) and not exists (
    select 1 from ${schema.wiseActivityEvents}
    where ${schema.wiseActivityEvents.sessionId} = ${schema.postClassSessions.wiseSessionId}
      and ${schema.wiseActivityEvents.eventName} = 'SessionFeedbackSubmittedEvent'
      and ${staff} and ${schema.wiseActivityEvents.eventTimestamp} <= ${schema.postClassSessions.deadlineAt}
  ) and (${schema.postClassSessions.timingStatus} = 'on_time'
      or ${schema.postClassSessions.firstOnTimeCompliantVersionId} is not null)`;
  const saved = inputPath ? JSON.parse(readFileSync(inputPath, "utf8")) as {
    recoveryFrom: string; settings: { policyVersion: number }; sessions: Array<{ wiseSessionId: string }>
  } : null;
  if (saved && saved.recoveryFrom !== RECOVERY_FROM.toISOString()) throw Error("Report scope mismatch.");
  const where = and(gte(schema.postClassSessions.scheduledEndAt, RECOVERY_FROM),
    eq(schema.postClassSessions.eligible, true), eq(schema.postClassSessions.sourceStatus, "ready"),
    isNull(schema.postClassSessions.wiseDeletedAt),
    saved ? inArray(schema.postClassSessions.wiseSessionId, saved.sessions.map(s => s.wiseSessionId))
      : sql`((${contaminated}) or ${schema.postClassSessions.wiseSessionId} = ${PAKGAD_SESSION})`);
  const sessions = await db.select().from(schema.postClassSessions).where(where);
  if (!sessions.length) throw Error("No scoped recovery sessions.");
  if (saved && sessions.length !== saved.sessions.length) throw Error("Recovery scope changed; regenerate the report.");
  const ids = sessions.map(s => s.id);
  const deductions = await db.select().from(schema.postClassDeductions).where(inArray(schema.postClassDeductions.sessionId, ids));
  const lines = await db.execute(sql`select * from ${schema.postClassPayoutRunLines} where ${inArray(schema.postClassPayoutRunLines.sessionId, ids)}`);
  const versions = await db.select().from(schema.postClassFeedbackVersions).where(inArray(schema.postClassFeedbackVersions.sessionId, ids));
  const events = await db.select().from(schema.wiseActivityEvents).where(and(
    inArray(schema.wiseActivityEvents.sessionId, sessions.map(s => s.wiseSessionId)),
    eq(schema.wiseActivityEvents.eventName, "SessionFeedbackSubmittedEvent"),
  ));
  // Flush financial and evidence snapshots before changing policy or projections.
  if (apply) writeJsonArtifactExclusive(`${output}.before.json`, { capturedAt: new Date(), settings, sessions, deductions, lines, versions, events });
  if (apply) await advancePostClassTimingPolicy({ email: "kevhsh7@gmail.com" }, saved!.settings.policyVersion, db);
  const result = await reassessPostClassSessions({
    db, apply, financeActions: false, timingStatuses: [...statuses], wiseSessionIds: sessions.map(s => s.wiseSessionId),
  });
  writeJsonArtifactExclusive(output, { capturedAt: new Date(), recoveryFrom: RECOVERY_FROM, applied: apply,
    settings, sessions, deductions, lines, versions, events, result });
  console.log(JSON.stringify({ output, applied: apply, scanned: result.scanned, changed: result.changed,
    failed: result.failed, due: sessions.filter(s => s.deadlineAt <= new Date()).length,
    outcomes: result.outcomes.map(o => ({ tutor: o.canonicalTutorName, session: o.wiseSessionId, before: o.from,
      after: o.to, staffSubmittedAt: o.provenAt, reviewRequired: o.reviewRequired, locked: o.onTimeComplianceLocked })) }, null, 2));
  if (result.failed) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });

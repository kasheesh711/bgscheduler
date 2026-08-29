/**
 * INC-260829 remediation: unwind the deductions the auto-approval sweep
 * converted to money without a human decision.
 *
 * Between 2026-08-18 (payout-accrual cron armed) and the code fix, every
 * `pending_review` deduction past its 24h grace was approved by
 * `system:post-class-auto-approve` and became eligible for a sheet write.
 * This script classifies every deduction still carrying that system decision:
 *
 *   - reopen  — approved but never written to the ledger: back to
 *               `pending_review` for a genuine human review in the UI.
 *   - waive   — written to the ledger with a stored submission time at or
 *               before the deadline (or none at all): waived, which appends a
 *               positive ฿100 correction through the existing
 *               `post_class_payout_adjustments` path.
 *   - keep    — written and genuinely late by its own stored evidence
 *               (submitted after the deadline). Ratified as kept; reported
 *               only, never touched.
 *
 * Every state change goes through `applyPostClassReviewAction` — finance
 * lock, version check, idempotency, audit rows — never raw SQL. Idempotency
 * keys are stable (`inc-260829:<action>:<deductionId>`), so re-running after
 * a partial failure is safe.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/remediate-auto-approved-deductions.ts
 *   ... --commit --actor=you@example.com   apply (default is a dry run)
 *
 * `--tsconfig` is required: this reaches server-only modules that plain tsx
 * cannot resolve. See `scripts/stubs/server-only.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { applyPostClassReviewAction } from "@/lib/post-class-feedback/actions";

import {
  loadPayoutScriptEnvironment,
  writeJsonArtifactExclusive,
} from "./lib/payout-script";

const SYSTEM_ACTOR_EMAIL = "system:post-class-auto-approve";

/** `fddba89` (any non-auto event proves on-time) reached production. */
const POLICY_WIDENING_DEPLOYED_AT = new Date("2026-08-07T10:23:00.000Z");

type PlannedAction = "reopen" | "waive" | "keep";

interface PlannedItem {
  action: PlannedAction;
  deductionId: string;
  sessionId: string;
  wiseSessionId: string;
  tutorName: string | null;
  className: string | null;
  scheduledStartAt: Date;
  deadlineAt: Date;
  tutorSubmittedAt: Date | null;
  lineReason: string | null;
  decisionAt: Date | null;
  staleAssessment: boolean;
}

function bangkok(value: Date | null): string {
  if (!value) return "";
  return value.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
}

function csvCell(value: string | null): string {
  const text = value ?? "";
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function planRemediation(db: Database): Promise<PlannedItem[]> {
  const deductions = await db.select({
    deductionId: schema.postClassDeductions.id,
    sessionId: schema.postClassDeductions.sessionId,
    decisionAt: schema.postClassDeductions.decisionAt,
    wiseSessionId: schema.postClassSessions.wiseSessionId,
    tutorName: schema.postClassSessions.canonicalTutorName,
    className: schema.postClassSessions.className,
    scheduledStartAt: schema.postClassSessions.scheduledStartAt,
    sessionDeadlineAt: schema.postClassSessions.deadlineAt,
  }).from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .where(and(
      eq(schema.postClassDeductions.status, "approved"),
      eq(schema.postClassDeductions.decisionByEmail, SYSTEM_ACTOR_EMAIL),
    ))
    .orderBy(schema.postClassSessions.canonicalTutorName, schema.postClassSessions.scheduledStartAt);
  if (deductions.length === 0) return [];

  const deductionIds = deductions.map((row) => row.deductionId);
  const writtenLines = await db.select({
    deductionId: schema.postClassPayoutRunLines.deductionId,
    deadlineAt: schema.postClassPayoutRunLines.deadlineAt,
    tutorSubmittedAt: schema.postClassPayoutRunLines.tutorSubmittedAt,
    reason: schema.postClassPayoutRunLines.reason,
  }).from(schema.postClassPayoutRunLines)
    .where(and(
      inArray(schema.postClassPayoutRunLines.deductionId, deductionIds),
      eq(schema.postClassPayoutRunLines.writeStatus, "written"),
      isNull(schema.postClassPayoutRunLines.retiredAt),
    ));
  const writtenByDeduction = new Map(writtenLines.map((line) => [line.deductionId, line]));

  const sessionIds = [...new Set(deductions.map((row) => row.sessionId))];
  const latestAssessments = await db.selectDistinctOn(
    [schema.postClassAssessments.sessionId],
    {
      sessionId: schema.postClassAssessments.sessionId,
      assessedAt: schema.postClassAssessments.assessedAt,
    },
  ).from(schema.postClassAssessments)
    .where(inArray(schema.postClassAssessments.sessionId, sessionIds))
    .orderBy(
      schema.postClassAssessments.sessionId,
      desc(schema.postClassAssessments.assessedAt),
    );
  const latestAssessedAt = new Map(
    latestAssessments.map((row) => [row.sessionId, row.assessedAt]),
  );

  return deductions.map((row) => {
    const written = writtenByDeduction.get(row.deductionId);
    const deadlineAt = written?.deadlineAt ?? row.sessionDeadlineAt;
    const tutorSubmittedAt = written?.tutorSubmittedAt ?? null;
    const assessedAt = latestAssessedAt.get(row.sessionId);
    const action: PlannedAction = !written
      ? "reopen"
      : tutorSubmittedAt !== null && tutorSubmittedAt.getTime() > deadlineAt.getTime()
        ? "keep"
        : "waive";
    return {
      action,
      deductionId: row.deductionId,
      sessionId: row.sessionId,
      wiseSessionId: row.wiseSessionId,
      tutorName: row.tutorName,
      className: row.className,
      scheduledStartAt: row.scheduledStartAt,
      deadlineAt,
      tutorSubmittedAt,
      lineReason: written?.reason ?? null,
      decisionAt: row.decisionAt,
      staleAssessment: !assessedAt
        || assessedAt.getTime() < POLICY_WIDENING_DEPLOYED_AT.getTime(),
    };
  });
}

function writeCsvArtifact(filePath: string, items: PlannedItem[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const header = [
    "action", "tutor", "class", "wise_session_id", "class_start_bangkok",
    "deadline_bangkok", "submitted_bangkok", "line_reason",
    "auto_approved_at_bangkok", "stale_pre_widening_assessment", "deduction_id",
  ].join(",");
  const rows = items.map((item) => [
    item.action,
    csvCell(item.tutorName),
    csvCell(item.className),
    item.wiseSessionId,
    bangkok(item.scheduledStartAt),
    bangkok(item.deadlineAt),
    bangkok(item.tutorSubmittedAt),
    csvCell(item.lineReason),
    bangkok(item.decisionAt),
    item.staleAssessment ? "yes" : "no",
    item.deductionId,
  ].join(","));
  writeFileSync(filePath, `${header}\n${rows.join("\n")}\n`, { flag: "wx" });
}

async function applyPlan(
  db: Database,
  items: PlannedItem[],
  actorEmail: string,
): Promise<{ reopened: number; waived: number; failed: number }> {
  const actor = { email: actorEmail, name: "INC-260829 remediation" };
  let reopened = 0;
  let waived = 0;
  let failed = 0;
  for (const item of items) {
    if (item.action === "keep") continue;
    try {
      const [current] = await db.select({
        version: schema.postClassDeductions.version,
        status: schema.postClassDeductions.status,
      }).from(schema.postClassDeductions)
        .where(eq(schema.postClassDeductions.id, item.deductionId))
        .limit(1);
      if (!current || current.status !== "approved") {
        console.log(`  skip   ${item.wiseSessionId}  no longer approved`);
        continue;
      }
      if (item.action === "reopen") {
        await applyPostClassReviewAction(actor, {
          deductionId: item.deductionId,
          action: "reopen",
          note: "INC-260829: auto-approved without human review; reopened for a real review.",
          expectedVersion: current.version,
          idempotencyKey: `inc-260829:reopen:${item.deductionId}`,
        }, db);
        reopened += 1;
      } else {
        await applyPostClassReviewAction(actor, {
          deductionId: item.deductionId,
          action: "waive",
          note: "INC-260829: deduction reached the payout ledger via auto-approval, "
            + "with no human decision and evidence submitted on time; "
            + "waived to append the ฿100 correction.",
          waiverCategory: "duplicate_system_error",
          expectedVersion: current.version,
          idempotencyKey: `inc-260829:waive:${item.deductionId}`,
        }, db);
        waived += 1;
      }
    } catch (error) {
      console.error(`  FAIL   ${item.wiseSessionId}`, error instanceof Error ? error.message : error);
      failed += 1;
    }
  }
  return { reopened, waived, failed };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npx tsx --tsconfig scripts/tsconfig.json "
      + "scripts/remediate-auto-approved-deductions.ts [--commit --actor=you@example.com]",
    );
    return;
  }
  loadPayoutScriptEnvironment();

  const commit = process.argv.includes("--commit");
  const actorArg = process.argv.find((arg) => arg.startsWith("--actor="));
  const actorEmail = actorArg?.slice("--actor=".length).trim() ?? "";
  if (commit && !actorEmail.includes("@")) {
    throw new Error("--commit requires --actor=<your email>; actions are attributed to it.");
  }

  const db = getDb();
  console.log(commit ? "Mode: COMMIT\n" : "Mode: dry run (pass --commit --actor=... to apply)\n");

  const plan = await planRemediation(db);
  for (const item of plan) {
    console.log(
      `  ${item.action.padEnd(6)} ${item.tutorName ?? "(unnamed)"}  ${item.className ?? ""}`
      + `  ${item.wiseSessionId}  submitted=${bangkok(item.tutorSubmittedAt) || "-"}`
      + `  deadline=${bangkok(item.deadlineAt)}${item.staleAssessment ? "  [stale-assessment]" : ""}`,
    );
  }
  const tally = {
    reopen: plan.filter((item) => item.action === "reopen").length,
    waive: plan.filter((item) => item.action === "waive").length,
    keep: plan.filter((item) => item.action === "keep").length,
  };
  console.log(
    `\nPlanned: ${tally.reopen} reopen, ${tally.waive} waive (each appends a +฿100 correction),`
    + ` ${tally.keep} keep (genuinely late; ratified, untouched).`,
  );
  if (plan.length === 0) return;

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const csvPath = path.resolve(".payout-ops", `inc-260829-remediation-${stamp}.csv`);
  writeCsvArtifact(csvPath, plan);
  console.log(`CSV artifact: ${csvPath}`);

  if (!commit) return;

  writeJsonArtifactExclusive(
    path.resolve(".payout-ops", `inc-260829-remediation-${stamp}.json`),
    {
      kind: "inc-260829-remediate-auto-approved-deductions",
      plannedAt: new Date().toISOString(),
      actorEmail,
      items: plan.map((item) => ({
        ...item,
        scheduledStartAt: item.scheduledStartAt.toISOString(),
        deadlineAt: item.deadlineAt.toISOString(),
        tutorSubmittedAt: item.tutorSubmittedAt?.toISOString() ?? null,
        decisionAt: item.decisionAt?.toISOString() ?? null,
      })),
    },
  );

  const result = await applyPlan(db, plan, actorEmail);
  console.log(
    `\nApplied: ${result.reopened} reopened, ${result.waived} waived, ${result.failed} failed.`,
  );
  if (result.failed > 0) {
    console.log("Re-run with the same flags: idempotency keys make retries safe.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

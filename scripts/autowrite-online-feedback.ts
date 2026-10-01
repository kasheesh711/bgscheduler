/**
 * Feedback autowriter CLI. Production runs from the Wise webhook and the
 * backstop cron; this CLI controls them and runs the same code by hand.
 *
 * Control (DB control row; takes effect immediately, no redeploy):
 *   … --status
 *   … --mode=off|shadow|live --actor=<email>     (live re-queues shadow drafts still before their deadline)
 *   … --pause --reason="…" --actor=<email>        (global halt: no POSTs until --resume)
 *   … --resume --actor=<email>
 *   … --tutor-off=<wiseUserId> --actor=<email>  /  --tutor-on=<wiseUserId> --actor=<email>
 *   … --retry=<wiseSessionId> --actor=<email>     (held/expired/skipped_scope class → pending; the next sweep writes it again)
 * Runs (same guarded path as production; honours mode, halt and per-tutor switches):
 *   … --sweep
 *   … --process=<wiseSessionId>
 * Evaluation (never writes to Wise or to the autowriter tables):
 *   … --generate [--teacher-id=<id>] [--eval-limit=20]
 *   … --export-grading --run=<runDir> --out=<file> [--teacher-id=<id>]
 *   … --report --run=<runDir>
 *   … --replay [--sessions=<id>,<id>] [--per-tutor=4] [--days=7] [--concurrency=3] [--keep-transcripts]
 *       What transcript first would do with recent classes: Wise session-detail GETs, database SELECTs, Soniox jobs
 *       deleted after each transcript, model calls kept in memory. Writes .feedback-autowriter/replay/<ts>/
 *       (records.json, summary.json, summary.md; 0600). --per-tutor defaults to 4, or 0 when --sessions is given.
 *
 * Run with: npx tsx --tsconfig scripts/tsconfig.json scripts/autowrite-online-feedback.ts …
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";
import { assignModelArms } from "@/lib/feedback-autowriter/ab";
import {
  autowriterAlertEmails,
  autowriterTranscriptFirst,
  autowriterTranscriptsEnabled,
  openRouterApiKey,
  sonioxApiKey,
  wiseApiActorId,
} from "@/lib/feedback-autowriter/config";
import { createSonioxClient, type SonioxClient } from "@/lib/feedback-autowriter/soniox";
import { loadTutorPriorFeedback, processSession, runSweep, type AutowriterDeps } from "@/lib/feedback-autowriter/job";
import {
  loadReplaySample,
  renderReplayMarkdown,
  runReplay,
  summarizeReplay,
  type ReplayWiseReads,
} from "@/lib/feedback-autowriter/replay";
import { AUTOWRITER_ROSTER, AUTOWRITER_TEACHER_ALLOWLIST, KEVIN_ONLINE_WISE_USER_ID, rosterTutor } from "@/lib/feedback-autowriter/roster";
import {
  AUTOWRITER_ROOT,
  buildGradingExport,
  createWiseFeedbackOps,
  generateDraft,
  loadCandidateShortlist,
  loadEvalSessions,
  loadFieldMappings,
  loadPriorFeedback,
  mapWithConcurrency,
  prepareSession,
  readArtifact,
  summarizeCosts,
  writeArtifact,
  type DraftRecord,
  type PreparedOrSkipped,
  type PreparedSession,
} from "@/lib/feedback-autowriter/run";
import { haltAutowriter, readControl, requeueShadowDrafts, retryHeldSession, updateControl } from "@/lib/feedback-autowriter/store";
import { AUTOWRITER_DEADLINE_MARGIN_MS } from "@/lib/feedback-autowriter/types";
import { loadPayoutScriptEnvironment } from "./lib/payout-script";

loadPayoutScriptEnvironment();
stampLocalCommit();

/** Drafts and POSTs made from this checkout are stamped with its commit (plus "+dirty"), as a deploy's are with its own. */
function stampLocalCommit(): void {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
    process.env.AUTOWRITER_LOCAL_COMMIT = `local:${sha}${dirty ? "+dirty" : ""}`;
  } catch {
    process.env.AUTOWRITER_LOCAL_COMMIT = "local:unknown";
  }
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function requireActor(): string {
  const actor = option("actor");
  if (!actor || !actor.includes("@")) throw new Error("Pass --actor=<email> for control changes");
  return actor;
}

function seededRandom(seed: string): () => number {
  let state = [...seed].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 2654435761) >>> 0, 2166136261);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cliDeps(budgetMs: number): AutowriterDeps {
  return {
    db: getDb(),
    ops: createWiseFeedbackOps(),
    apiKey: openRouterApiKey(),
    apiActorId: wiseApiActorId(),
    writesAllowedHere: true,
    deadlineMs: Date.now() + budgetMs,
    alertRecipients: autowriterAlertEmails(),
    transcriptsEnabled: autowriterTranscriptsEnabled() && Boolean(sonioxApiKey()),
    soniox: sonioxApiKey() ? createSonioxClient(sonioxApiKey()!) : null,
    // Same switch as production (`FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST`); acts only with the second pass.
    transcriptFirst: autowriterTranscriptFirst(),
  };
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

async function status(): Promise<void> {
  const control = await readControl(getDb());
  console.log(JSON.stringify({
    mode: control.mode,
    haltedAt: control.haltedAt,
    haltReason: control.haltReason,
    disabledTutors: control.disabledTutors.map((id) => rosterTutor(id)?.displayName ?? id),
    roster: AUTOWRITER_ROSTER.map((tutor) => `${tutor.displayName} (${tutor.wiseUserId})`),
    updatedBy: control.updatedBy,
    updatedAt: control.updatedAt,
  }, null, 2));
}

async function control(): Promise<void> {
  const db = getDb();
  const actor = requireActor();
  const mode = option("mode");
  if (mode) {
    if (mode !== "off" && mode !== "shadow" && mode !== "live") throw new Error("--mode must be off, shadow or live");
    await updateControl(db, { mode }, actor);
    if (mode === "live") {
      const requeued = await requeueShadowDrafts(db, new Date(Date.now() + AUTOWRITER_DEADLINE_MARGIN_MS));
      console.log(`Re-queued ${requeued} shadow draft(s) still before their deadline.`);
    }
  }
  if (flag("pause")) await haltAutowriter(db, `paused by ${actor}: ${option("reason") ?? "no reason given"}`, actor);
  if (flag("resume")) await updateControl(db, { haltedAt: null, haltReason: null }, actor);
  const retry = option("retry");
  if (retry) {
    const ok = await retryHeldSession(db, retry, { minDeadline: new Date(Date.now() + AUTOWRITER_DEADLINE_MARGIN_MS), actor });
    console.log(ok
      ? `Re-queued ${retry}; the next sweep (or webhook) writes it again.`
      : `Not re-queued: ${retry} is not held/expired/skipped_scope, or its deadline is too close.`);
  }
  const off = option("tutor-off");
  const on = option("tutor-on");
  if (off || on) {
    const target = (off ?? on)!;
    if (!AUTOWRITER_TEACHER_ALLOWLIST.has(target)) throw new Error("Not a roster tutor id");
    const disabled = new Set((await readControl(db)).disabledTutors);
    if (off) disabled.add(target); else disabled.delete(target);
    await updateControl(db, { disabledTutors: [...disabled] }, actor);
  }
  await status();
}

// ---------------------------------------------------------------------------
// Evaluation (read-only toward Wise and the autowriter tables)
// ---------------------------------------------------------------------------

interface RunFiles {
  sessions: PreparedSession[];
  skipped: Array<Extract<PreparedOrSkipped, { ok: false }>>;
  arms: Record<string, "glm" | "luna">;
  drafts: DraftRecord[];
}

function loadRun(runDir: string): RunFiles {
  return {
    sessions: readArtifact(path.join(runDir, "sessions.json")),
    skipped: readArtifact(path.join(runDir, "skipped.json")),
    arms: readArtifact(path.join(runDir, "arms.json")),
    drafts: readArtifact(path.join(runDir, "drafts.json")),
  };
}

async function generate(): Promise<void> {
  const apiKey = openRouterApiKey();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const teacherId = option("teacher-id") ?? KEVIN_ONLINE_WISE_USER_ID;
  const tutor = rosterTutor(teacherId);
  if (!tutor) throw new Error("Teacher is not on the autowriter roster");
  const now = new Date();
  const db = getDb();
  const evalLimit = Number(option("eval-limit") ?? "20");
  const [mappings, shortlist, priorFeedback] = await Promise.all([
    loadFieldMappings(db),
    loadCandidateShortlist(db, { teacherIds: [teacherId], now }),
    loadPriorFeedback(db, { canonicalTutorKey: tutor.canonicalKey, now }),
  ]);
  const evalRows = evalLimit > 0
    ? await loadEvalSessions(db, { teacherId, limit: evalLimit, excludeSessionIds: shortlist.map((row) => row.wiseSessionId) })
    : [];
  console.log(`Shortlist ${shortlist.length}, eval ${evalRows.length}, prior feedback ${priorFeedback.length}`);

  const ops = createWiseFeedbackOps();
  const gateInput = { now, allowlist: AUTOWRITER_TEACHER_ALLOWLIST };
  const prepared: PreparedOrSkipped[] = [];
  for (const row of shortlist) prepared.push(await prepareSession({ ops, row, purpose: "candidate", mappings, gateInput }));
  for (const row of evalRows) prepared.push(await prepareSession({ ops, row, purpose: "eval", mappings, gateInput }));
  const sessions = prepared.flatMap((item) => item.ok ? [item.session] : []);
  const skipped = prepared.flatMap((item) => item.ok ? [] : [item]);
  const arms = Object.fromEntries(assignModelArms(sessions.filter((session) => session.purpose === "candidate").map((session) => ({
    sessionId: session.sessionId, classId: session.classId, scheduledStartAt: new Date(session.scheduledStartAt),
  }))));
  const jobs = sessions.flatMap((session) => (["sol", "glm", "luna"] as const).map((arm) => ({ session, arm })));
  const drafts = await mapWithConcurrency(jobs, 4, async ({ session, arm }) => {
    const draft = await generateDraft({ apiKey, arm, session, tutorNames: tutor.tutorNames, priorFeedback });
    const usage = "usage" in draft.call ? draft.call.usage : null;
    console.log(`${session.purpose} ${session.sessionId} ${arm}: ${draft.validation.ok ? "ok" : draft.validation.reasons.join(",")} cost=$${usage?.costUsd ?? "?"}`);
    return draft;
  });
  const runDir = path.join(AUTOWRITER_ROOT, "runs", now.toISOString().replace(/[:.]/gu, "-"));
  writeArtifact(path.join(runDir, "sessions.json"), sessions);
  writeArtifact(path.join(runDir, "skipped.json"), skipped);
  writeArtifact(path.join(runDir, "arms.json"), arms);
  writeArtifact(path.join(runDir, "drafts.json"), drafts);
  writeArtifact(path.join(runDir, "costs.json"), summarizeCosts(drafts));
  console.log(`Run written to ${runDir}`);
}

/**
 * Read-only replay of transcript first (see replay.ts). Refuses to run together with any write mode, and hands the
 * replay only Wise's session-detail GET — the POST is not reachable from it.
 */
async function replay(): Promise<void> {
  const writeModes = [
    ...["sweep", "pause", "resume"].filter((name) => flag(name)),
    ...["process", "mode", "retry", "tutor-on", "tutor-off"].filter((name) => option(name) !== undefined),
  ];
  if (writeModes.length > 0) throw new Error(`--replay never runs with a write mode (${writeModes.map((name) => `--${name}`).join(", ")})`);
  const apiKey = openRouterApiKey();
  const sonioxKey = sonioxApiKey();
  if (!apiKey || !sonioxKey) throw new Error("--replay needs OPENROUTER_API_KEY and SONIOX_API_KEY");
  const sessionIds = (option("sessions") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const invalid = sessionIds.filter((id) => !/^[0-9a-f]{24}$/iu.test(id));
  if (invalid.length > 0) throw new Error(`Not Wise session ids: ${invalid.join(", ")}`);
  const count = (name: string, fallback: number, max: number) => {
    const value = Number(option(name) ?? fallback);
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`--${name} must be a whole number from 0 to ${max}`);
    return value;
  };
  const perTutor = count("per-tutor", sessionIds.length > 0 ? 0 : 4, 20);
  const days = count("days", 7, 30);
  const concurrency = Math.max(1, count("concurrency", 3, 6));
  const db = getDb();
  const now = new Date();
  const samples = await loadReplaySample(db, { sessionIds, perTutor, days, now });
  console.log(`Replaying ${samples.length} class(es): ${perTutor} per tutor over ${days} days${sessionIds.length ? ` + ${sessionIds.length} named` : ""}.`);
  const ops = createWiseFeedbackOps();
  // Only the GET crosses over: nothing the replay holds can POST.
  const wise: ReplayWiseReads = { getSessionDetailById: (sessionId) => ops.getSessionDetailById(sessionId) };
  // The replay deletes each job in `finally`; a Ctrl-C skips those, so jobs still in flight are deleted here.
  const soniox = createSonioxClient(sonioxKey);
  const inFlight = new Set<string>();
  const tracked: SonioxClient = {
    ...soniox,
    async create(input) {
      const job = await soniox.create(input);
      inFlight.add(job.id);
      return job;
    },
    async remove(id) {
      const gone = await soniox.remove(id);
      inFlight.delete(id);
      return gone;
    },
  };
  const onSignal = (signal: NodeJS.Signals) => {
    const pending = [...inFlight];
    console.error(`${signal}: deleting ${pending.length} Soniox job(s) still in flight…`);
    void Promise.allSettled(pending.map((id) => soniox.remove(id))).then((results) => {
      const left = pending.filter((_, index) => results[index].status === "rejected");
      if (left.length > 0) console.error(`Not deleted — delete them in the Soniox Console: ${left.join(", ")}`);
      process.exit(130);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const records = await runReplay({
    wise,
    soniox: tracked,
    apiKey,
    priorFeedback: (tutor) => loadTutorPriorFeedback(db, tutor, now),
    keepTranscripts: flag("keep-transcripts"),
  }, samples, {
    concurrency,
    onRecord: (record, index) => console.log(`${index + 1}/${samples.length} ${record.wiseSessionId} ${record.tutor ?? "?"}: ` +
      `${record.outcome.split(":").slice(0, 2).join(":")}${record.soniox?.undeletedJobs.length ? " (SONIOX JOB NOT DELETED)" : ""}`),
  });
  const summary = summarizeReplay(records);
  const runDir = path.join(AUTOWRITER_ROOT, "replay", now.toISOString().replace(/[:.]/gu, "-"));
  writeArtifact(path.join(runDir, "records.json"), records);
  writeArtifact(path.join(runDir, "summary.json"), summary);
  fs.writeFileSync(path.join(runDir, "summary.md"), renderReplayMarkdown({
    summary, records, commit: process.env.AUTOWRITER_LOCAL_COMMIT ?? null, generatedAt: now,
  }), { encoding: "utf8", mode: 0o600 });
  console.log(`Replay written to ${runDir}`);
  if (summary.soniox.undeletedJobs.length > 0) {
    console.error(`Soniox jobs not deleted (the production reaper removes them after 2 h): ${summary.soniox.undeletedJobs.join(", ")}`);
    process.exitCode = 1;
  }
}

function exportGrading(runDir: string, out: string, tutorNames: readonly string[]): void {
  const run = loadRun(runDir);
  const { groups, map } = buildGradingExport({ sessions: run.sessions, drafts: run.drafts, tutorNames, random: seededRandom(runDir) });
  writeArtifact(out, groups);
  writeArtifact(path.join(runDir, "grading-map.json"), map);
  console.log(`Grading export: ${groups.length} lessons, ${Object.keys(map).length} variants → ${out}`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // First, so a replay can never fall through to a write mode.
  if (flag("replay")) return replay();
  if (flag("status")) return status();
  if (option("mode") || flag("pause") || flag("resume") || option("tutor-off") || option("tutor-on") || option("retry")) return control();
  if (flag("sweep")) {
    const result = await runSweep(cliDeps(740_000));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const one = option("process");
  if (one) {
    const outcome = await processSession(cliDeps(600_000), { wiseSessionId: one, trigger: "cli" });
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (flag("generate")) return generate();
  const runDir = option("run");
  if (!runDir) throw new Error("Nothing to do — see the usage at the top of this file");
  if (flag("export-grading")) {
    const out = option("out");
    if (!out) throw new Error("--export-grading needs --out=<file>");
    const tutor = rosterTutor(option("teacher-id") ?? KEVIN_ONLINE_WISE_USER_ID);
    return exportGrading(runDir, out, tutor?.tutorNames ?? []);
  }
  if (flag("report")) {
    const costs = summarizeCosts(loadRun(runDir).drafts);
    writeArtifact(path.join(runDir, "costs.json"), costs);
    console.log(JSON.stringify(costs, null, 2));
    return;
  }
  throw new Error("Nothing to do — see the usage at the top of this file");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

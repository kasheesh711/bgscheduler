import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { POST_CLASS_FEEDBACK_FIELDS } from "@/lib/post-class-feedback/types";
import { evidenceHash } from "../atom/evidence";
import { chooseStudentDisplayName, describeClass } from "../prompt";
import { rosterTutor } from "../roster";
import {
  detailTeacherId,
  detailTeacherName,
  extractAiSummary,
  parseAutowriterSessionDetail,
  recordingForTranscription,
  scheduledWindow,
  storedTeacherFields,
  studentParticipants,
  tutorSelfNames,
  zoomTranscriptUrl,
  type AutowriterSessionDetail,
} from "../session";
import { SonioxError, sonioxCostUsd, type SonioxClient, type SonioxToken } from "../soniox";
import { buildTranscriptEvidence, parseZoomVtt, sonioxJobInput } from "../transcript";
import { activeWiseCooldown, stopFilePresent, writeWiseCooldown } from "./caps";
import { EXIT, NightlyStop } from "./exit";
import type { NightlyLedger } from "./ledger";
import { ensureDir, readJsonFile, sessionCacheDir, writeJsonAtomic, writeTextAtomic } from "./paths";
import type { EvidenceBundle, EvidenceGrade, NightlyTarget } from "./types";
import type { NightlyWiseReader } from "./wise-reader";

/**
 * Evidence for the nightly audit, cache-first under `cache/<sid>/` (0600; deleted after 7 days):
 *   a. the retained ISEB lesson record (`feedback_iseb_evidence`) — the writer's exact input for a guided post;
 *   b. the production Soniox transcript, READ-ONLY (`get` + `transcript` only: the facade cannot create or delete),
 *      rendered again exactly as the second pass rendered it;
 *   c. Zoom's captions (WEBVTT) as "[mm:ss] Name: text" lines;
 *   d. one paced Wise session-detail GET per class: the AI summary, Wise's current text, participants, files;
 *   e. optionally (`--retranscribe`) our own Soniox job on Wise's recording when the production transcript is gone —
 *      reserved in the ledger first, and deleted in `finally`.
 * Nothing here writes to Wise or to the database.
 */

const S = schema.feedbackAutowriterSessions;
const E = schema.feedbackIsebEvidence;

/** Zoom captions kept for the auditor. */
export const ZOOM_CAPTIONS_MAX_CHARS = 60_000;
/** Our own Soniox job: poll interval and longest wait. */
const RETRANSCRIBE_POLL_MS = 10_000;
const RETRANSCRIBE_TIMEOUT_MS = 20 * 60 * 1000;
/** A re-transcription is reserved at its list price plus this margin (Soniox bills the audio it hears). */
const SONIOX_ESTIMATE_MARGIN = 1.15;

// ---------------------------------------------------------------------------
// Read-only Soniox
// ---------------------------------------------------------------------------

/** The production Soniox job, read only: nothing reachable from it can create or delete a job. */
export type ReadOnlySoniox = Pick<SonioxClient, "get" | "transcript">;

export function readOnlySoniox(client: Pick<SonioxClient, "get" | "transcript">): ReadOnlySoniox {
  return Object.freeze({
    get: (id: string) => client.get(id),
    transcript: (id: string) => client.transcript(id),
  });
}

// ---------------------------------------------------------------------------
// Wise read gate
// ---------------------------------------------------------------------------

/**
 * UTC minutes when production jobs hit Wise: the snapshot sync at :00/:30 (and the minutes after), the autowriter and
 * activity jobs around :08/:22/:38/:52, post-class collection at :13/:43, the Wise activity sync at :17/:47 and credit
 * control at :20/:50. The nightly never starts a read in them.
 */
const BUSY_UTC_MINUTES = new Set([
  0, 1, 2, 3, 4, 30, 31, 32, 33, 34, 7, 8, 9, 21, 22, 23, 37, 38, 39, 51, 52, 53, 13, 17, 20, 43, 47, 50,
]);
/** A read starts only with at least this much of a quiet minute left before a busy one. */
const QUIET_TAIL_MS = 15_000;

function busyMinute(minute: number): boolean {
  return BUSY_UTC_MINUTES.has(((minute % 60) + 60) % 60);
}

/** How long to wait before a Wise read may start (0: now). */
export function wiseQuietWaitMs(now: Date): number {
  const minute = now.getUTCMinutes();
  const intoMinute = now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  if (!busyMinute(minute) && !(busyMinute(minute + 1) && intoMinute > 60_000 - QUIET_TAIL_MS)) return 0;
  let next = minute + 1;
  while (busyMinute(next)) next += 1;
  return (next - minute) * 60_000 - intoMinute;
}

export interface WiseReadGate {
  /** One Wise read: paced, in a quiet minute, under STOP/deadline/cooldown checks and the read cap. */
  read<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Reads started through the gate. */
  readonly reads: number;
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * The gate every nightly Wise read goes through: STOP files, the deadline and a running 429 cooldown stop the stage;
 * reads are at least `pacingMs` apart and start only in quiet UTC minutes; each is reserved (`wise_read`) in the ledger
 * first. The first 429 parks Wise for 30 minutes (`~/.bgscheduler-nightly/wise-cooldown-until`) and stops the stage.
 */
export function createWiseReadGate(deps: {
  ledger: Pick<NightlyLedger, "reserve" | "settle">;
  pacingMs: number;
  deadline: Date | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  stopFiles?: readonly string[];
  /** Home override for the cooldown file (tests). */
  home?: string;
}): WiseReadGate {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastReadAt: number | null = null;
  let reads = 0;
  const checkStops = () => {
    if (stopFilePresent(deps.stopFiles)) throw new NightlyStop("stop_file", EXIT.stopped);
    if (deps.deadline && now().getTime() >= deps.deadline.getTime()) throw new NightlyStop("deadline", EXIT.stopped);
    if (activeWiseCooldown(now(), deps.home)) throw new NightlyStop("wise_cooldown", EXIT.wiseThrottled);
  };
  return {
    get reads() {
      return reads;
    },
    async read<T>(key: string, fn: () => Promise<T>): Promise<T> {
      for (;;) {
        checkStops();
        const at = now().getTime();
        const pace = lastReadAt === null ? 0 : Math.max(0, lastReadAt + deps.pacingMs - at);
        const wait = pace + wiseQuietWaitMs(new Date(at + pace));
        if (wait <= 0) break;
        if (deps.deadline && at + wait >= deps.deadline.getTime()) throw new NightlyStop("deadline", EXIT.stopped);
        // Look at STOP again at least every 30 s while waiting.
        await sleep(Math.min(wait, 30_000));
      }
      const reserved = deps.ledger.reserve("wise_read", { key, estimateUsd: 0 });
      if (!reserved.ok) throw new NightlyStop(reserved.reason, EXIT.caps);
      reads += 1;
      try {
        const value = await fn();
        deps.ledger.settle(reserved.id, { actualUsd: 0, outcome: "success" });
        return value;
      } catch (error) {
        if (statusOf(error) === 429) {
          deps.ledger.settle(reserved.id, { actualUsd: 0, outcome: "wise_429" });
          writeWiseCooldown(now(), deps.home);
          throw new NightlyStop("wise_429", EXIT.wiseThrottled);
        }
        deps.ledger.settle(reserved.id, { actualUsd: 0, outcome: "error" });
        throw error;
      } finally {
        lastReadAt = now().getTime();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Raw evidence
// ---------------------------------------------------------------------------

/** A Soniox transcript kept in the cache: the production job's, or our own re-transcription's. */
export interface CachedTranscript {
  source: "production" | "retranscribed";
  jobId: string;
  audioDurationMs: number | null;
  text: string;
  tokens: SonioxToken[];
  fetchedAt: string;
}

export interface IsebRecord {
  evidenceHash: string;
  lessonRecord: string;
  evidenceKind: "summary" | "transcript";
}

/** What the autowriter's row says about how the post was written (SELECT only). */
export interface RowMeta {
  /** `metadata.transcript.speakerMethod` of the transcript draft: zoom_alignment, talk_share or unclear. */
  speakerMethod: string | null;
  /** The production judge's verdict stored with the draft. */
  judge: unknown;
  /** The guest name the student joined under, when they did. */
  joinedAsGuest: string | null;
}

export interface CollectStatus {
  collectedAt: string;
  rowMeta: "cached" | "read";
  iseb: "found" | "none" | "not_guided" | "cached";
  detail: "cached" | "fetched" | "failed" | "not_attempted";
  detailError?: string;
  soniox: "cached" | "fetched" | "missing" | "no_job" | "not_finished" | "error" | "not_needed" | "no_client";
  sonioxError?: string;
  zoom: "cached" | "fetched" | "none" | "error" | "not_attempted";
  retranscribe: string;
  /** Our own Soniox job whose delete failed (the production reaper removes it after 2 h; listed for a person). */
  undeletedSonioxJob?: string;
}

export interface RawEvidence {
  wiseSessionId: string;
  /** The Wise session-detail response as returned (parse with `parseAutowriterSessionDetail`). */
  detail: unknown | null;
  iseb: IsebRecord | null;
  transcript: CachedTranscript | null;
  zoomVtt: string | null;
  rowMeta: RowMeta;
  status: CollectStatus;
  notes: string[];
}

/** SELECT-only reads the evidence step needs from our database. */
export interface EvidenceSources {
  rowMeta(wiseSessionId: string): Promise<RowMeta>;
  isebRecord(wiseSessionId: string, evidenceHash: string): Promise<IsebRecord | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dbEvidenceSources(db: Database): EvidenceSources {
  return {
    async rowMeta(wiseSessionId) {
      const [row] = await db.select({ metadata: S.metadata }).from(S).where(eq(S.wiseSessionId, wiseSessionId)).limit(1);
      const metadata = isRecord(row?.metadata) ? row.metadata : {};
      const transcript = isRecord(metadata.transcript) ? metadata.transcript : null;
      const guest = metadata.studentJoinedAsGuest;
      return {
        speakerMethod: typeof transcript?.speakerMethod === "string" ? transcript.speakerMethod : null,
        judge: metadata.judge ?? null,
        joinedAsGuest: typeof guest === "string" && guest !== "(unnamed guest)" && guest.trim() ? guest.trim() : null,
      };
    },
    async isebRecord(wiseSessionId, hash) {
      const [row] = await db.select({ evidenceHash: E.evidenceHash, lessonRecord: E.lessonRecord, evidenceKind: E.evidenceKind })
        .from(E).where(and(eq(E.wiseSessionId, wiseSessionId), eq(E.evidenceHash, hash))).limit(1);
      return row ?? null;
    },
  };
}

export interface RetranscribeDeps {
  /** A full Soniox client: used ONLY for our own job (create → get → transcript → remove). */
  client: SonioxClient;
  ledger: Pick<NightlyLedger, "reserve" | "settle">;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** A STOP file or the deadline ends the wait (the job is still deleted). */
  shouldStop?: () => string | null;
  /** Jobs created and not yet deleted, for the CLI's signal handler. */
  inFlight?: Set<string>;
}

export interface CollectDeps {
  cacheDir: string;
  sources: EvidenceSources;
  wise: NightlyWiseReader;
  gate: WiseReadGate;
  /** The production job, read only; null when no Soniox key is configured. */
  soniox: ReadOnlySoniox | null;
  fetchText: (url: string) => Promise<string>;
  /** Set only with `--retranscribe`. */
  retranscribe?: RetranscribeDeps | null;
  now?: () => Date;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function parseDetail(raw: unknown): AutowriterSessionDetail | null {
  if (raw === null || raw === undefined) return null;
  try {
    return parseAutowriterSessionDetail(raw);
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

async function removeOurJob(client: SonioxClient, jobId: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await client.remove(jobId);
      return true;
    } catch {
      if (attempt < 3) await sleep(2_000);
    }
  }
  return false;
}

/** What a re-transcription gave: our transcript, or why not; plus a job whose delete failed (null normally). */
export type RetranscribeResult =
  | { ok: true; transcript: CachedTranscript; costUsd: number | null; undeleted: string | null }
  | { ok: false; reason: string; undeleted: string | null };

/**
 * Our own Soniox job on Wise's recording, reserved in the ledger at list price before it is created, polled up to a
 * time-out, fetched, and deleted afterwards whatever happened (a killed process leaves it to the CLI's signal handler,
 * then to the production reaper after 2 h). The production job is never created, polled or deleted here.
 */
export async function retranscribeRecording(deps: RetranscribeDeps, input: {
  wiseSessionId: string;
  detail: AutowriterSessionDetail;
  audioUrl: string;
  durationSeconds: number | null;
  productionJobId: string | null;
  now?: () => Date;
}): Promise<RetranscribeResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? (() => new Date());
  const seconds = input.durationSeconds && input.durationSeconds > 0 ? input.durationSeconds : scheduledWindow(input.detail).minutes * 60;
  const estimateUsd = Math.round(sonioxCostUsd(seconds * 1000) * SONIOX_ESTIMATE_MARGIN * 10_000) / 10_000;
  const reserved = deps.ledger.reserve("soniox", { key: `soniox:${input.wiseSessionId}`, estimateUsd });
  if (!reserved.ok) return { ok: false, reason: reserved.reason, undeleted: null };
  const [student] = studentParticipants(input.detail);
  const tutor = rosterTutor(detailTeacherId(input.detail));
  let ourJob: string | null = null;
  let actualUsd: number | null = null;
  let outcome = "error";
  let stopped: NightlyStop | null = null;
  let undeleted: string | null = null;
  type Outcome = { ok: true; transcript: CachedTranscript; costUsd: number | null } | { ok: false; reason: string };
  let result: Outcome = { ok: false, reason: "unfinished" };
  try {
    const created = (await deps.client.create(sonioxJobInput({
      wiseSessionId: input.wiseSessionId,
      audioUrl: input.audioUrl,
      detail: input.detail,
      tutorNames: tutor?.tutorNames ?? tutorSelfNames(input.detail),
      studentName: student?.name ?? "",
    }))).id;
    if (created === input.productionJobId) {
      // Never possible (Soniox ids are unique): refuse to touch it, and never delete it.
      throw new NightlyStop("breach:soniox_job_reuse", EXIT.safety);
    }
    ourJob = created;
    deps.inFlight?.add(created);
    const started = Date.now();
    for (;;) {
      const stop = deps.shouldStop?.();
      if (stop) throw new NightlyStop(stop, stop === "deadline" || stop === "stop_file" ? EXIT.stopped : EXIT.error);
      let status: Awaited<ReturnType<SonioxClient["get"]>> | null = null;
      try {
        status = await deps.client.get(created);
      } catch {
        status = null;
      }
      if (status?.status === "completed") {
        const transcript = await deps.client.transcript(created);
        actualUsd = status.audioDurationMs === null ? null : sonioxCostUsd(status.audioDurationMs);
        outcome = "success";
        result = {
          ok: true,
          costUsd: actualUsd,
          transcript: {
            source: "retranscribed", jobId: created, audioDurationMs: status.audioDurationMs, text: transcript.text,
            tokens: transcript.tokens, fetchedAt: now().toISOString(),
          },
        };
        break;
      }
      if (status?.status === "error") {
        actualUsd = status.audioDurationMs === null ? null : sonioxCostUsd(status.audioDurationMs);
        result = { ok: false, reason: `soniox_error:${(status.errorMessage ?? "unknown").slice(0, 120)}` };
        break;
      }
      if (Date.now() - started > (deps.timeoutMs ?? RETRANSCRIBE_TIMEOUT_MS)) {
        result = { ok: false, reason: "soniox_timeout" };
        break;
      }
      await sleep(deps.pollMs ?? RETRANSCRIBE_POLL_MS);
    }
  } catch (error) {
    if (error instanceof NightlyStop) stopped = error;
    result = { ok: false, reason: error instanceof NightlyStop ? error.reason : `soniox:${message(error)}` };
  } finally {
    // Whatever happened — even when settling the ledger throws — our job is deleted (never the production job).
    try {
      deps.ledger.settle(reserved.id, { actualUsd, outcome });
    } finally {
      if (ourJob && ourJob !== input.productionJobId) {
        if (await removeOurJob(deps.client, ourJob, sleep)) deps.inFlight?.delete(ourJob);
        else undeleted = ourJob;
      }
    }
  }
  if (stopped) throw stopped;
  return { ...result, undeleted };
}

/**
 * Collect one class's raw evidence, cache-first. A NightlyStop (STOP, deadline, Wise 429, a cap) propagates: the
 * stage ends and a later run resumes from the cache. Other failures are recorded in the status and the class goes on
 * with what it has.
 */
export async function collectRawEvidence(deps: CollectDeps, target: NightlyTarget): Promise<RawEvidence> {
  const now = deps.now ?? (() => new Date());
  const sid = target.wiseSessionId;
  const dir = sessionCacheDir(deps.cacheDir, sid);
  ensureDir(dir);
  const file = (name: string) => path.join(dir, name);
  const previous = readJsonFile<CollectStatus>(file("status.json"));
  const notes: string[] = [];
  const status: CollectStatus = {
    collectedAt: now().toISOString(),
    rowMeta: "cached",
    iseb: "not_guided",
    detail: "not_attempted",
    soniox: "not_needed",
    zoom: "not_attempted",
    retranscribe: "not_requested",
  };
  const saveStatus = () => writeJsonAtomic(file("status.json"), status);

  try {
    // 0. The row's own facts (SELECT).
    let rowMeta = readJsonFile<RowMeta>(file("row-meta.json"));
    if (!rowMeta) {
      rowMeta = await deps.sources.rowMeta(sid);
      writeJsonAtomic(file("row-meta.json"), rowMeta);
      status.rowMeta = "read";
    }

    // a. The writer's exact input, retained for guided posts.
    const lessonHash = typeof target.pipeline?.lessonEvidenceHash === "string" ? target.pipeline.lessonEvidenceHash : null;
    let iseb = readJsonFile<IsebRecord>(file("iseb.json"));
    if (iseb) {
      status.iseb = "cached";
    } else if (lessonHash) {
      iseb = await deps.sources.isebRecord(sid, lessonHash);
      if (iseb) writeJsonAtomic(file("iseb.json"), iseb);
      status.iseb = iseb ? "found" : "none";
    }
    const exactTranscript = iseb?.evidenceKind === "transcript";

    // d. Wise's session detail: one paced GET, only when not cached.
    let rawDetail = readJsonFile<unknown>(file("detail.json"));
    let detail = parseDetail(rawDetail);
    if (detail) {
      status.detail = "cached";
    } else {
      try {
        const response = await deps.gate.read(`wise_read:${sid}`, () => (target.wiseClassId
          ? deps.wise.getSessionDetail(target.wiseClassId, sid)
          : deps.wise.getSessionDetailById(sid)));
        detail = parseAutowriterSessionDetail(response);
        rawDetail = response;
        writeJsonAtomic(file("detail.json"), response);
        status.detail = "fetched";
      } catch (error) {
        if (error instanceof NightlyStop) throw error;
        status.detail = "failed";
        status.detailError = message(error);
        rawDetail = null;
      }
    }

    // b. The production transcript, read only, while its job still exists.
    let transcript = readJsonFile<CachedTranscript>(file("transcript.json"));
    if (transcript) {
      status.soniox = "cached";
    } else if (exactTranscript) {
      status.soniox = "not_needed";
    } else if (!target.sonioxTranscriptionId) {
      status.soniox = "no_job";
    } else if (previous?.soniox === "missing") {
      status.soniox = "missing";
    } else if (!deps.soniox) {
      status.soniox = "no_client";
    } else {
      const jobId = target.sonioxTranscriptionId;
      try {
        const job = await deps.soniox.get(jobId);
        if (job.status === "completed") {
          const fetched = await deps.soniox.transcript(jobId);
          transcript = {
            source: "production", jobId, audioDurationMs: job.audioDurationMs, text: fetched.text, tokens: fetched.tokens,
            fetchedAt: now().toISOString(),
          };
          writeJsonAtomic(file("transcript.json"), transcript);
          status.soniox = "fetched";
        } else {
          status.soniox = "not_finished";
        }
      } catch (error) {
        if (error instanceof SonioxError && error.status === 404) status.soniox = "missing";
        else {
          status.soniox = "error";
          status.sonioxError = message(error);
        }
      }
    }

    // c. Zoom's captions (a signed file URL from the detail; not a Wise API call).
    let zoomVtt = readText(file("zoom.vtt"));
    const vttUrl = detail ? zoomTranscriptUrl(detail) : null;
    if (zoomVtt !== null) {
      status.zoom = "cached";
    } else if (vttUrl) {
      try {
        zoomVtt = await deps.fetchText(vttUrl);
        writeTextAtomic(file("zoom.vtt"), zoomVtt);
        status.zoom = "fetched";
      } catch (error) {
        status.zoom = "error";
        notes.push(`zoom_captions_unreadable:${message(error).slice(0, 80)}`);
      }
    } else {
      status.zoom = detail ? "none" : "not_attempted";
    }

    // e. Our own re-transcription, only for a transcript post whose production transcript is gone (deleted, or no
    //    job on the row) — never because a read of a production job that may still exist failed.
    const productionGone = status.soniox === "missing" || status.soniox === "no_job";
    if (!transcript && !exactTranscript && target.evidence === "transcript" && productionGone) {
      if (!deps.retranscribe) {
        status.retranscribe = "not_requested";
      } else if (!detail) {
        status.retranscribe = "no_detail";
      } else {
        const recording = recordingForTranscription(detail);
        if (!recording.ok) {
          status.retranscribe = `no_recording:${recording.reason}`;
        } else {
          const result = await retranscribeRecording(deps.retranscribe, {
            wiseSessionId: sid, detail, audioUrl: recording.url, durationSeconds: recording.durationSeconds,
            productionJobId: target.sonioxTranscriptionId, now,
          });
          if (result.undeleted) {
            status.undeletedSonioxJob = result.undeleted;
            notes.push(`soniox_job_not_deleted:${result.undeleted}`);
          }
          if (result.ok) {
            transcript = result.transcript;
            writeJsonAtomic(file("transcript.json"), transcript);
            status.retranscribe = "done";
          } else {
            status.retranscribe = result.reason.startsWith("cap:") ? `refused:${result.reason}` : `failed:${result.reason}`;
          }
        }
      }
    } else {
      status.retranscribe = transcript || exactTranscript || target.evidence !== "transcript" ? "not_needed" : `not_attempted:${status.soniox}`;
    }

    return { wiseSessionId: sid, detail: rawDetail ?? null, iseb, transcript, zoomVtt, rowMeta, status, notes };
  } finally {
    saveStatus();
  }
}

/** A cached class's raw evidence without any network or database access (null when it was never collected). */
export function readCachedEvidence(cacheDir: string, wiseSessionId: string): RawEvidence | null {
  const dir = sessionCacheDir(cacheDir, wiseSessionId);
  const status = readJsonFile<CollectStatus>(path.join(dir, "status.json"));
  const rowMeta = readJsonFile<RowMeta>(path.join(dir, "row-meta.json"));
  if (!status || !rowMeta) return null;
  return {
    wiseSessionId,
    detail: readJsonFile<unknown>(path.join(dir, "detail.json")),
    iseb: readJsonFile<IsebRecord>(path.join(dir, "iseb.json")),
    transcript: readJsonFile<CachedTranscript>(path.join(dir, "transcript.json")),
    zoomVtt: readText(path.join(dir, "zoom.vtt")),
    rowMeta,
    status,
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// Bundle (pure)
// ---------------------------------------------------------------------------

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function vttMs(value: string): number | null {
  const match = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/u.exec(value.trim());
  if (!match) return null;
  const [, hours = "0", minutes, seconds, fraction] = match;
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));
}

/**
 * Zoom's WEBVTT as "[mm:ss] Name: text" lines (speaker names kept: the auditor maps them to the people). Over
 * `maxChars`, the start and the end are kept (homework is usually set at the end).
 */
export function renderZoomCaptions(vtt: string, maxChars: number = ZOOM_CAPTIONS_MAX_CHARS): string {
  const lines: string[] = [];
  for (const block of vtt.split(/\r?\n\r?\n/u)) {
    const rows = block.split(/\r?\n/u).filter((line) => line.trim() !== "");
    const timing = rows.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const start = vttMs(rows[timing].split("-->")[0] ?? "");
    const body = rows.slice(timing + 1).join(" ").replace(/\s+/gu, " ").trim();
    if (start === null || !body) continue;
    lines.push(`[${clock(start)}] ${body}`);
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(text.length - Math.floor(maxChars * 0.3) + 40);
  return `${head.slice(0, head.lastIndexOf("\n"))}\n[… middle of the captions omitted …]\n${tail.slice(tail.indexOf("\n") + 1)}`;
}

function unique(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed.toLocaleLowerCase("en-US"))) continue;
    seen.add(trimmed.toLocaleLowerCase("en-US"));
    out.push(trimmed);
  }
  return out;
}

function fieldsOf(value: Partial<Record<string, string>> | null): Record<string, string> | null {
  if (!value) return null;
  return Object.fromEntries(POST_CLASS_FEEDBACK_FIELDS.map((field) => [field, value[field] ?? ""]));
}

/** The bundle's content hash: everything but the night and the hash itself (the same evidence hashes the same). */
export function bundleHash(bundle: Omit<EvidenceBundle, "hash" | "night"> & Partial<Pick<EvidenceBundle, "hash" | "night">>): string {
  const { hash: _hash, night: _night, ...content } = bundle;
  void _hash;
  void _night;
  return evidenceHash(content);
}

/**
 * The auditor's view of one class, from its target and raw evidence (pure). Grades: exact (the retained ISEB record,
 * or Wise's summary for a summary-route post), rebuilt (the production transcript), retranscribed, secondary_only
 * (only the summary or captions for a transcript post), none.
 */
export function buildEvidenceBundle(input: { target: NightlyTarget; night: string; raw: RawEvidence }): EvidenceBundle {
  const { target, raw } = input;
  const detail = parseDetail(raw.detail);
  const [student] = detail ? studentParticipants(detail) : [];
  const studentFullName = student?.name?.trim() || target.studentFullName;
  const tutor = rosterTutor(detail ? detailTeacherId(detail) : target.wiseTeacherUserId);
  const summary = detail ? extractAiSummary(detail)?.text ?? null : null;
  const wiseCurrent = detail ? storedTeacherFields(detail) : null;
  const wiseCurrentFields = fieldsOf(wiseCurrent as Partial<Record<string, string>> | null);
  const scheduledMinutes = detail ? scheduledWindow(detail).minutes : null;
  const zoomCaptions = raw.zoomVtt ? renderZoomCaptions(raw.zoomVtt) || null : null;
  const labelsFor = (method: string | null) => (method === "zoom_alignment" ? "verified" : "inferred");

  let transcript: EvidenceBundle["transcript"] = null;
  let wiseSummary = summary;
  if (raw.iseb?.evidenceKind === "transcript") {
    transcript = {
      text: raw.iseb.lessonRecord, source: "iseb_record", speakerMethod: raw.rowMeta.speakerMethod,
      speakerLabels: labelsFor(raw.rowMeta.speakerMethod),
    };
  } else if (raw.iseb?.evidenceKind === "summary") {
    // The summary exactly as the writer saw it.
    wiseSummary = raw.iseb.lessonRecord;
  }
  if (!transcript && raw.transcript && detail) {
    // Production rendered with Zoom's cues only when it aligned them (zoom_alignment); otherwise by talk share.
    const cues = raw.zoomVtt && (raw.transcript.source === "retranscribed" || raw.rowMeta.speakerMethod === "zoom_alignment")
      ? parseZoomVtt(raw.zoomVtt) : [];
    const rebuilt = buildTranscriptEvidence({
      transcript: raw.transcript,
      audioDurationMs: raw.transcript.audioDurationMs,
      scheduledMinutes: scheduledWindow(detail).minutes,
      zoomCues: cues,
      teacherName: detailTeacherName(detail),
      alsoTeacher: tutorSelfNames(detail),
    });
    transcript = {
      text: rebuilt.rendered,
      source: raw.transcript.source === "production" ? "production_soniox" : "retranscribed_soniox",
      speakerMethod: rebuilt.speakers.method,
      speakerLabels: rebuilt.speakerLabels,
    };
  }

  let grade: EvidenceGrade;
  if (raw.iseb) grade = "exact";
  else if (target.evidence === "summary" && wiseSummary) grade = "exact";
  else if (target.evidence === "transcript" && transcript?.source === "production_soniox") grade = "rebuilt";
  else if (target.evidence === "transcript" && transcript?.source === "retranscribed_soniox") grade = "retranscribed";
  else if (wiseSummary || zoomCaptions || transcript) grade = "secondary_only";
  else grade = "none";

  const content: Omit<EvidenceBundle, "hash" | "night"> = {
    wiseSessionId: target.wiseSessionId,
    grade,
    classDetails: detail ? describeClass({ programme: detail.classSubject, title: detail.title }) : [],
    tutorNames: unique([...(tutor?.tutorNames ?? []), ...(detail ? tutorSelfNames(detail) : [])]),
    studentFullName,
    studentDisplayName: studentFullName ? chooseStudentDisplayName(studentFullName) : target.studentDisplayName,
    studentAliases: unique([student?.joinedAsGuest, raw.rowMeta.joinedAsGuest]),
    postedFields: { ...target.fields },
    wiseCurrentFields,
    wiseTextMatchesPost: wiseCurrentFields
      ? POST_CLASS_FEEDBACK_FIELDS.every((field) => wiseCurrentFields[field] === (target.fields[field] ?? ""))
      : null,
    transcript,
    wiseSummary,
    zoomCaptions,
    postedEvidenceKind: target.evidence,
    scheduledMinutes,
    storedJudge: raw.rowMeta.judge ?? target.pipeline?.factualVerdicts ?? null,
    pipeline: target.pipeline,
  };
  return { ...content, night: input.night, hash: bundleHash(content) };
}

/** What a rebuilt transcript says about itself compared with the post's own record (info for the report). */
export function evidenceNotes(raw: RawEvidence, bundle: EvidenceBundle): string[] {
  const notes = [...raw.notes];
  if (bundle.transcript?.source === "production_soniox" && raw.rowMeta.speakerMethod && bundle.transcript.speakerMethod !== raw.rowMeta.speakerMethod) {
    notes.push(`rebuilt_speaker_method_differs:${raw.rowMeta.speakerMethod}->${bundle.transcript.speakerMethod}`);
  }
  if (raw.status.detail === "failed") notes.push(`wise_detail_failed:${raw.status.detailError ?? "?"}`);
  if (raw.status.soniox === "missing") notes.push("production_transcript_deleted");
  if (raw.status.retranscribe.startsWith("failed:") || raw.status.retranscribe.startsWith("refused:")) notes.push(`retranscribe_${raw.status.retranscribe}`);
  return notes;
}

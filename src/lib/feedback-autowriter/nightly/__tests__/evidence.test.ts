import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionDetail, answers, autoBlankSubmission } from "../../__tests__/fixtures";
import { KEVIN_ONLINE_WISE_USER_ID } from "../../roster";
import { SonioxError, type SonioxClient, type SonioxToken } from "../../soniox";
import { NIGHTLY_CAPS } from "../caps";
import {
  buildEvidenceBundle,
  bundleHash,
  collectRawEvidence,
  createWiseReadGate,
  evidenceNotes,
  readCachedEvidence,
  readOnlySoniox,
  renderZoomCaptions,
  wiseQuietWaitMs,
  type CollectDeps,
  type RawEvidence,
  type RowMeta,
} from "../evidence";
import { NightlyStop } from "../exit";
import { NightlyLedger } from "../ledger";
import { readJsonl } from "../paths";
import type { NightlyTarget } from "../types";

const SID = "6a0000000000000000000a01";
const CID = "6a00000000000000000000c1";
const STUDENT = "Pimchanok (Pim.Ta) Testwong";
const TEACHER = "Kevin (Kev) Y. Hsieh Online";
const POSTED = {
  topics: "1. Adding fractions with unlike denominators",
  performance: "Pim found common denominators and checked each answer.",
  improvement: "1. Simplify every answer fully.",
  homework: "",
};

let dir: string;
let clock: number;
const now = () => new Date(clock);
const sleep = vi.fn(async (ms: number) => {
  clock += ms;
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-evidence-"));
  // 02:15 Bangkok on 3 Oct = 19:15 UTC: a quiet minute.
  clock = new Date("2026-10-02T19:15:00Z").getTime();
  sleep.mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function target(patch: Partial<NightlyTarget> = {}): NightlyTarget {
  return {
    wiseSessionId: SID, wiseClassId: CID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID, tutorKey: "Kevin",
    scheduledEndAt: "2026-10-02T09:30:00.000Z", deadlineAt: "2026-10-04T16:59:00.000Z", evidence: "transcript", arm: "sol",
    fields: POSTED, fieldsSha256: "sha-1", billing: { sessionStatus: "COMPLETED", creditsConsumed: 1 },
    sonioxTranscriptionId: "prod-job", firstShotPostId: "post-1", currentVerdictId: null, verdict: null, ownerFlagOpen: false,
    humanSavedSincePost: false, guided: false, pipeline: { evidence: "transcript", promptVersion: 5 },
    studentFullName: STUDENT, studentDisplayName: "Pim", className: STUDENT, ...patch,
  };
}

/** Tutor (speaker 1) does most of the talking; the student (speaker 2) answers. */
const TOKENS: SonioxToken[] = [
  { text: "Today we add fractions with unlike denominators, so first we look for the lowest common multiple of both.", start_ms: 0, end_ms: 9_000, speaker: "1" },
  { text: " I think it is twelve.", start_ms: 10_000, end_ms: 14_000, speaker: "2" },
  { text: " Good, twelve works. Now rewrite each fraction over twelve and add the numerators, then simplify the result.", start_ms: 15_000, end_ms: 29_000, speaker: "1" },
  { text: " Five over six.", start_ms: 30_000, end_ms: 34_000, speaker: "2" },
];
const TRANSCRIPT = { text: TOKENS.map((token) => token.text).join(""), tokens: TOKENS };
const VTT = [
  "WEBVTT",
  "",
  "1",
  "00:00:00.000 --> 00:00:09.000",
  `${TEACHER}: Today we add fractions with unlike denominators.`,
  "",
  "2",
  "00:00:10.000 --> 00:00:14.000",
  `${STUDENT}: I think it is twelve.`,
  "",
  "3",
  "00:00:15.000 --> 00:00:29.000",
  `${TEACHER}: Good, twelve works.`,
  "",
  "4",
  "00:00:30.000 --> 00:00:34.000",
  `${STUDENT}: Five over six.`,
  "",
].join("\n");

function detail(patch: Record<string, unknown> = {}) {
  return sessionDetail({
    _id: SID,
    classId: CID,
    className: STUDENT,
    title: "Live Session - Maths",
    classSubject: "Y5-6",
    scheduledStartTime: "2026-10-02T08:30:00.000Z",
    scheduledEndTime: "2026-10-02T09:30:00.000Z",
    participants: [
      { wiseUserId: KEVIN_ONLINE_WISE_USER_ID, name: TEACHER, isTeacher: true, inMeetingDuration: 3800 },
      { wiseUserId: "6a0000000000000000000003", name: STUDENT, isTeacher: false, inMeetingDuration: 3700, absolutePercentAttendance: 98 },
    ],
    feedbackSubmissions: [autoBlankSubmission({
      answers: answers([POSTED.topics, POSTED.performance, POSTED.improvement, POSTED.homework]),
      metadata: { autoSubmitted: false },
    })],
    rawMeetingSummary: [{ summaryOverview: "The class added fractions with unlike denominators.", summaryDetails: [], meetingUUID: "u1" }],
    rawRecordings: [{ url: "https://files.example.invalid/recording.mp4", partIndex: 0, duration: 3600 }],
    rawTranscript: [{ url: "https://files.example.invalid/captions.vtt" }],
    ...patch,
  });
}

function setup(options: { rowMeta?: Partial<RowMeta>; detailPatch?: Record<string, unknown>; sonioxGet?: SonioxClient["get"] } = {}) {
  const ledger = NightlyLedger.open(dir, "2026-10-02", { ...NIGHTLY_CAPS }, { now });
  const wise = {
    getSessionDetail: vi.fn(async () => ({ data: detail(options.detailPatch) })),
    getSessionDetailById: vi.fn(async () => ({ data: detail(options.detailPatch) })),
  };
  const production = {
    get: vi.fn(options.sonioxGet ?? (async () => ({ status: "completed" as const, audioDurationMs: 3_600_000, errorMessage: null }))),
    transcript: vi.fn(async () => TRANSCRIPT),
  };
  const fetchText = vi.fn(async () => VTT);
  const sources = {
    rowMeta: vi.fn(async (): Promise<RowMeta> => ({ speakerMethod: "zoom_alignment", judge: { faithful: true }, joinedAsGuest: null, ...options.rowMeta })),
    isebRecord: vi.fn(async () => null),
  };
  const gate = createWiseReadGate({
    ledger, pacingMs: 5_000, deadline: new Date("2026-10-02T23:50:00Z"), now, sleep,
    stopFiles: [path.join(dir, "STOP")], home: dir,
  });
  const deps: CollectDeps = {
    cacheDir: path.join(dir, "cache"), sources, wise, gate, soniox: readOnlySoniox(production), fetchText, now,
  };
  return { deps, ledger, wise, production, fetchText, sources, gate };
}

describe("read-only Soniox", () => {
  it("exposes only get and transcript: creating or deleting a job is not reachable", async () => {
    const client: SonioxClient = {
      create: vi.fn(), get: vi.fn(async () => ({ status: "completed" as const, audioDurationMs: 1, errorMessage: null })),
      transcript: vi.fn(async () => ({ text: "", tokens: [] })), remove: vi.fn(), list: vi.fn(),
    };
    const facade = readOnlySoniox(client);
    expect(Object.keys(facade).sort()).toEqual(["get", "transcript"]);
    expect("create" in facade).toBe(false);
    expect("remove" in facade).toBe(false);
    expect((facade as unknown as Record<string, unknown>).create).toBeUndefined();
    expect((facade as unknown as Record<string, unknown>).remove).toBeUndefined();
    expect(Object.isFrozen(facade)).toBe(true);
    await facade.get("job");
    await facade.transcript("job");
    expect(client.create).not.toHaveBeenCalled();
    expect(client.remove).not.toHaveBeenCalled();
  });
});

describe("Wise read gate", () => {
  it("never starts a read in the minutes production hits Wise", () => {
    const at = (iso: string) => wiseQuietWaitMs(new Date(iso));
    expect(at("2026-10-02T19:15:00Z")).toBe(0);
    expect(at("2026-10-02T19:00:10Z")).toBe(5 * 60_000 - 10_000); // :00–:04 → :05
    expect(at("2026-10-02T19:31:00Z")).toBe(4 * 60_000); // :30–:34 → :35
    expect(at("2026-10-02T19:08:00Z")).toBe(2 * 60_000); // :07–:09 → :10
    expect(at("2026-10-02T19:52:30Z")).toBe(90_000); // :51–:53 → :54
    expect(at("2026-10-02T19:06:50Z")).toBe(3 * 60_000 + 10_000); // too little left of :06 → :10
    expect(at("2026-10-02T19:06:40Z")).toBe(0);
    expect(at("2026-10-02T19:59:50Z")).toBe(5 * 60_000 + 10_000); // into the next hour's :00–:04
    // Post-class collection (:13/:43), the Wise activity sync (:17/:47) and credit control (:20/:50).
    expect(at("2026-10-02T19:13:00Z")).toBe(60_000); // → :14
    expect(at("2026-10-02T19:17:30Z")).toBe(30_000); // → :18
    expect(at("2026-10-02T19:20:00Z")).toBe(4 * 60_000); // :20–:23 → :24
    expect(at("2026-10-02T19:43:00Z")).toBe(60_000); // → :44
    expect(at("2026-10-02T19:47:00Z")).toBe(60_000); // → :48
    expect(at("2026-10-02T19:50:00Z")).toBe(4 * 60_000); // :50–:53 → :54
    expect(at("2026-10-02T19:12:50Z")).toBe(70_000); // too little left of :12 → :14
  });

  it("paces reads at least 5 s apart, reserving each in the ledger before it starts", async () => {
    const { gate, ledger } = setup();
    const starts: number[] = [];
    const read = () => gate.read("wise_read:x", async () => {
      // Reserved on disk before the read starts.
      expect(readJsonl<{ type: string }>(path.join(dir, "spend.jsonl")).filter((line) => line.type === "reserve")).toHaveLength(starts.length + 1);
      starts.push(clock);
      return 1;
    });
    await read();
    await read();
    await read();
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(5_000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(5_000);
    expect(ledger.used("wise_read").count).toBe(3);
    expect(gate.reads).toBe(3);
  });

  it("stops the stage on the first 429 and parks Wise for 30 minutes", async () => {
    const { gate, ledger } = setup();
    await expect(gate.read("k", async () => {
      throw Object.assign(new Error("Wise API 429: slow down"), { status: 429 });
    })).rejects.toMatchObject({ name: "NightlyStop", reason: "wise_429", exitCode: 5 });
    expect(fs.readFileSync(path.join(dir, ".bgscheduler-nightly", "wise-cooldown-until"), "utf8").trim()).toBe("2026-10-02T19:45:00.000Z");
    await expect(gate.read("k2", async () => 1)).rejects.toMatchObject({ reason: "wise_cooldown" });
    expect(ledger.used("wise_read").count).toBe(1);
  });

  it("stops for a STOP file, the deadline, or the read cap", async () => {
    const stop = setup();
    fs.writeFileSync(path.join(dir, "STOP"), "");
    await expect(stop.gate.read("k", async () => 1)).rejects.toMatchObject({ reason: "stop_file", exitCode: 7 });
    fs.rmSync(path.join(dir, "STOP"));
    clock = new Date("2026-10-02T23:50:00Z").getTime();
    await expect(stop.gate.read("k", async () => 1)).rejects.toMatchObject({ reason: "deadline" });
    clock = new Date("2026-10-02T19:15:00Z").getTime();
    const ledger = NightlyLedger.open(path.join(dir, "capped"), "2026-10-02", { ...NIGHTLY_CAPS, maxWiseReads: 1 }, { now });
    const gate = createWiseReadGate({ ledger, pacingMs: 5_000, deadline: null, now, sleep, stopFiles: [], home: dir });
    await gate.read("a", async () => 1);
    await expect(gate.read("b", async () => 1)).rejects.toMatchObject({ reason: "cap:wise_reads_night", exitCode: 3 });
  });

  it("passes other errors through after settling the reservation", async () => {
    const { gate, ledger } = setup();
    await expect(gate.read("k", async () => {
      throw Object.assign(new Error("Wise API 404"), { status: 404 });
    })).rejects.toThrow("Wise API 404");
    // Settled, as a failure that is not the key's own (only invalid or unparseable model answers are).
    expect(ledger.attempts("k")).toEqual({ total: 1, failed: 0, succeeded: 0, other: 1 });
  });
});

describe("collectRawEvidence", () => {
  it("reads Wise once, the production transcript read-only and Zoom's captions, then works from the cache", async () => {
    const { deps, wise, production, fetchText, sources } = setup();
    const raw = await collectRawEvidence(deps, target());
    expect(wise.getSessionDetail).toHaveBeenCalledWith(CID, SID);
    expect(production.get).toHaveBeenCalledWith("prod-job");
    expect(production.transcript).toHaveBeenCalledWith("prod-job");
    expect(fetchText).toHaveBeenCalledWith("https://files.example.invalid/captions.vtt");
    expect(raw.status).toMatchObject({ detail: "fetched", soniox: "fetched", zoom: "fetched", iseb: "not_guided", rowMeta: "read", retranscribe: "not_needed" });
    expect(raw.transcript).toMatchObject({ source: "production", jobId: "prod-job", audioDurationMs: 3_600_000 });
    const cache = path.join(dir, "cache", SID);
    for (const name of ["detail.json", "transcript.json", "zoom.vtt", "row-meta.json", "status.json"]) {
      expect(fs.statSync(path.join(cache, name)).mode & 0o777).toBe(0o600);
    }
    expect(fs.statSync(cache).mode & 0o777).toBe(0o700);

    const again = await collectRawEvidence(deps, target());
    expect(wise.getSessionDetail).toHaveBeenCalledTimes(1);
    expect(production.get).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(sources.rowMeta).toHaveBeenCalledTimes(1);
    expect(again.status).toMatchObject({ detail: "cached", soniox: "cached", zoom: "cached", rowMeta: "cached" });
    expect(readCachedEvidence(path.join(dir, "cache"), SID)?.transcript?.jobId).toBe("prod-job");
  });

  it("uses the retained ISEB record for a guided post and never asks Soniox", async () => {
    const { deps, production, sources } = setup();
    sources.isebRecord.mockResolvedValueOnce({ evidenceHash: "h1", lessonRecord: "[00:00] TUTOR: We practised analogies.", evidenceKind: "transcript" } as never);
    const raw = await collectRawEvidence(deps, target({ guided: true, pipeline: { evidence: "transcript", lessonEvidenceHash: "h1" } }));
    expect(sources.isebRecord).toHaveBeenCalledWith(SID, "h1");
    expect(raw.iseb?.evidenceKind).toBe("transcript");
    expect(production.get).not.toHaveBeenCalled();
    expect(raw.status.soniox).toBe("not_needed");
  });

  it("remembers a deleted production job and re-transcribes only with --retranscribe, deleting our own job", async () => {
    const missing = vi.fn(async () => {
      throw new SonioxError("HTTP 404: gone", 404);
    });
    const { deps, production, ledger } = setup({ sonioxGet: missing });
    const raw = await collectRawEvidence(deps, target());
    expect(raw.status.soniox).toBe("missing");
    expect(raw.status.retranscribe).toBe("not_requested");
    expect(raw.transcript).toBeNull();

    const ours: SonioxClient = {
      create: vi.fn(async () => ({ id: "our-job" })),
      get: vi.fn(async () => ({ status: "completed" as const, audioDurationMs: 3_600_000, errorMessage: null })),
      transcript: vi.fn(async () => TRANSCRIPT),
      remove: vi.fn(async () => "deleted" as const),
      list: vi.fn(),
    };
    const inFlight = new Set<string>();
    const retried = await collectRawEvidence({ ...deps, retranscribe: { client: ours, ledger, sleep, pollMs: 10, inFlight } }, target());
    // The production job was not asked again (remembered as deleted).
    expect(production.get).toHaveBeenCalledTimes(1);
    expect(ours.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ours.create).mock.calls[0][0]).toMatchObject({ audioUrl: "https://files.example.invalid/recording.mp4", clientReferenceId: SID });
    expect(ours.remove).toHaveBeenCalledWith("our-job");
    expect(vi.mocked(ours.remove).mock.calls.flat()).not.toContain("prod-job");
    expect(vi.mocked(ours.get).mock.calls.flat()).not.toContain("prod-job");
    expect(inFlight.size).toBe(0);
    expect(retried.status.retranscribe).toBe("done");
    expect(retried.transcript).toMatchObject({ source: "retranscribed", jobId: "our-job" });
    // Reserved before the job was created, settled at the audio's list price ($0.10 an hour).
    expect(ledger.used("soniox")).toEqual({ count: 1, usd: 0.1 });
  });

  it("deletes our job even when Soniox fails it, and keeps the cap", async () => {
    const { deps, ledger } = setup({ sonioxGet: vi.fn(async () => {
      throw new SonioxError("HTTP 404: gone", 404);
    }) });
    const failing: SonioxClient = {
      create: vi.fn(async () => ({ id: "our-job" })),
      get: vi.fn(async () => ({ status: "error" as const, audioDurationMs: null, errorMessage: "bad audio" })),
      transcript: vi.fn(),
      remove: vi.fn(async () => "deleted" as const),
      list: vi.fn(),
    };
    const raw = await collectRawEvidence({ ...deps, retranscribe: { client: failing, ledger, sleep, pollMs: 10 } }, target());
    expect(raw.status.retranscribe).toBe("failed:soniox_error:bad audio");
    expect(failing.remove).toHaveBeenCalledWith("our-job");
    const capped = NightlyLedger.open(path.join(dir, "capped"), "2026-10-02", { ...NIGHTLY_CAPS, maxSonioxUsdNight: 0.05 }, { now });
    const refused = await collectRawEvidence({ ...deps, cacheDir: path.join(dir, "cache2"), retranscribe: { client: failing, ledger: capped, sleep } }, target());
    expect(refused.status.retranscribe).toBe("refused:cap:soniox_usd_night");
    expect(failing.create).toHaveBeenCalledTimes(1);
  });

  it("propagates a Wise 429 as a stage stop, with the class's status saved", async () => {
    const { deps, wise } = setup();
    wise.getSessionDetail.mockRejectedValueOnce(Object.assign(new Error("429"), { status: 429 }));
    await expect(collectRawEvidence(deps, target())).rejects.toBeInstanceOf(NightlyStop);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "cache", SID, "status.json"), "utf8"))).toMatchObject({ detail: "not_attempted" });
  });

  it("goes on without the detail when Wise answers with an error", async () => {
    const { deps, wise } = setup();
    wise.getSessionDetail.mockRejectedValueOnce(Object.assign(new Error("Wise API 500"), { status: 500 }));
    const raw = await collectRawEvidence(deps, target());
    expect(raw.status).toMatchObject({ detail: "failed", zoom: "not_attempted", soniox: "fetched" });
    expect(raw.detail).toBeNull();
  });
});

describe("buildEvidenceBundle", () => {
  async function collected(rowMeta: Partial<RowMeta> = {}, patch: Partial<NightlyTarget> = {}): Promise<RawEvidence> {
    const { deps } = setup({ rowMeta });
    return collectRawEvidence(deps, target(patch));
  }

  it("rebuilds the production transcript with Zoom's names only when production aligned with them", async () => {
    const aligned = buildEvidenceBundle({ target: target(), night: "2026-10-02", raw: await collected({ speakerMethod: "zoom_alignment" }) });
    expect(aligned.grade).toBe("rebuilt");
    expect(aligned.transcript).toMatchObject({ source: "production_soniox", speakerMethod: "zoom_alignment", speakerLabels: "verified" });
    expect(aligned.transcript?.text).toContain("] TUTOR: Today we add fractions");
    expect(aligned.transcript?.text).toContain("] STUDENT: I think it is twelve.");

    fs.rmSync(path.join(dir, "cache"), { recursive: true, force: true });
    const byShare = buildEvidenceBundle({ target: target(), night: "2026-10-02", raw: await collected({ speakerMethod: "talk_share" }) });
    expect(byShare.transcript).toMatchObject({ speakerMethod: "talk_share", speakerLabels: "inferred" });
  });

  it("carries the people, class details, Wise's current text and the captions", async () => {
    const raw = await collected({ joinedAsGuest: "Pim iPad" });
    const bundle = buildEvidenceBundle({ target: target(), night: "2026-10-02", raw });
    expect(bundle).toMatchObject({
      wiseSessionId: SID,
      night: "2026-10-02",
      studentFullName: STUDENT,
      studentDisplayName: "Pim",
      studentAliases: ["Pim iPad"],
      classDetails: ["Programme: Y5-6", "Class subject: Maths"],
      postedFields: POSTED,
      wiseCurrentFields: POSTED,
      wiseTextMatchesPost: true,
      wiseSummary: "Overview: The class added fractions with unlike denominators.",
      postedEvidenceKind: "transcript",
      scheduledMinutes: 60,
      storedJudge: { faithful: true },
    });
    expect(bundle.tutorNames).toEqual(expect.arrayContaining(["Kevin Hsieh", "Kev", TEACHER]));
    expect(bundle.zoomCaptions).toBe([
      `[00:00] ${TEACHER}: Today we add fractions with unlike denominators.`,
      `[00:10] ${STUDENT}: I think it is twelve.`,
      `[00:15] ${TEACHER}: Good, twelve works.`,
      `[00:30] ${STUDENT}: Five over six.`,
    ].join("\n"));
    expect(bundle.hash).toBe(bundleHash(bundle));
    // The night is not part of the hash: the same evidence hashes the same on another night.
    expect(bundleHash({ ...bundle, night: "2026-10-03" })).toBe(bundle.hash);
  });

  it("notices when Wise's text is no longer the posted one", async () => {
    const { deps } = setup({ detailPatch: { feedbackSubmissions: [autoBlankSubmission({
      answers: answers([POSTED.topics, "Edited by a person.", POSTED.improvement, POSTED.homework]), metadata: {},
    })] } });
    const bundle = buildEvidenceBundle({ target: target(), night: "2026-10-02", raw: await collectRawEvidence(deps, target()) });
    expect(bundle.wiseTextMatchesPost).toBe(false);
    expect(bundle.wiseCurrentFields?.performance).toBe("Edited by a person.");
  });

  it("grades the evidence", () => {
    const base: RawEvidence = {
      wiseSessionId: SID, detail: { data: detail() }, iseb: null, transcript: null, zoomVtt: null,
      rowMeta: { speakerMethod: null, judge: null, joinedAsGuest: null },
      status: { collectedAt: "", rowMeta: "read", iseb: "not_guided", detail: "fetched", soniox: "missing", zoom: "none", retranscribe: "not_requested" },
      notes: [],
    };
    const grade = (raw: Partial<RawEvidence>, patch: Partial<NightlyTarget> = {}) =>
      buildEvidenceBundle({ target: target(patch), night: "2026-10-02", raw: { ...base, ...raw } }).grade;
    expect(grade({}, { evidence: "summary" })).toBe("exact");
    expect(grade({ iseb: { evidenceHash: "h", lessonRecord: "[00:00] TUTOR: x", evidenceKind: "transcript" } })).toBe("exact");
    expect(grade({ transcript: { source: "production", jobId: "j", audioDurationMs: 3_600_000, text: TRANSCRIPT.text, tokens: TOKENS, fetchedAt: "" } })).toBe("rebuilt");
    expect(grade({ transcript: { source: "retranscribed", jobId: "j", audioDurationMs: 3_600_000, text: TRANSCRIPT.text, tokens: TOKENS, fetchedAt: "" } })).toBe("retranscribed");
    expect(grade({})).toBe("secondary_only");
    expect(grade({ detail: null })).toBe("none");
    const summaryIseb = buildEvidenceBundle({
      target: target({ evidence: "summary" }), night: "2026-10-02",
      raw: { ...base, iseb: { evidenceHash: "h", lessonRecord: "Overview: the summary the writer saw.", evidenceKind: "summary" } },
    });
    expect(summaryIseb.wiseSummary).toBe("Overview: the summary the writer saw.");
  });

  it("notes a rebuild that does not match the post's own record", async () => {
    const raw = await collected({ speakerMethod: "talk_share" });
    const bundle = buildEvidenceBundle({ target: target(), night: "2026-10-02", raw: { ...raw, rowMeta: { ...raw.rowMeta, speakerMethod: "unclear" } } });
    expect(evidenceNotes({ ...raw, rowMeta: { ...raw.rowMeta, speakerMethod: "unclear" } }, bundle)).toContain("rebuilt_speaker_method_differs:unclear->talk_share");
  });
});

describe("renderZoomCaptions", () => {
  it("keeps the start and the end of long captions", () => {
    const long = ["WEBVTT", ""];
    for (let index = 0; index < 400; index += 1) {
      long.push(String(index + 1), `00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000 --> 00:00:59.000`, `Speaker: line ${index} ${"x".repeat(40)}`, "");
    }
    const text = renderZoomCaptions(long.join("\n"), 2_000);
    expect(text.length).toBeLessThanOrEqual(2_100);
    expect(text).toContain("line 0 ");
    expect(text).toContain("line 399 ");
    expect(text).toContain("[… middle of the captions omitted …]");
  });
});

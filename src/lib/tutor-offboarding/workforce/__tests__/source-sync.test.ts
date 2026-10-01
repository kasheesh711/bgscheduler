import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SourceWindowResult, StudentCreditEvidence, WorkforceSession } from "../types";
import { syncWorkforceHistory } from "../source-sync";
import { WorkforceSourceFetchError } from "../wise-source";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
function setup() { const directory = mkdtempSync(path.join(tmpdir(), "workforce-sync-")); directories.push(directory); return path.join(directory, "checkpoint.json"); }
function session(students: string[] | null = ["historical-student"]): WorkforceSession {
  return { wiseSessionId: "session-1", wiseClassId: "class-1", classTitle: "Physics", startAt: "2026-03-02T03:00:00.000Z", endAt: "2026-03-02T04:00:00.000Z", scheduledMinutes: 60, canonicalTutorKeys: [], wiseTeacherIds: ["wise-tutor"], wiseUserIds: ["wise-user"], historicalBookedStudentIds: students, participantCompleteness: students ? "partial" : "unknown", completeness: "complete", meetingStatus: "ENDED", attendanceStatus: null, modality: null, subject: null, curriculum: null, level: null, reasonCodes: [] };
}
function credit(netCredits: number | null, status: StudentCreditEvidence["evidenceStatus"]): StudentCreditEvidence {
  return { wiseSessionId: "session-1", wiseStudentId: "historical-student", netCredits, normalCredits: null, evidenceStatus: status, sourceInterpretation: netCredits === null ? "unverified_historical_normal_charge" : "verified_session_charge", observedAt: "2026-04-01T00:00:00.000Z", issueCodes: netCredits === null ? ["NORMAL_CHARGE_UNKNOWN"] : [] };
}
function result(input: { from: string; to: string; complete?: boolean; net?: number | null }): SourceWindowResult {
  const sessionFact = session();
  const complete = input.complete ?? true;
  return {
    sourceKey: "wise_sessions_past", observedAt: "2026-04-01T00:00:00.000Z",
    evidence: { people: [], observations: [], tutorFacts: [], sessions: [sessionFact], historicalBookedParticipants: [{ wiseSessionId: "session-1", studentIds: ["historical-student"], completeness: "partial", source: "wise_sessions_past", reasonCodes: ["HISTORICAL_PARTICIPANTS_RECONSTRUCTED_FROM_RETURNED_SESSION"] }], studentCredits: input.net === undefined ? [] : [credit(input.net, input.net === null ? "unknown" : "verified")], subjectMappings: [], terminationMarks: [], sourceCoverage: [] },
    requestedWindow: { from: input.from, to: input.to }, returnedWindow: { from: input.from, to: input.to },
    paging: { requests: 2, pagesRequested: 2, pagesReturned: 2, recordsReturned: 1 }, truncated: !complete,
    completeness: complete ? "complete" : "partial", complete,
    sessions: [sessionFact], credits: input.net === undefined ? [] : [credit(input.net, input.net === null ? "unknown" : "verified")],
    contractIssues: complete ? [] : ["REQUEST_CAP_EXHAUSTED"],
  };
}
const request = (checkpoint: string) => ({ from: "2026-03-01", to: "2026-04-30", maxRequests: 20, maxPages: 10, checkpointPath: checkpoint, mode: "apply" as const });

describe("bounded workforce history sync", () => {
  it("advances through March when the following window fails", async () => {
    const checkpointPath = setup();
    const persisted: SourceWindowResult[] = [];
    const fetchWindow = vi.fn(async (input: { from: string; to: string }) => {
      if (input.from === "2026-04-01") throw new Error("fixture failure");
      return result(input);
    });
    const outcome = await syncWorkforceHistory(request(checkpointPath), { fetchWindow, persistWindow: async (row) => { persisted.push(row); } });
    expect(outcome.completeThrough).toBe("2026-03-31");
    expect(outcome.windows.map((row) => row.status)).toEqual(["complete", "failed"]);
    expect(persisted.map((row) => row.requestedWindow.from)).toEqual(["2026-03-01"]);
  });

  it("stops after a thrown partial-page fetch before granting another window a fresh budget", async () => {
    const fetchWindow = vi.fn(async () => { throw new WorkforceSourceFetchError(new Error("second page failed after consuming requests"), 2, 1); });
    const outcome = await syncWorkforceHistory(request(setup()), { fetchWindow });
    expect(fetchWindow).toHaveBeenCalledTimes(1);
    expect(outcome.windows).toHaveLength(1);
    expect(outcome.windows[0]).toMatchObject({ status: "failed", reasonCodes: ["SOURCE_FETCH_FAILED"] });
    expect(outcome.completeThrough).toBeNull();
    expect(outcome).toMatchObject({ requests: 2, pages: 1 });
    expect(outcome.windows[0]).toMatchObject({ requests: 2, pages: 1 });
  });

  it("safely resumes after the last complete stored window", async () => {
    const checkpointPath = setup();
    const persistWindow = vi.fn(async () => {});
    await syncWorkforceHistory(request(checkpointPath), { fetchWindow: vi.fn(async (input) => result({ ...input, complete: input.from === "2026-03-01" })), persistWindow });
    const fetchWindow = vi.fn(async (input) => result(input));
    const resumed = await syncWorkforceHistory(request(checkpointPath), { fetchWindow, persistWindow });
    expect(fetchWindow.mock.calls.map(([arg]) => arg.from)).toEqual(["2026-04-01"]);
    expect(resumed.completeThrough).toBe("2026-04-30");
  });

  it("prioritizes all demand months with sessions-only and revisits skipped credits explicitly", async () => {
    const checkpointPath = setup();
    const fetchWindow = vi.fn(async (input) => result(input));
    const persistWindow = vi.fn(async () => {});
    const sessionsOnly = await syncWorkforceHistory({ ...request(checkpointPath), sessionsOnly: true }, { fetchWindow, persistWindow });
    expect(fetchWindow.mock.calls.every(([arg]) => arg.creditExamples?.length === 0)).toBe(true);
    expect(sessionsOnly).toMatchObject({ complete: true, creditsComplete: false });
    expect(sessionsOnly.windows.map(window => window.creditCapture)).toEqual(["skipped", "skipped"]);
    fetchWindow.mockClear();
    const refreshed = await syncWorkforceHistory({ ...request(checkpointPath), refreshCredits: true }, { fetchWindow: vi.fn(async input => { fetchWindow(input); return result({ ...input, net: 1 }); }), persistWindow });
    expect(fetchWindow.mock.calls.map(([arg]) => arg.from)).toEqual(["2026-03-01", "2026-04-01"]);
    expect(refreshed).toMatchObject({ complete: true, creditsComplete: true });
    expect(refreshed.windows.map(window => window.creditCapture)).toEqual(["complete", "complete"]);
  });

  it("keeps already captured demand coverage when the later financial pass fails", async () => {
    const checkpointPath = setup();
    const persistWindow = vi.fn(async () => {});
    await syncWorkforceHistory({ ...request(checkpointPath), sessionsOnly: true }, { fetchWindow: async input => result(input), persistWindow });
    const refresh = await syncWorkforceHistory({ ...request(checkpointPath), refreshCredits: true }, { fetchWindow: async () => { throw new WorkforceSourceFetchError(new Error("fixture failure"), 2, 1); }, persistWindow });
    expect(refresh).toMatchObject({ complete: true, completeThrough: "2026-04-30", creditsComplete: false, requests: 2 });
    expect(refresh.windows.map(window => window.status)).toEqual(["complete", "complete"]);
    expect(refresh.windows[0].creditCapture).toBe("partial");
  });

  it("retains corrected/refunded credit versions and separates historical participants from current roster", async () => {
    const checkpointPath = setup();
    const stored: SourceWindowResult[] = [];
    let current = result({ from: "2026-03-01", to: "2026-03-31", net: 1 });
    await syncWorkforceHistory({ ...request(checkpointPath), from: "2026-03-01", to: "2026-03-31" }, { fetchWindow: async () => current, persistWindow: async (row) => { stored.push(row); } });
    current = result({ from: "2026-03-01", to: "2026-03-31", net: 0 });
    await syncWorkforceHistory({ ...request(setup()), from: "2026-03-01", to: "2026-03-31", mode: "apply" }, { fetchWindow: async () => current, persistWindow: async (row) => { stored.push(row); } });
    expect(stored[1].credits[0].netCredits).toBe(0);
    expect(stored[0].credits[0].netCredits).toBe(1);
    expect(current.credits[0].netCredits).toBe(0);
    expect(current.sessions[0].historicalBookedStudentIds).toEqual(["historical-student"]);
    expect(current.evidence.sessions[0].historicalBookedStudentIds).not.toContain("today-only-student");
  });

  it("distinguishes confirmed zero credit from missing credit evidence", async () => {
    const resultZero = result({ from: "2026-03-01", to: "2026-03-31", net: 0 });
    const resultMissing = result({ from: "2026-03-01", to: "2026-03-31", net: null });
    const run = (row: SourceWindowResult) => syncWorkforceHistory({ ...request(setup()), from: "2026-03-01", to: "2026-03-31", mode: "dry_run" }, { fetchWindow: async () => row });
    expect(await run(resultZero)).toMatchObject({ creditEvidence: 1, knownNetCredits: 1, unknownNetCredits: 0 });
    expect(await run(resultMissing)).toMatchObject({ creditEvidence: 1, knownNetCredits: 0, unknownNetCredits: 1 });
  });
});

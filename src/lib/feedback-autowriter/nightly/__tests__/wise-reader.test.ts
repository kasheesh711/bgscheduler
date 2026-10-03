import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT, NightlyStop, exitCodeForStop } from "../exit";
import { createNightlyWiseReader } from "../wise-reader";

const ENV = { WISE_USER_ID: "user", WISE_API_KEY: "key", WISE_NAMESPACE: "begifted-education" };
const SID = "6a0000000000000000000a01";
const CID = "6a00000000000000000000c1";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("nightly Wise reader", () => {
  it("exposes only the two session-detail GETs", () => {
    const reader = createNightlyWiseReader(ENV);
    expect(Object.keys(reader).sort()).toEqual(["getSessionDetail", "getSessionDetailById"]);
    expect(Object.isFrozen(reader)).toBe(true);
    expect((reader as unknown as Record<string, unknown>).postFeedback).toBeUndefined();
    expect(() => createNightlyWiseReader({})).toThrow(/WISE_USER_ID/u);
  });

  it("sends a GET with the autowriter's detail query, and refuses non-ids", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { _id: SID } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reader = createNightlyWiseReader(ENV);
    await reader.getSessionDetail(CID, SID);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(url).toContain(`/user/classes/${CID}/sessions/${SID}?`);
    expect(url).toContain("showSessionFiles=true");
    expect(url).toContain("showFeedbackSubmission=true");
    await expect(reader.getSessionDetailById("../x")).rejects.toThrow(/object id/u);
  });

  it("does not retry a 429, and refuses every later read once throttled", async () => {
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const reader = createNightlyWiseReader(ENV);
    await expect(reader.getSessionDetailById(SID)).rejects.toMatchObject({ status: 429 });
    await expect(reader.getSessionDetail(CID, SID)).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a server error either", async () => {
    const fetchMock = vi.fn(async () => new Response("oops", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createNightlyWiseReader(ENV).getSessionDetailById(SID)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("exit codes", () => {
  it("maps stop reasons to the CLI's exit codes", () => {
    expect(exitCodeForStop("cap:wise_reads_night")).toBe(EXIT.caps);
    expect(exitCodeForStop("wise_429")).toBe(EXIT.wiseThrottled);
    expect(exitCodeForStop("wise_cooldown")).toBe(EXIT.wiseThrottled);
    expect(exitCodeForStop("usage_limited")).toBe(EXIT.model);
    expect(exitCodeForStop("auth")).toBe(EXIT.model);
    expect(exitCodeForStop("stop_file")).toBe(EXIT.stopped);
    expect(exitCodeForStop("deadline")).toBe(EXIT.stopped);
    expect(exitCodeForStop("breach:claude_usd_night")).toBe(EXIT.safety);
    expect(exitCodeForStop("anything else")).toBe(EXIT.error);
    expect(new NightlyStop("wise_429", EXIT.wiseThrottled)).toMatchObject({ name: "NightlyStop", reason: "wise_429", exitCode: 5 });
    expect(EXIT).toEqual({ ok: 0, error: 1, usage: 2, caps: 3, model: 4, wiseThrottled: 5, guardRefused: 6, stopped: 7, safety: 10 });
  });
});

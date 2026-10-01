import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemovalWiseClient, readRemovalRoster, readRemovalWiseEvidence, removeWiseParticipantOnce } from "../removal-wise";
const reads = vi.hoisted(() => ({ teachers: vi.fn(), sessions: vi.fn() }));
vi.mock("@/lib/wise/fetchers", () => ({ fetchAllTeachers: reads.teachers, fetchAllInstituteSessions: reads.sessions }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WISE_USER_ID", "test-user"); vi.stubEnv("WISE_API_KEY", "test-key"); vi.stubEnv("WISE_INSTITUTE_ID", "test-institute");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("dedicated no-retry removal request", () => {
  it.each([500, 429, 408])("sends exactly once on HTTP %s and stores no raw body", async status => {
    const fetch = vi.fn(async () => new Response("private response containing token", { status })); vi.stubGlobal("fetch", fetch);
    const result = await removeWiseParticipantOnce("wise-user");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(status === 429 ? "rejected" : "unknown");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(fetch.mock.calls[0]).toBeDefined();
  });
  it("marks transport failure unknown without retrying", async () => {
    const fetch = vi.fn(async () => { throw new Error("private token"); }); vi.stubGlobal("fetch", fetch);
    expect((await removeWiseParticipantOnce("wise-user")).status).toBe("unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("requires logical success and redacts payload", async () => {
    const fetch = vi.fn(async () => Response.json({ status: 200, message: "Success", data: "sensitive" })); vi.stubGlobal("fetch", fetch);
    expect(await removeWiseParticipantOnce("wise-user")).toEqual({ status: "sent", errorMessage: null, responsePayload: { status: 200, message: "Success" } });
    fetch.mockImplementation(async () => Response.json({ status: 400, message: "private" }));
    expect((await removeWiseParticipantOnce("wise-user")).status).toBe("unknown");
  });
  it("fails closed on absent credentials", () => {
    vi.stubEnv("WISE_API_KEY", ""); expect(() => createRemovalWiseClient()).toThrow("incomplete");
  });
  it("posts the user ID to the exact endpoint with a cancellation signal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ status: 200, message: "Success" }));
    vi.stubGlobal("fetch", fetch);
    await removeWiseParticipantOnce("user-example");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.wiseapp.live/institutes/test-institute/removeParticipant");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ userId: "user-example" }) });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it("rejects incomplete rosters and requires strict, deadline-bounded session pagination", async () => {
    const roster = [{ _id: "teacher-example", userId: "user-example", name: "Aria", relation: "TEACHER", classes: [] }];
    reads.teachers.mockResolvedValueOnce([]).mockResolvedValueOnce(roster);
    reads.sessions.mockResolvedValueOnce([]);
    await expect(readRemovalRoster()).rejects.toThrow("complete nonempty");
    const before = Date.now();
    expect(await readRemovalWiseEvidence()).toEqual({ roster, sessions: [] });
    expect(reads.sessions).toHaveBeenCalledOnce();
    const args = reads.sessions.mock.calls[0];
    expect(args[1]).toBe("test-institute");
    expect(args[2]).toEqual({ status: "FUTURE" });
    expect(args[3]).toMatchObject({ strict: true });
    expect(args[3].deadlineAt).toBeGreaterThanOrEqual(before + 89_000);
    expect(args[3].deadlineAt).toBeLessThanOrEqual(Date.now() + 90_000);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemovalWiseClient, removeWiseParticipantOnce } from "../removal-wise";
beforeEach(() => {
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
});

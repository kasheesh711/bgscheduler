import { describe, expect, it, vi } from "vitest";
import { SONIOX_MODEL, SonioxError, createSonioxClient, sonioxCostUsd } from "../soniox";

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 500, body: { error: "unexpected" } };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("Soniox client", () => {
  it("creates an async job on the recording URL with Thai/English hints, speakers and our terms", async () => {
    const { impl, calls } = fakeFetch([{ status: 201, body: { id: "job-1", status: "queued" } }]);
    const client = createSonioxClient("key-123", impl);
    expect(await client.create({
      audioUrl: "https://files.wiseapp.live/x.mp4",
      terms: ["ISEB", "NVR"],
      general: [{ key: "domain", value: "tutoring" }],
      clientReferenceId: "6a0000000000000000000002",
    })).toEqual({ id: "job-1" });
    expect(calls[0].url).toBe("https://api.soniox.com/v1/transcriptions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer key-123");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: SONIOX_MODEL,
      audio_url: "https://files.wiseapp.live/x.mp4",
      language_hints: ["th", "en"],
      enable_speaker_diarization: true,
      enable_language_identification: true,
      context: { general: [{ key: "domain", value: "tutoring" }], terms: ["ISEB", "NVR"] },
      client_reference_id: "6a0000000000000000000002",
    });
  });

  it("reads status, the transcript (speaker numbers as strings) and deletes", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: "job-1", status: "completed", audio_duration_ms: 3_600_000 } },
      { status: 200, body: { id: "job-1", text: "Hi there", tokens: [{ text: "Hi", start_ms: 0, end_ms: 300, speaker: 1, language: "en" }, { text: " there", start_ms: 300, speaker: "2" }] } },
      { status: 204 },
    ]);
    const client = createSonioxClient("k", impl);
    expect(await client.get("job-1")).toEqual({ status: "completed", audioDurationMs: 3_600_000, errorMessage: null });
    expect((await client.transcript("job-1")).tokens.map((token) => token.speaker)).toEqual(["1", "2"]);
    expect(await client.remove("job-1")).toBe("deleted");
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`)).toEqual([
      "GET https://api.soniox.com/v1/transcriptions/job-1",
      "GET https://api.soniox.com/v1/transcriptions/job-1/transcript",
      "DELETE https://api.soniox.com/v1/transcriptions/job-1",
    ]);
  });

  it("treats a delete of a missing job as done, and lists jobs for the reaper", async () => {
    const { impl } = fakeFetch([
      { status: 404, body: { error: "not found" } },
      { status: 200, body: { transcriptions: [{ id: "a", status: "completed", created_at: "2026-09-29T08:00:00Z", client_reference_id: "6a0000000000000000000002" }], next_page_cursor: null } },
    ]);
    const client = createSonioxClient("k", impl);
    expect(await client.remove("gone")).toBe("missing");
    expect(await client.list(100)).toEqual([{ id: "a", status: "completed", createdAt: new Date("2026-09-29T08:00:00Z"), clientReferenceId: "6a0000000000000000000002" }]);
  });

  it("turns a timeout while reading a long transcript into a typed error", async () => {
    const slowBody = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); },
    }));
    await expect(createSonioxClient("k", slowBody as unknown as typeof fetch).transcript("job-1"))
      .rejects.toMatchObject({ name: "SonioxError", message: "network_TimeoutError", status: null });
  });

  it("surfaces HTTP errors with their status", async () => {
    const { impl } = fakeFetch([{ status: 404, body: { error: "not found" } }]);
    await expect(createSonioxClient("k", impl).get("gone")).rejects.toMatchObject({ name: "SonioxError", status: 404 });
    expect(new SonioxError("x", 402).status).toBe(402);
  });

  it("prices async audio at list price", () => {
    expect(sonioxCostUsd(3_600_000)).toBeCloseTo(0.1);
    expect(sonioxCostUsd(0)).toBe(0);
  });
});

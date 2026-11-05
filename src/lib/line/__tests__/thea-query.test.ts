import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/feedback-autowriter/openrouter", () => ({ callOpenRouter: vi.fn() }));
import { callOpenRouter } from "@/lib/feedback-autowriter/openrouter";
import { mentionedTheaText, parseTheaQuery, validateTheaQuery, type TheaQuery, type ReadyTheaQuery } from "../thea-query";
import { answerTheaQuery, buildTheaIndex, checkedTheaAvailability, searchTheaAvailability, type TheaRoster, type TheaWiseReader } from "../thea-query-data";
import type { WiseAvailabilityResponse } from "@/lib/wise/types";

const options = { subjects: ["Math"], curriculums: ["International"], levels: ["Y2-8"] };
const query: TheaQuery = { intent: "availability", language: "en", date: "2026-11-07", start: "09:00", end: "10:00",
  teacher: null, subject: "Math", curriculum: null, level: null, mode: "either", question: null };
const ready = { ...query, filters: { subject: "Math" } } as ReadyTheaQuery;
afterEach(() => vi.unstubAllEnvs());

describe("Thea query boundaries", () => {
  it("uses only the requested model with bounded non-reasoning structured output and provider prices", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.mocked(callOpenRouter).mockResolvedValue({ ok: true, content: JSON.stringify(query), model: null, provider: null,
      generationId: null, finishReason: "stop", usage: { promptTokens: 20, completionTokens: 30, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.0001 }, latencyMs: 1 });
    expect((await parseTheaQuery("Math on 7 November 9-10", options, null)).query).toEqual(query);
    expect(callOpenRouter).toHaveBeenLastCalledWith(expect.objectContaining({ model: "deepseek/deepseek-v4.1-flash-1017", effort: "none", maxTokens: 512,
      provider: expect.objectContaining({ max_price: { prompt: 0.3, completion: 1.2, request: 0 }, require_parameters: true }) }));
  });
  it("requires the real bot mention and removes only its signed UTF-16 range", () => {
    const text = "🙂 @Thea (BOT) Math tomorrow";
    const message = { type: "text", text, mention: { mentionees: [{ type: "user", isSelf: true, index: 3, length: 11 }] } };
    expect(mentionedTheaText({ type: "message", message })).toBe("🙂  Math tomorrow");
    expect(mentionedTheaText({ type: "message", message: { ...message, mention: undefined } })).toBeNull();
    expect(mentionedTheaText({ type: "message", message: { ...message, mention: { mentionees: [null] } } })).toBeNull();
    expect(mentionedTheaText({ type: "message", message: { ...message, mention: { mentionees: [{ type: "user", isSelf: false }] } } })).toBeNull();
    expect(mentionedTheaText({ type: "message", message: { ...message, mention: { mentionees: [{ type: "user", isSelf: true, index: -1, length: 2 }] } } })).toBeNull();
  });
  it("asks for missing/invalid dates and times, and does not drop unsupported qualification filters", () => {
    const now = new Date("2026-11-05T01:00:00Z");
    expect(validateTheaQuery({ ...query, intent: "clarify", question: "Invented availability" }, options, now)).not.toContain("Invented");
    expect(validateTheaQuery({ ...query, date: null }, options, now)).toMatch(/Which date/);
    expect(validateTheaQuery({ ...query, date: "2026-11-31" }, options, now)).toMatch(/choose a date/);
    expect(validateTheaQuery({ ...query, date: "2026-11-05", start: "07:00", end: "08:00" }, options, now)).toMatch(/already passed/);
    expect(validateTheaQuery({ ...query, start: "25:00" }, options, now)).toMatch(/start and end/);
    expect(validateTheaQuery({ ...query, subject: "Astronomy" }, options, now)).toMatch(/not an active/);
    expect(validateTheaQuery(query, options, now)).toMatchObject({ date: "2026-11-07", filters: { subject: "Math" } });
  });
  it("rejects missing leave coverage and malformed working-hour windows", () => {
    expect(() => checkedTheaAvailability({ workingHours: { slots: [] } })).toThrow(/incomplete/);
    expect(() => checkedTheaAvailability({ workingHours: { slots: [{ day: 6, startTime: "bad", endTime: "10:00" }] }, leaves: [] })).toThrow(/incomplete/);
    expect(checkedTheaAvailability({ workingHours: { slots: [] }, leaves: [] })).toEqual({ workingHours: { slots: [] }, leaves: [] });
  });
});

function fixture() {
  const groups = ["Free", "Busy", "Leave", "Unqualified", "Ambiguous"].map(name => ({ canonicalKey: name, displayName: name,
    members: [{ wiseTeacherId: `${name}-off`, wiseUserId: `${name}-off-user`, wiseDisplayName: `${name} (${name})`, isOnlineVariant: false },
      { wiseTeacherId: `${name}-on`, wiseUserId: `${name}-on-user`, wiseDisplayName: `${name} (${name}) Online`, isOnlineVariant: true }] }));
  const qualifications: TheaRoster["qualifications"] = new Map(groups.flatMap(g => g.members.map(m => [m.wiseTeacherId, {
    qualifications: [{ subject: g.displayName === "Unqualified" ? "Science" : "Math", curriculum: "International", level: "Y2-8", sourceTag: "test" }], issues: [],
  }] as [string, TheaRoster["qualifications"] extends Map<string, infer Q> ? Q : never])));
  const availability = new Map<string, WiseAvailabilityResponse>(groups.flatMap(g => g.members.map(m => [m.wiseUserId!, {
    workingHours: { slots: [{ day: 6, startTime: "00:00", endTime: "24:00" }] },
    leaves: g.displayName === "Leave" ? [{ startTime: "2026-11-07T02:00:00Z", endTime: "2026-11-07T03:00:00Z" }] : [],
  }] as [string, WiseAvailabilityResponse])));
  const roster: TheaRoster = { groups, qualifications, options, issues: [], blocked: new Set(["Ambiguous"]) };
  qualifications.get("Free-off")!.issues.push({ type: "tag", entityType: "teacher", entityId: "Free-off", entityName: "Free", message: 'Unmapped Wise tag: "Tier 1"' });
  return { roster, availability };
}

describe("Thea deterministic availability", () => {
  it("keeps a teacher with missing hours unconfirmed while answering from verified teachers", async () => {
    const { roster, availability } = fixture();
    const reader = { checks: [new Date()], invalidatedAt: async () => new Date(0),
      read: async (_key: string, _ttl: number, load: () => Promise<unknown>) => ({ data: await load(), checkedAt: new Date() }),
      client: { get: async (path: string) => path.endsWith("/sessions") ? { data: { page_count: 0, sessions: [] } }
        : { data: path.includes("Free-off-user") ? { leaves: [] } : availability.get(path.split("/").at(-2)!) } },
    } as unknown as TheaWiseReader;
    const answer = await answerTheaQuery(reader, roster, ready);
    expect(answer.split("Not confirmed")[0]).not.toContain("Free (Math");
    expect(answer.split("Not confirmed")[0]).toContain("Busy (Math");
    expect(answer.split("Not confirmed")[1]).toContain("Free");
  });
  it("reads overnight lessons from the preceding day before claiming a teacher is free", async () => {
    const { roster, availability } = fixture();
    const reader = {
      checks: [new Date()], invalidatedAt: async () => new Date(0),
      read: async (_key: string, _ttl: number, load: () => Promise<unknown>) => ({ data: await load(), checkedAt: new Date() }),
      client: { get: async (path: string, params: Record<string, string>) => path.endsWith("/sessions")
        ? { data: { page_count: 1, sessions: params.startDate === "2026-11-06" ? [{ _id: "overnight", userId: "Busy-off-user",
          scheduledStartTime: "2026-11-06T16:30:00Z", scheduledEndTime: "2026-11-06T18:30:00Z", meetingStatus: "FUTURE" }] : [] } }
        : { data: availability.get(path.split("/").at(-2)!) } },
    } as unknown as TheaWiseReader;
    const answer = await answerTheaQuery(reader, roster, { ...ready, start: "00:00", end: "01:00" });
    expect(answer).toContain("Free (Math");
    expect(answer).not.toContain("Busy (Math");
  });
  it("excludes conflicts, leave, other subjects and ambiguous identities while freeing cancellations", () => {
    const { roster, availability } = fixture();
    const sessions = [
      { _id: "busy", userId: "Busy-off-user", scheduledStartTime: "2026-11-07T02:00:00Z", scheduledEndTime: "2026-11-07T03:00:00Z", meetingStatus: "FUTURE" },
      { _id: "cancelled", userId: "Free-off-user", scheduledStartTime: "2026-11-07T02:00:00Z", scheduledEndTime: "2026-11-07T03:00:00Z", meetingStatus: "CANCELLED" },
    ];
    const result = searchTheaAvailability(buildTheaIndex(roster, ready, sessions, availability, new Date()), ready);
    expect(result.available.map(t => t.displayName)).toEqual(["Free"]);
    expect(result.needsReview.map(t => t.displayName)).toEqual(["Ambiguous"]);
  });
  it("compares absolute Bangkok instants across midnight, without host-timezone assumptions", () => {
    const { roster, availability } = fixture();
    const night = { ...ready, start: "00:00", end: "01:00" };
    availability.get("Leave-off-user")!.leaves = [{ startTime: "2026-11-06T17:00:00Z", endTime: "2026-11-06T18:00:00Z" }];
    const index = buildTheaIndex(roster, night, [{ _id: "night", userId: "Busy-off-user", scheduledStartTime: "2026-11-06T17:30:00Z",
      scheduledEndTime: "2026-11-06T18:30:00Z", meetingStatus: "UNKNOWN" }], availability, new Date());
    expect(searchTheaAvailability(index, night).available.map(t => t.displayName)).toEqual(["Free"]);
  });
});

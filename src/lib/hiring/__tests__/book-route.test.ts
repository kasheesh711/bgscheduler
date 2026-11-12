import { beforeEach, describe, expect, it, vi } from "vitest";
import { after } from "next/server";
import { bookingToken } from "../tokens";

vi.mock("next/server", async (actual) => ({
  ...(await actual<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("@/lib/hiring/worker", () => ({ deliverBookingMessages: vi.fn() }));
vi.mock("@/lib/hiring/access", () => ({ requireHiringAdmin: vi.fn(async () => "staff@example.com") }));
vi.mock("@/lib/hiring/google", () => ({ googleConnectionStatus: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

vi.mock("@/lib/hiring/service", () => ({
  bookingView: vi.fn(async () => ({ kind: "paper" })),
  bookInterview: vi.fn(async () => booking),
  visitView: vi.fn(async () => ({ kind: "visit" })),
  bookVisit: vi.fn(async () => booking),
  callView: vi.fn(async () => ({ kind: "call" })),
  bookCall: vi.fn(async () => booking),
  reviewCandidate: vi.fn(),
  saveSettings: vi.fn(),
  candidateById: vi.fn(),
  dashboard: vi.fn(),
}));
const booking = {
  id: "b",
  kind: "paper",
  subjects: ["Mathematics"],
  startTime: new Date("2026-11-02T03:00:00Z"),
  endTime: new Date("2026-11-02T05:00:00Z"),
};
import { bookCall, bookingView, bookInterview, bookVisit, callView, reviewCandidate, visitView } from "@/lib/hiring/service";
import { deliverBookingMessages } from "@/lib/hiring/worker";
import { GET, POST } from "@/app/api/hiring/book/[token]/route";
import { POST as hiringPost } from "@/app/api/hiring/route";
import { configSchema } from "@/lib/hiring/model";

const id = "00000000-0000-4000-8000-000000000001";
const later = new Date(Date.now() + 86400000);
const url = "https://app.example.com/api/hiring/book/t";
const context = (token: string) => ({ params: Promise.resolve({ token }) });
const post = (origin = "https://app.example.com") =>
  new Request(url, { method: "POST", headers: { origin }, body: JSON.stringify({ start: "x" }) });

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.clearAllMocks();
});

describe("delivery after the response", () => {
  it("runs after a booking, and not after a refused one", async () => {
    const token = bookingToken(id, "visit", later);
    expect((await POST(post(), context(token))).status).toBe(200);
    expect(after).toHaveBeenCalledTimes(1);
    await (vi.mocked(after).mock.calls[0][0] as () => unknown)();
    expect(deliverBookingMessages).toHaveBeenCalledTimes(1);
    vi.mocked(bookVisit).mockRejectedValueOnce(new Error("no"));
    expect((await POST(post(), context(token))).status).toBe(503);
    expect(after).toHaveBeenCalledTimes(1);
  });
  it("runs after a staff action, and not after a settings save", async () => {
    const send = (body: unknown) =>
      hiringPost(
        new Request("https://app.example.com/api/hiring", {
          method: "POST",
          headers: { origin: "https://app.example.com" },
          body: JSON.stringify(body),
        }),
      );
    const review = { action: "cancel_visit", id, revision: 1, subjects: [], reason: "Candidate asked" };
    expect((await send(review)).status).toBe(200);
    expect(reviewCandidate).toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
    expect((await send({ action: "settings", revision: 1, config: configSchema.parse({}) })).status).toBe(200);
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("/api/hiring/book/[token]", () => {
  it("sends a visit link to the visit functions", async () => {
    const token = bookingToken(id, "visit", later);
    expect(await (await GET(new Request(url), context(token))).json()).toEqual({ kind: "visit" });
    expect(visitView).toHaveBeenCalledWith(token);
    expect(bookingView).not.toHaveBeenCalled();
    const response = await POST(post(), context(token));
    expect(response.status).toBe(200);
    expect(bookVisit).toHaveBeenCalledWith(token, { start: "x" });
    expect(bookInterview).not.toHaveBeenCalled();
  });
  it("sends a call link to the call functions", async () => {
    const token = bookingToken(id, "call", later);
    expect(await (await GET(new Request(url), context(token))).json()).toEqual({ kind: "call" });
    expect(callView).toHaveBeenCalledWith(token);
    const response = await POST(post(), context(token));
    expect(response.status).toBe(200);
    expect(bookCall).toHaveBeenCalledWith(token, { start: "x" });
    for (const other of [visitView, bookingView, bookVisit, bookInterview]) expect(other).not.toHaveBeenCalled();
  });
  it("keeps an old link on the old functions", async () => {
    const token = bookingToken(id, "mock", later);
    await GET(new Request(`${url}?subject=Physics`), context(token));
    expect(bookingView).toHaveBeenCalledWith(token, ["Physics"]);
    await POST(post(), context(token));
    expect(bookInterview).toHaveBeenCalled();
    expect(visitView).not.toHaveBeenCalled();
    expect(bookVisit).not.toHaveBeenCalled();
  });
  it("answers 404 for a bad link and 403 for another origin", async () => {
    expect((await GET(new Request(url), context("bad"))).status).toBe(404);
    const token = bookingToken(id, "visit", later);
    expect((await POST(post("https://other.example.com"), context(token))).status).toBe(403);
    expect(bookVisit).not.toHaveBeenCalled();
  });
});

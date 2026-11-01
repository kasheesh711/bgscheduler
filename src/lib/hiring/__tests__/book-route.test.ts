import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookingToken } from "../tokens";

vi.mock("@/lib/hiring/service", () => ({
  bookingView: vi.fn(async () => ({ kind: "paper" })),
  bookInterview: vi.fn(async () => booking),
  visitView: vi.fn(async () => ({ kind: "visit" })),
  bookVisit: vi.fn(async () => booking),
}));
const booking = {
  id: "b",
  kind: "paper",
  subjects: ["Mathematics"],
  startTime: new Date("2026-11-02T03:00:00Z"),
  endTime: new Date("2026-11-02T05:00:00Z"),
};
import { bookingView, bookInterview, bookVisit, visitView } from "@/lib/hiring/service";
import { GET, POST } from "@/app/api/hiring/book/[token]/route";

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

import { describe, expect, it, vi } from "vitest";
import { refreshDashboard, revokeDecision } from "../requests";
import { notSetUpFixture } from "./fixtures";

describe("offboarding client requests", () => {
  it("rejects failed refreshes instead of reporting a successful update", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "Could not load" }), { status: 500 }));
    await expect(refreshDashboard(fetcher)).rejects.toThrow("Could not load");
  });

  it("returns the typed unavailable payload so the page can display it", async () => {
    const payload = notSetUpFixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    await expect(refreshDashboard(fetcher)).resolves.toEqual(payload);
  });

  it("rejects an undo denied by the server", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "Not allowed" }), { status: 403 }));
    await expect(revokeDecision("decision-1", fetcher)).rejects.toThrow("Not allowed");
    expect(fetcher).toHaveBeenCalledWith("/api/tutor-offboarding/decisions/decision-1", { method: "DELETE" });
  });

  it("handles non-JSON failures with an actionable fallback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("upstream error", { status: 502 }));
    await expect(revokeDecision("decision-1", fetcher)).rejects.toThrow("The decision could not be undone.");
  });
});

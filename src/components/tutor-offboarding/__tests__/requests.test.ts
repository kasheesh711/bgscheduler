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

import { applyRemoval, getRemovalRun, listRemovalRuns, previewRemoval, reconcileRemovals } from "../requests";
import { removalRunFixture } from "./fixtures";

describe("removal client requests", () => {
  it("previews selected people without calling apply", async () => {
    const run = removalRunFixture("manual");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ run }));
    await expect(previewRemoval(["Aria", "Bodhi"], fetcher)).resolves.toEqual(run);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/tutor-offboarding/removal-runs");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ canonicalKeys: ["Aria", "Bodhi"] });
  });

  it("sends exact reviewed token, reason, explicit confirmation and account count once", async () => {
    const run = removalRunFixture("live");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ run }));
    const input = { previewToken: run.previewToken, confirmed: true as const, reason: "Confirmed departure", accountCount: run.accountCount };
    await applyRemoval(run.id, input, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input);
  });

  it("does not retry a failed apply request", async () => {
    const run = removalRunFixture("live");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Network failed"));
    await expect(applyRemoval(run.id, { previewToken: run.previewToken, confirmed: true, reason: "Confirmed departure", accountCount: run.accountCount }, fetcher)).rejects.toThrow("Network failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reads status and history and reconciles through the readback-only endpoint", async () => {
    const run = removalRunFixture("manual");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ run }))
      .mockResolvedValueOnce(Response.json({ runs: [run] }))
      .mockResolvedValueOnce(Response.json({ result: { checked: 3, settled: 2, restored: 0 } }));
    expect(await getRemovalRun(run.id, fetcher)).toEqual(run);
    expect(await listRemovalRuns(fetcher)).toEqual([run]);
    expect(await reconcileRemovals(fetcher)).toEqual({ checked: 3, settled: 2, restored: 0 });
    expect(fetcher.mock.calls[2]).toEqual(["/api/tutor-offboarding/reconcile", { method: "POST" }]);
  });
});

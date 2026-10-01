import type { RemovalApplyInput, RemovalRunDetail } from "@/lib/tutor-offboarding/removal-types";
import type { OffboardingDashboard } from "@/lib/tutor-offboarding/types";

async function requireOk(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  throw new Error(typeof body?.error === "string" ? body.error : fallback);
}

export async function refreshDashboard(fetcher: typeof fetch = fetch): Promise<OffboardingDashboard> {
  const response = await fetcher("/api/tutor-offboarding", { cache: "no-store" });
  await requireOk(response, "The review list could not refresh.");
  return await response.json() as OffboardingDashboard;
}

export async function revokeDecision(id: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(`/api/tutor-offboarding/decisions/${encodeURIComponent(id)}`, { method: "DELETE" });
  await requireOk(response, "The decision could not be undone.");
}

export async function previewRemoval(canonicalKeys: string[], fetcher: typeof fetch = fetch): Promise<RemovalRunDetail> {
  const response = await fetcher("/api/tutor-offboarding/removal-runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canonicalKeys }) });
  await requireOk(response, "The removal preview could not be created.");
  const body = await response.json() as { run?: RemovalRunDetail };
  if (!body.run) throw new Error("The removal preview was not returned.");
  return body.run;
}

/** OFF-09: one request; a failed transport is read back by run id, never automatically retried. */
export async function applyRemoval(id: string, input: RemovalApplyInput, fetcher: typeof fetch = fetch): Promise<RemovalRunDetail> {
  const response = await fetcher(`/api/tutor-offboarding/removal-runs/${encodeURIComponent(id)}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  await requireOk(response, "The removal request did not finish. Check this run's status.");
  const body = await response.json() as { run?: RemovalRunDetail };
  if (!body.run) throw new Error("The updated run was not returned. Check this run's status.");
  return body.run;
}

export async function getRemovalRun(id: string, fetcher: typeof fetch = fetch): Promise<RemovalRunDetail> {
  const response = await fetcher(`/api/tutor-offboarding/removal-runs/${encodeURIComponent(id)}`, { cache: "no-store" });
  await requireOk(response, "This removal run could not be loaded.");
  const body = await response.json() as { run?: RemovalRunDetail };
  if (!body.run) throw new Error("This removal run is not available.");
  return body.run;
}

export async function listRemovalRuns(fetcher: typeof fetch = fetch): Promise<RemovalRunDetail[]> {
  const response = await fetcher("/api/tutor-offboarding/removal-runs", { cache: "no-store" });
  await requireOk(response, "Removal history could not be loaded.");
  const body = await response.json() as { runs?: RemovalRunDetail[]; reason?: string };
  if (!body.runs) throw new Error(body.reason === "not_set_up" ? "Removal history is not set up yet." : "Removal history is not available.");
  return body.runs;
}

/** Reads the live roster and updates evidence only. It sends no removal request to Wise. */
export async function reconcileRemovals(fetcher: typeof fetch = fetch): Promise<{ checked: number; settled: number; restored: number }> {
  const response = await fetcher("/api/tutor-offboarding/reconcile", { method: "POST" });
  await requireOk(response, "Wise status could not be checked.");
  const body = await response.json() as { result?: { checked: number; settled: number; restored: number } };
  if (!body.result) throw new Error("The status check result was not returned.");
  return body.result;
}

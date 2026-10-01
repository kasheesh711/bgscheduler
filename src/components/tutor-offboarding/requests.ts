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

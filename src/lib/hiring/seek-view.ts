import type { HiringConfig, HiringSourceSummary, Subject } from "./model";

export const NOT_CONFIRMED = "Not confirmed";
export const NO_ANSWER = "No answer on file";
/** The folders the worker imports from. The others only update people it already knows. */
export const IMPORTED_SEEK_FOLDERS = ["Inbox", "Prescreen", "Shortlist"];

export type SeekFilter = {
  query: string;
  universities: string[];
  workRights: string;
  subject: Subject | "";
  score: "" | "pass" | "below" | "none";
  /** A SEEK job ID. Empty means every campaign. */
  campaign: string;
};
export const NO_SEEK_FILTER: SeekFilter = { query: "", universities: [], workRights: "", subject: "", score: "", campaign: "" };

type SeekPerson = {
  name: string;
  email: string | null;
  seekApplicationId: string | null;
  sourceIds: string[];
  subjects: Subject[];
  profileScore: number | null;
  workRightsAnswer: string | null;
  universityAssessment: { name: string | null } | null;
  seekJobId?: string | null;
};

/** A person who exists only in the tracker has no SEEK application, so the intake screen does not show them. */
export const isFromSeek = (c: Pick<SeekPerson, "seekApplicationId" | "sourceIds">) => !!c.seekApplicationId || c.sourceIds.length > 0;

export const universityName = (c: Pick<SeekPerson, "universityAssessment">) => c.universityAssessment?.name ?? NOT_CONFIRMED;
export const workRightsText = (c: Pick<SeekPerson, "workRightsAnswer">) => c.workRightsAnswer ?? NO_ANSWER;

export function matchesSeekFilter(c: Omit<SeekPerson, "seekApplicationId" | "sourceIds">, filter: SeekFilter, threshold: number) {
  const needle = filter.query.trim().toLowerCase();
  if (needle && !`${c.name} ${c.email ?? ""}`.toLowerCase().includes(needle)) return false;
  if (filter.universities.length && !filter.universities.includes(universityName(c))) return false;
  if (filter.workRights && workRightsText(c) !== filter.workRights) return false;
  if (filter.subject && !c.subjects.includes(filter.subject)) return false;
  if (filter.campaign && c.seekJobId !== filter.campaign) return false;
  if (filter.score === "none") return c.profileScore === null;
  if (filter.score === "pass") return c.profileScore !== null && c.profileScore >= threshold;
  if (filter.score === "below") return c.profileScore !== null && c.profileScore < threshold;
  return true;
}

function options<T>(rows: T[], name: (row: T) => string, last: string) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(name(row), (counts.get(name(row)) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ name: value, count }))
    .sort((a, b) => Number(a.name === last) - Number(b.name === last) || a.name.localeCompare(b.name));
}
export const universityOptions = (rows: Pick<SeekPerson, "universityAssessment">[]) => options(rows, universityName, NOT_CONFIRMED);
export const workRightsOptions = (rows: Pick<SeekPerson, "workRightsAnswer">[]) => options(rows, workRightsText, NO_ANSWER);

/** The numbered queue from the server, then the people already sent a form, newest first. Place stays true when a filter hides people. */
export function sendQueueRows<T extends { id: string }>(candidates: T[], order: string[], sent: Map<string, Date>) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const queued = order.flatMap((id, index) => {
    const candidate = byId.get(id);
    return candidate ? [{ candidate, place: index + 1 as number | null, sentAt: null as Date | null }] : [];
  });
  const done = candidates
    .flatMap((candidate) => {
      const sentAt = sent.get(candidate.id);
      return sentAt ? [{ candidate, place: null as number | null, sentAt: sentAt as Date | null }] : [];
    })
    .sort((a, b) => b.sentAt!.getTime() - a.sentAt!.getTime());
  return [...queued, ...done];
}

/** Who stands ahead of `id` after it moves to `target`'s place in the full queue. Null when nothing would change. */
export function aheadAfterMove(order: string[], id: string, target: string) {
  const from = order.indexOf(id);
  const to = order.indexOf(target);
  if (from === -1 || to === -1 || from === to) return null;
  const rest = order.filter((other) => other !== id);
  return rest.slice(0, rest.indexOf(target) + (from < to ? 1 : 0));
}

const STALE_AFTER_MS = 60 * 60 * 1000;

type SeekJob = HiringConfig["seekJobs"][number];
/** The header line: the active campaigns, by name and job ID. */
export const campaignNames = (jobs: SeekJob[]) =>
  jobs.filter((j) => j.active).map((j) => `${j.label} (${j.jobId})`).join(", ") || "no active campaign";
/** A row's campaign name. A job no longer in the list shows its ID. */
export const campaignName = (jobs: SeekJob[], jobId: string | null | undefined) =>
  jobId ? (jobs.find((j) => j.jobId === jobId)?.label ?? `SEEK job ${jobId}`) : "No SEEK job";

type CampaignSummary = NonNullable<HiringSourceSummary["campaigns"]>[number];
/** The saved worker summary: each job's own numbers, and their sums for the screens that show one total. */
export function mergeSourceSummaries(campaigns: CampaignSummary[]): HiringSourceSummary {
  const sum = (key: "scanned" | "imported" | "remaining" | "resumeUploadsFailed" | "resumeLocked") =>
    campaigns.reduce((n, c) => n + (c[key] ?? 0), 0);
  const folders = new Map<string, HiringSourceSummary["folders"][number]>();
  for (const folder of campaigns.flatMap((c) => c.folders)) {
    const seen = folders.get(folder.status);
    folders.set(
      folder.status,
      seen ? { ...seen, count: seen.count + folder.count, imported: (seen.imported ?? 0) + (folder.imported ?? 0) } : { ...folder },
    );
  }
  return {
    scanned: sum("scanned"),
    imported: sum("imported"),
    remaining: sum("remaining"),
    resumeUploadsFailed: sum("resumeUploadsFailed"),
    resumeLocked: sum("resumeLocked"),
    folders: [...folders.values()],
    campaigns,
  };
}

/** SEEK count against the website, per imported folder, from the last worker read. A summary from before this count has no number to show. */
export function seekCoverage(summary: HiringSourceSummary | null, workerAt: Date | string | null, now = new Date()) {
  if (!summary) return null;
  return {
    rows: IMPORTED_SEEK_FOLDERS.map((status) => {
      const folder = summary.folders.find((f) => f.status === status);
      const imported = folder?.imported ?? null;
      const count = folder?.count ?? 0;
      return { status, count, imported, waiting: imported === null ? null : Math.max(0, count - imported) };
    }),
    stale: !workerAt || now.getTime() - new Date(workerAt).getTime() > STALE_AFTER_MS,
  };
}

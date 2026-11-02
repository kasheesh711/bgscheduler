import type { HiringSourceSummary, Subject } from "./model";

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
};
export const NO_SEEK_FILTER: SeekFilter = { query: "", universities: [], workRights: "", subject: "", score: "" };

type SeekPerson = {
  name: string;
  email: string | null;
  seekApplicationId: string | null;
  sourceIds: string[];
  subjects: Subject[];
  profileScore: number | null;
  workRightsAnswer: string | null;
  universityAssessment: { name: string | null } | null;
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

const STALE_AFTER_MS = 60 * 60 * 1000;

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

import type { AutowriterDashboard } from "./dashboard";
import { holdReasonLabel } from "./hold-reasons";
import type { AutowriterReview, ReviewQueueItem } from "./review-data";

/**
 * "What needs you": the owner's to-do list of the autowriter dashboard (redesign, section 3.2). Pure and free of
 * server-only imports: it runs on the client from the two payloads the page already has, so there is no inbox route.
 * Titles and details are short plain sentences; they never carry lesson text — not the feedback, not the judge's
 * quotes in a hold reason, not a flag's note.
 */

export type InboxItemKind = "incident" | "hold" | "review" | "decision" | "failed_post" | "expansion_ready";

export interface InboxItem {
  /** Stable across reloads: `<kind>:<incident id | Wise session id>`. */
  id: string;
  kind: InboxItemKind;
  urgency: "critical" | "soon" | "normal";
  title: string;
  detail: string;
  /** Joins with the tutor table (`tutors[].tutorKey`); null when the item belongs to no tutor the page knows. */
  tutorKey: string | null;
  wiseSessionId: string | null;
  classEndedAt: string | null;
  deadlineAt: string | null;
  /** When the tutor was told about a hold (the hold tracker, PR 2); always null until then. */
  tutorNotifiedAt: string | null;
  action: "open" | "review" | "decide" | "confirm";
}

/** Items of the groups later PRs fill: forward-scan decisions (PR 3) and the expansion confirmation (PR 4). */
export interface InboxExtras {
  decisions?: InboxItem[];
  expansion?: InboxItem[];
}

/** What the list reads from the dashboard payload (`AutowriterDashboard` has all of it). */
export interface InboxDashboard {
  holds: AutowriterDashboard["holds"];
  failedPosts: AutowriterDashboard["failedPosts"];
  recent: ReadonlyArray<Pick<AutowriterDashboard["recent"][number], "wiseSessionId" | "tutorKey" | "scheduledEndAt">>;
}

/** What the list reads from the review payload (`AutowriterReview` has all of it): never the feedback itself. */
export interface InboxReview {
  queue: ReadonlyArray<Pick<ReviewQueueItem, "wiseSessionId" | "tutor" | "tutorKey" | "className" | "classEndedAt" | "status" | "openFlags">>;
  incidents: AutowriterReview["incidents"];
}

/** The groups of the list, in display order; a group is shown only when it has items. */
export const INBOX_GROUPS: ReadonlyArray<{ kind: InboxItemKind; label: string }> = [
  { kind: "incident", label: "Incidents" },
  { kind: "hold", label: "Held" },
  { kind: "review", label: "To review" },
  { kind: "decision", label: "Decisions" },
  { kind: "failed_post", label: "Failed posts" },
  { kind: "expansion_ready", label: "Expansion" },
];

/** A held class turns red this long before its deadline, and amber this long before it. */
const HOLD_CRITICAL_MS = 6 * 60 * 60 * 1000;
const HOLD_SOON_MS = 24 * 60 * 60 * 1000;
/** A held class nobody wrote leaves the list this long after its deadline: by then nothing can be done in time. */
const HOLD_LISTED_AFTER_DEADLINE_MS = 24 * 60 * 60 * 1000;

const INCIDENT_TITLES: Record<string, string> = {
  halt: "Posting was halted",
  correction_failed: "A correction did not go through",
  critical_verdict: "A critical error was found in a post",
  critical_flag: "A post landed in Wise without verifying",
  credit_entries_changed: "A post changed the class's credit entries",
  api_actor_unmatched: "A save by the Wise API user that no post explains",
  first_shot_unverified: "A post cannot be proven against what was sent",
  scan_failed: "The forward scan failed",
};

const FAILED_POST_TITLES: Record<InboxDashboard["failedPosts"][number]["state"], string> = {
  verify_failed: "A post did not verify in Wise",
  unknown_outcome: "A post's outcome in Wise is unknown",
  rejected: "Wise rejected a post",
};

/** Why a post is flagged, by the flag's source. A flag's own note is never shown here: an agent's may quote the lesson. */
const FLAG_SOURCES: Record<string, string> = {
  measured_fix: "changed in Wise after posting",
  api_unmatched: "an API save no post explains",
  system: "did not verify in Wise",
  agent: "flagged by the agent",
  owner: "flagged by the owner",
};

const SEPARATOR = " · ";

function parts(...values: Array<string | null | false>): string {
  return values.filter((value): value is string => Boolean(value)).join(SEPARATOR);
}

/** Epoch ms of an ISO time; a missing or unreadable one counts as `missing` (by default, later than any time). */
function timeOf(value: string | null, missing = Number.POSITIVE_INFINITY): number {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(time) ? missing : time;
}

function holdUrgency(deadlineAt: string | null, now: Date): InboxItem["urgency"] {
  const left = timeOf(deadlineAt) - now.getTime();
  return left < HOLD_CRITICAL_MS ? "critical" : left < HOLD_SOON_MS ? "soon" : "normal";
}

/**
 * Whether a held class still waits for someone: nobody has written it (`resolvedBy`), and its deadline is ahead or
 * passed less than 24 hours ago. A class without a deadline keeps waiting. The row itself stays `held` either way, so
 * every hold is still in the All classes log.
 */
export function isOpenHold(hold: Pick<InboxDashboard["holds"][number], "resolvedBy" | "deadlineAt">, now: Date): boolean {
  return hold.resolvedBy === null && now.getTime() - timeOf(hold.deadlineAt) < HOLD_LISTED_AFTER_DEADLINE_MS;
}

/**
 * The to-do list, in display order:
 * 1. incidents: critical and not acknowledged, newest first;
 * 2. holds still waiting for someone (`isOpenHold`): soonest deadline first — red with under 6 hours left (or the
 *    deadline passed), amber under 24 hours;
 * 3. reviews: posts with an open flag first (amber), then the required ones without a verdict, oldest class first;
 * 4. decisions (`extras`);
 * 5. failed posts, latest class first;
 * 6. expansion (`extras`).
 * `review` is null when the review data is unavailable: holds and failed posts are still listed.
 */
export function buildInbox(
  dashboard: InboxDashboard,
  review: InboxReview | null,
  options: { now?: Date; extras?: InboxExtras } = {},
): InboxItem[] {
  const now = options.now ?? new Date();

  // The classes the page holds, for an incident's tutor and class time (the first list that knows a class wins).
  const classes = new Map<string, { tutorKey: string; classEndedAt: string | null }>();
  const known = (wiseSessionId: string, tutorKey: string, classEndedAt: string | null) => {
    if (!classes.has(wiseSessionId)) classes.set(wiseSessionId, { tutorKey, classEndedAt });
  };
  for (const item of review?.queue ?? []) known(item.wiseSessionId, item.tutorKey, item.classEndedAt);
  for (const row of dashboard.holds) known(row.wiseSessionId, row.tutorKey, row.classEndedAt);
  for (const row of dashboard.failedPosts) known(row.wiseSessionId, row.tutorKey, row.classEndedAt);
  for (const row of dashboard.recent) known(row.wiseSessionId, row.tutorKey, row.scheduledEndAt);

  const incidents = (review?.incidents ?? [])
    .filter((incident) => incident.severity === "critical" && incident.acknowledgedAt === null)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((incident): InboxItem => {
      const about = incident.wiseSessionId ? classes.get(incident.wiseSessionId) : undefined;
      return {
        id: `incident:${incident.id}`,
        kind: "incident",
        urgency: "critical",
        title: INCIDENT_TITLES[incident.kind] ?? "An incident needs a look",
        detail: incident.summary,
        tutorKey: about?.tutorKey ?? null,
        wiseSessionId: incident.wiseSessionId,
        classEndedAt: about?.classEndedAt ?? null,
        deadlineAt: null,
        tutorNotifiedAt: null,
        action: "open",
      };
    });

  const holds = dashboard.holds
    .filter((row) => isOpenHold(row, now))
    .toSorted((a, b) => timeOf(a.deadlineAt) - timeOf(b.deadlineAt) || timeOf(a.classEndedAt) - timeOf(b.classEndedAt)
      || a.wiseSessionId.localeCompare(b.wiseSessionId))
    .map((row): InboxItem => ({
      id: `hold:${row.wiseSessionId}`,
      kind: "hold",
      urgency: holdUrgency(row.deadlineAt, now),
      title: holdReasonLabel(row.reason),
      detail: parts(row.tutor, row.className, row.hasDraft && "draft stored"),
      tutorKey: row.tutorKey,
      wiseSessionId: row.wiseSessionId,
      classEndedAt: row.classEndedAt,
      deadlineAt: row.deadlineAt,
      tutorNotifiedAt: null,
      action: "open",
    }));

  const reviews = (review?.queue ?? [])
    // `flagged`: an open flag, whatever the sampling and whatever verdict came before it. `needs_review`: required, no verdict.
    .filter((item) => item.status === "flagged" || item.status === "needs_review")
    .toSorted((a, b) => Number(b.status === "flagged") - Number(a.status === "flagged")
      || timeOf(a.classEndedAt) - timeOf(b.classEndedAt) || a.wiseSessionId.localeCompare(b.wiseSessionId))
    .map((item): InboxItem => {
      const flagged = item.status === "flagged";
      const why = [...new Set(item.openFlags.map((flag) => FLAG_SOURCES[flag.source] ?? "flagged"))].join("; ");
      return {
        id: `review:${item.wiseSessionId}`,
        kind: "review",
        urgency: flagged ? "soon" : "normal",
        title: flagged ? "A flagged post to review" : "A post to review",
        detail: parts(item.tutor, item.className, flagged && why),
        tutorKey: item.tutorKey,
        wiseSessionId: item.wiseSessionId,
        classEndedAt: item.classEndedAt,
        deadlineAt: null,
        tutorNotifiedAt: null,
        action: "review",
      };
    });

  const failedPosts = dashboard.failedPosts
    .toSorted((a, b) => timeOf(b.classEndedAt, 0) - timeOf(a.classEndedAt, 0))
    .map((row): InboxItem => ({
      id: `failed_post:${row.wiseSessionId}`,
      kind: "failed_post",
      urgency: "normal",
      title: FAILED_POST_TITLES[row.state],
      detail: parts(row.tutor, row.className),
      tutorKey: row.tutorKey,
      wiseSessionId: row.wiseSessionId,
      classEndedAt: row.classEndedAt,
      deadlineAt: null,
      tutorNotifiedAt: null,
      action: "open",
    }));

  return [...incidents, ...holds, ...reviews, ...(options.extras?.decisions ?? []), ...failedPosts, ...(options.extras?.expansion ?? [])];
}

/**
 * The list narrowed to one tutor; `null` keeps every item. An item that belongs to no tutor (a halt, an incident on a
 * class the page does not hold, the expansion confirmation) concerns everyone and stays in every tutor's list, so a
 * filter never hides a critical incident.
 */
export function filterInbox(items: readonly InboxItem[], tutorKey: string | null): InboxItem[] {
  return items.filter((item) => tutorKey === null || item.tutorKey === null || item.tutorKey === tutorKey);
}

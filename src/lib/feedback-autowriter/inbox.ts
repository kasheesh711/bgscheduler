import type { AutowriterDashboard } from "./dashboard";
import type { AutowriterReview } from "./review-data";

/**
 * "What needs you": the owner's to-do list of the autowriter dashboard (redesign, section 3.2). Pure and free of
 * server-only imports: it runs on the client from the two payloads the page already has, so there is no inbox route.
 * Titles and details are short plain sentences; they never carry lesson text.
 */

export type InboxItemKind = "incident" | "hold" | "review" | "decision" | "failed_post" | "expansion_ready";

export interface InboxItem {
  /** Stable across reloads: `<kind>:<incident id | Wise session id>`. */
  id: string;
  kind: InboxItemKind;
  urgency: "critical" | "soon" | "normal";
  title: string;
  detail: string;
  /** Joins with the tutor table (`tutors[].tutorKey`); null when the item belongs to no tutor. */
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

/** The groups of the list, in display order; a group is shown only when it has items. */
export const INBOX_GROUPS: ReadonlyArray<{ kind: InboxItemKind; label: string }> = [
  { kind: "incident", label: "Incidents" },
  { kind: "hold", label: "Held" },
  { kind: "review", label: "To review" },
  { kind: "decision", label: "Decisions" },
  { kind: "failed_post", label: "Failed posts" },
  { kind: "expansion_ready", label: "Expansion" },
];

/**
 * The to-do list, in display order: incidents, holds, reviews, decisions, failed posts, expansion. `review` is null
 * when the review data is unavailable: holds and failed posts are still listed.
 */
export function buildInbox(
  dashboard: AutowriterDashboard,
  review: AutowriterReview | null,
  options: { now?: Date; extras?: InboxExtras } = {},
): InboxItem[] {
  void dashboard;
  void review;
  void options;
  throw new Error("not implemented");
}

/** The items of one tutor; `null` keeps every item. */
export function filterInbox(items: readonly InboxItem[], tutorKey: string | null): InboxItem[] {
  void items;
  void tutorKey;
  throw new Error("not implemented");
}

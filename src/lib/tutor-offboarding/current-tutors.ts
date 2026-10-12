import { resolvePostClassTutorRecipient } from "@/lib/post-class-feedback/notifications";
import { cell } from "./workforce/csv";
import type { OffboardingDashboardData, OffboardingUnavailableReason } from "./types";

// ----------------------------------------------------------------------------
// Current tutors: everyone teaching now, for the email-current-tutors team skill. Read-only; the skill only
// drafts a Gmail message and a person sends it.
// ----------------------------------------------------------------------------

/** A taught class within this many days counts as teaching now (owner decision 2026-10-12). */
export const RECENT_TEACHING_DAYS = 30;

export interface TutorContactEmails {
  canonicalKey: string;
  primaryEmail: string | null;
  onsiteEmail: string | null;
  onlineEmail: string | null;
}

export interface CurrentTutorRecipient {
  name: string;
  email: string;
  reason: "upcoming" | "recent";
}

export interface CurrentTutorList {
  generatedAt: string;
  snapshotCreatedAt: string;
  stale: boolean;
  recipients: CurrentTutorRecipient[];
  needsEmail: Array<{ name: string; candidates: string[] }>;
  excludedConfirmed: Array<{ name: string }>;
  unmatchedSheetRows: number;
}

export type CurrentTutorListResponse =
  | ({ available: true } & CurrentTutorList)
  | { available: false; reason: OffboardingUnavailableReason };

type DashboardInput = Pick<
  OffboardingDashboardData,
  "inbox" | "excluded" | "staff" | "freshness" | "snapshotCreatedAt" | "terminationSource"
>;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function validEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * The tutors teaching now:
 * 1. Each person (canonicalKey) once, across the review list, exclusions and staff accounts.
 * 2. A matched strike-through sheet row (OFF-15) leaves the person out, even while they still teach.
 * 3. Current = an upcoming class, or a taught class in the last RECENT_TEACHING_DAYS ("upcoming" wins).
 * 4. Email = the post-class rule: the primary override, else one distinct Wise email (contact row first, then the
 *    first onsite/online account). A conflict or a gap goes to needsEmail, never guessed.
 * 5. One recipient per address (the first person wins), sorted by name.
 */
export function buildCurrentTutorList(input: {
  dashboard: DashboardInput;
  contacts: TutorContactEmails[];
  now: Date;
}): CurrentTutorList {
  const { dashboard, now } = input;
  const contacts = new Map(input.contacts.map((contact) => [contact.canonicalKey, contact]));
  const recentSince = now.getTime() - RECENT_TEACHING_DAYS * 86_400_000;
  const seenPeople = new Set<string>();
  const seenEmails = new Set<string>();
  const recipients: CurrentTutorRecipient[] = [];
  const needsEmail: CurrentTutorList["needsEmail"] = [];
  const excludedConfirmed: CurrentTutorList["excludedConfirmed"] = [];

  for (const row of [...dashboard.inbox, ...dashboard.excluded, ...dashboard.staff]) {
    const { canonicalKey, displayName: name, accounts, upcomingSessions, lastTaughtAt } = row.signals;
    if (seenPeople.has(canonicalKey)) continue;
    seenPeople.add(canonicalKey);
    if (row.termination) {
      excludedConfirmed.push({ name });
      continue;
    }
    const reason = upcomingSessions > 0 ? "upcoming"
      : lastTaughtAt !== null && Date.parse(lastTaughtAt) >= recentSince ? "recent"
        : null;
    if (!reason) continue;

    const contact = contacts.get(canonicalKey);
    const onsiteEmail = validEmail(contact?.onsiteEmail)
      ?? validEmail(accounts.find((account) => !account.isOnlineVariant && validEmail(account.email))?.email);
    const onlineEmail = validEmail(contact?.onlineEmail)
      ?? validEmail(accounts.find((account) => account.isOnlineVariant && validEmail(account.email))?.email);
    const { email } = resolvePostClassTutorRecipient({ primaryEmail: contact?.primaryEmail, onsiteEmail, onlineEmail });
    if (!email) {
      const candidates = [onsiteEmail, onlineEmail, ...accounts.map((account) => validEmail(account.email))]
        .filter((value): value is string => value !== null);
      needsEmail.push({ name, candidates: [...new Set(candidates)] });
      continue;
    }
    if (seenEmails.has(email)) continue;
    seenEmails.add(email);
    recipients.push({ name, email, reason });
  }

  return {
    generatedAt: now.toISOString(),
    snapshotCreatedAt: dashboard.snapshotCreatedAt,
    stale: !dashboard.freshness.ok,
    recipients: recipients.sort(byName),
    needsEmail: needsEmail.sort(byName),
    excludedConfirmed: excludedConfirmed.sort(byName),
    unmatchedSheetRows: dashboard.terminationSource?.unmatched.length ?? 0,
  };
}

/** Recipients only, as UTF-8 with a BOM; formula-leading text is defused by the workforce export's `cell`. */
export function currentTutorsCsv(list: CurrentTutorList): string {
  const rows = [["name", "email", "reason"], ...list.recipients.map((r) => [r.name, r.email, r.reason])];
  return `﻿${rows.map((values) => values.map(cell).join(",")).join("\r\n")}`;
}

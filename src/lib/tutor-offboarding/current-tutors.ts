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
  /** Departure rows (tutor sheet strike-throughs plus the owner-confirmed list) that matched no roster person. */
  unmatchedDepartures: number;
}

export type CurrentTutorListResponse =
  | ({ available: true } & CurrentTutorList)
  | { available: false; reason: OffboardingUnavailableReason };

type DashboardInput = Pick<
  OffboardingDashboardData,
  "inbox" | "active" | "excluded" | "staff" | "freshness" | "snapshotCreatedAt" | "terminationSource"
>;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function validEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * The tutors teaching now:
 * 1. Each person (canonicalKey) once, across every dashboard list: review, active, exclusions and staff accounts.
 * 2. Current = an upcoming class, or a taught class in the last RECENT_TEACHING_DAYS ("upcoming" wins).
 * 3. A matched strike-through sheet row (OFF-15) or owner-confirmed departure leaves a current person out, listed in
 *    excludedConfirmed.
 * 4. Email = the post-class rule: the primary override, else one distinct Wise email (the contact row's, else every
 *    account of that variant). Two different addresses, or none, go to needsEmail, never guessed.
 * 5. One recipient per address (the first person wins), sorted by name.
 */
export function buildCurrentTutorList(input: {
  dashboard: DashboardInput;
  contacts: TutorContactEmails[];
  /** People matched on the owner-confirmed departures list, and how many of its rows matched nobody. */
  ownerConfirmed?: { keys: ReadonlySet<string>; unmatched: number };
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

  for (const row of [...dashboard.inbox, ...dashboard.active, ...dashboard.excluded, ...dashboard.staff]) {
    const { canonicalKey, displayName: name, accounts, upcomingSessions, lastTaughtAt } = row.signals;
    if (seenPeople.has(canonicalKey)) continue;
    seenPeople.add(canonicalKey);
    const reason = upcomingSessions > 0 ? "upcoming"
      : lastTaughtAt !== null && Date.parse(lastTaughtAt) >= recentSince ? "recent"
        : null;
    if (!reason) continue;
    if (row.termination || input.ownerConfirmed?.keys.has(canonicalKey)) {
      excludedConfirmed.push({ name });
      continue;
    }

    const contact = contacts.get(canonicalKey);
    const variantEmails = (online: boolean, contactEmail: string | null | undefined): string[] => {
      const fromContact = validEmail(contactEmail);
      if (fromContact) return [fromContact];
      return [...new Set(accounts.filter((account) => account.isOnlineVariant === online)
        .map((account) => validEmail(account.email)).filter((value): value is string => value !== null))];
    };
    const onsite = variantEmails(false, contact?.onsiteEmail);
    const online = variantEmails(true, contact?.onlineEmail);
    const resolved = resolvePostClassTutorRecipient({
      primaryEmail: contact?.primaryEmail, onsiteEmail: onsite[0] ?? null, onlineEmail: online[0] ?? null,
    });
    // Two onsite (or two online) accounts with different addresses are a conflict too, unless a primary overrides.
    const email = resolved.source === "primary" || (onsite.length <= 1 && online.length <= 1) ? resolved.email : null;
    if (!email) {
      const candidates = [...onsite, ...online, ...accounts.map((account) => validEmail(account.email))]
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
    unmatchedDepartures: (dashboard.terminationSource?.unmatched.length ?? 0) + (input.ownerConfirmed?.unmatched ?? 0),
  };
}

/** Recipients only, as UTF-8 with a BOM; formula-leading text is defused by the workforce export's `cell`. */
export function currentTutorsCsv(list: CurrentTutorList): string {
  const rows = [["name", "email", "reason"], ...list.recipients.map((r) => [r.name, r.email, r.reason])];
  return `\uFEFF${rows.map((values) => values.map(cell).join(",")).join("\r\n")}`;
}

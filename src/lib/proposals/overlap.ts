import { toZonedTime } from "date-fns-tz";
import { TIMEZONE } from "@/lib/normalization/timezone";
import type {
  ActiveProposalStatus,
  ProposalHoldSummary,
  ProposalScope,
} from "@/lib/proposals/types";

export const ACTIVE_PROPOSAL_STATUSES: ActiveProposalStatus[] = ["pending", "confirmed"];

export interface ProposalSlotLike {
  tutorCanonicalKey: string;
  scope: ProposalScope;
  weekday: number;
  date?: string;
  startMinute: number;
  endMinute: number;
  status?: string;
  expiresAt?: string | Date | null;
}

export interface WiseSessionLike {
  tutorCanonicalKey: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  date?: string;
}

export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatBangkokDate(date: Date): string {
  const bkk = toZonedTime(date, TIMEZONE);
  return [
    bkk.getFullYear(),
    String(bkk.getMonth() + 1).padStart(2, "0"),
    String(bkk.getDate()).padStart(2, "0"),
  ].join("-");
}

export function weekdayForIsoDate(value: string): number {
  return new Date(`${value}T00:00:00+07:00`).getDay();
}

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export function isActiveProposalStatus(status: string): status is ActiveProposalStatus {
  return status === "pending" || status === "confirmed";
}

export function isProposalActiveAt(
  status: string,
  expiresAt: string | Date | null | undefined,
  now: Date = new Date(),
): status is ActiveProposalStatus {
  if (status === "confirmed") return true;
  if (status !== "pending") return false;
  if (!expiresAt) return false;
  const expires = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  return expires.getTime() > now.getTime();
}

export function proposalSlotsOverlap(a: ProposalSlotLike, b: ProposalSlotLike): boolean {
  if (a.tutorCanonicalKey !== b.tutorCanonicalKey) return false;
  if (!rangesOverlap(a.startMinute, a.endMinute, b.startMinute, b.endMinute)) return false;

  if (a.scope === "recurring" && b.scope === "recurring") {
    return a.weekday === b.weekday;
  }

  if (a.scope === "one_time" && b.scope === "one_time") {
    return !!a.date && a.date === b.date;
  }

  return a.weekday === b.weekday;
}

export function proposalHoldBlocksSearchSlot(
  hold: ProposalHoldSummary,
  search: {
    searchMode: ProposalScope;
    weekday: number;
    date?: string;
    startMinute: number;
    endMinute: number;
  },
): boolean {
  if (!rangesOverlap(hold.startMinute, hold.endMinute, search.startMinute, search.endMinute)) {
    return false;
  }

  if (search.searchMode === "recurring") {
    return hold.scope === "recurring" && hold.weekday === search.weekday;
  }

  if (hold.scope === "recurring") {
    return hold.weekday === search.weekday;
  }

  return !!search.date && hold.date === search.date;
}

export function findConflictingProposal(
  candidate: ProposalSlotLike,
  activeHolds: ProposalHoldSummary[],
): ProposalHoldSummary | null {
  return activeHolds.find((hold) => proposalSlotsOverlap(candidate, hold)) ?? null;
}

export function findAutoResolvedProposalItemIds(
  confirmedHolds: ProposalHoldSummary[],
  wiseSessions: WiseSessionLike[],
): string[] {
  const resolved = new Set<string>();

  for (const hold of confirmedHolds) {
    if (hold.status !== "confirmed") continue;
    const match = wiseSessions.some((session) => {
      if (session.tutorCanonicalKey !== hold.tutorCanonicalKey) return false;
      if (!rangesOverlap(session.startMinute, session.endMinute, hold.startMinute, hold.endMinute)) {
        return false;
      }
      if (hold.scope === "recurring") {
        return session.weekday === hold.weekday;
      }
      return !!hold.date && session.date === hold.date;
    });
    if (match) resolved.add(hold.itemId);
  }

  return [...resolved];
}

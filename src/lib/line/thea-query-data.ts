import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { theaQueryCache, tutorAliases } from "@/lib/db/schema";
import { WiseApiError, WiseClient } from "@/lib/wise/client";
import { fetchAllTeachers, fetchTeacherAvailability } from "@/lib/wise/fetchers";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import { getWiseSessionTeacherUserId, getWiseTeacherDisplayName, getWiseTeacherUserId,
  type WiseTeacher, type WiseSession, type WiseAvailabilityResponse } from "@/lib/wise/types";
import { normalizeTeacherTags } from "@/lib/normalization/qualifications";
import { normalizeWorkingHours } from "@/lib/normalization/availability";
import { normalizeSessions, isBlockingStatus } from "@/lib/normalization/sessions";
import { deriveModality } from "@/lib/normalization/modality";
import { resolveOnboardingIdentities } from "@/lib/tutor-onboarding/planner";
import { loadAccountMappings } from "@/lib/tutor-onboarding/sync";
import { buildFilterOptions } from "@/lib/data/filters";
import { executeSearch } from "@/lib/search/engine";
import type { IndexedTutorGroup, SearchIndex } from "@/lib/search/index";
import { addBangkokDays } from "@/lib/room-capacity/dates";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import type { ReadyTheaQuery } from "./thea-query";

export const SESSION_INVALIDATION_KEY = "sessions-invalidated";
const COOLDOWN_KEY = "wise-cooldown";

export async function invalidateTheaSessions(db: Database) {
  const now = new Date();
  await db.insert(theaQueryCache).values({ key: SESSION_INVALIDATION_KEY, payload: {}, fetchedAt: now, expiresAt: now })
    .onConflictDoUpdate({ target: theaQueryCache.key, set: { fetchedAt: now, expiresAt: now } });
}

/** Only the globally leased query worker reads Wise. Its pacing includes every HTTP attempt. */
export class TheaWiseReader {
  readonly client: WiseClient;
  readonly checks: Date[] = [];
  private calls = 0;
  constructor(private db: Database, deadline: number) {
    this.client = new WiseClient({ userId: process.env.WISE_USER_ID!, apiKey: process.env.WISE_API_KEY!,
      namespace: process.env.WISE_NAMESPACE ?? "begifted-education", maxConcurrency: 1, maxRetries: 0,
      requestsPerSecond: 0.5, stopOnRateLimit: true, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      beforeRequest: async () => {
        if (++this.calls > 200 || Date.now() >= deadline) throw new Error("This query is too broad. Please narrow the teacher or subject.");
        const [cooldown] = await db.select().from(theaQueryCache).where(eq(theaQueryCache.key, COOLDOWN_KEY));
        if (cooldown && cooldown.expiresAt > new Date()) throw new Error("Wise is rate-limiting requests. Please try again later.");
      } });
  }
  async invalidatedAt() {
    const [row] = await this.db.select().from(theaQueryCache).where(eq(theaQueryCache.key, SESSION_INVALIDATION_KEY));
    return row?.fetchedAt ?? new Date(0);
  }
  async read<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<{ data: T; checkedAt: Date }> {
    const [row] = await this.db.select().from(theaQueryCache).where(eq(theaQueryCache.key, key));
    const invalidation = key.startsWith("day:") ? await this.invalidatedAt() : new Date(0);
    if (row && row.expiresAt > new Date() && row.fetchedAt > invalidation) {
      this.checks.push(row.fetchedAt);
      return { data: row.payload as T, checkedAt: row.fetchedAt };
    }
    const checkedAt = new Date();
    let data: T;
    try { data = await load(); }
    catch (error) {
      if (error instanceof WiseApiError && error.status === 429) {
        const expiresAt = new Date(Date.now() + Math.max(60_000, error.retryAfterMs ?? 60_000));
        await this.db.insert(theaQueryCache).values({ key: COOLDOWN_KEY, payload: {}, fetchedAt: new Date(), expiresAt })
          .onConflictDoUpdate({ target: theaQueryCache.key, set: { expiresAt: sql`greatest(${theaQueryCache.expiresAt}, ${expiresAt})` } });
      }
      throw error;
    }
    await this.db.insert(theaQueryCache).values({ key, payload: data, fetchedAt: checkedAt, expiresAt: new Date(checkedAt.getTime() + ttlMs) })
      .onConflictDoUpdate({ target: theaQueryCache.key, set: { payload: data, fetchedAt: checkedAt, expiresAt: new Date(checkedAt.getTime() + ttlMs) } });
    this.checks.push(checkedAt);
    return { data, checkedAt };
  }
}

export async function readTheaRoster(db: Database, reader: TheaWiseReader) {
  const { data: teachers } = await reader.read("teachers", 10 * 60_000, async () => {
    const rows = await fetchAllTeachers(reader.client, process.env.WISE_INSTITUTE_ID!);
    if (!rows.length) throw new Error("Wise returned no teachers; I cannot verify availability.");
    return rows.map(t => ({ _id: t._id, name: t.name, tags: t.tags, status: t.status,
      userId: { _id: getWiseTeacherUserId(t) ?? "", name: getWiseTeacherDisplayName(t) } })) as WiseTeacher[];
  });
  const [aliases, mappings] = await Promise.all([db.select().from(tutorAliases), loadAccountMappings(db)]);
  const identity = resolveOnboardingIdentities(teachers, aliases, mappings);
  const qualifications = new Map(teachers.map(t => [t._id, normalizeTeacherTags(t.tags ?? [], t._id, getWiseTeacherDisplayName(t))]));
  return { ...identity, qualifications, options: buildFilterOptions([...qualifications.values()].flatMap(q => q.qualifications)) };
}
export type TheaRoster = Awaited<ReturnType<typeof readTheaRoster>>;

export function qualifiedTheaGroups(roster: TheaRoster, query: ReadyTheaQuery) {
  const needle = query.teacher?.trim().toLocaleLowerCase();
  const named = roster.groups.filter(g => !needle || g.displayName.toLocaleLowerCase() === needle
    || g.canonicalKey.toLocaleLowerCase() === needle || g.members.some(m => m.wiseDisplayName.toLocaleLowerCase() === needle));
  return named.filter(g => g.members.some(m => roster.qualifications.get(m.wiseTeacherId)?.qualifications.some(q =>
    (!query.filters.subject || q.subject === query.filters.subject) && (!query.filters.curriculum || q.curriculum === query.filters.curriculum)
      && (!query.filters.level || q.level === query.filters.level))) || !Object.keys(query.filters).length);
}

/** Build the existing search engine's input from the bounded, checked Wise reads. */
export function buildTheaIndex(roster: TheaRoster, query: ReadyTheaQuery, sessions: WiseSession[],
  availability: Map<string, WiseAvailabilityResponse>, now: Date): SearchIndex {
  const groups = qualifiedTheaGroups(roster, query);
  const teacherByUser = new Map(groups.flatMap(g => g.members.flatMap(m =>
    [[m.wiseTeacherId, m.wiseTeacherId] as const, ...(m.wiseUserId ? [[m.wiseUserId, m.wiseTeacherId] as const] : [])])));
  const source = new Map(sessions.map(s => [s._id, s]));
  const blocks = normalizeSessions(sessions, s => teacherByUser.get(getWiseSessionTeacherUserId(s) ?? "") ?? null)
    .map(b => ({ ...b, startTime: new Date(source.get(b.wiseSessionId)!.scheduledStartTime), endTime: new Date(source.get(b.wiseSessionId)!.scheduledEndTime) }));
  const indexed: IndexedTutorGroup[] = groups.map(g => {
    const modality = deriveModality(g, blocks);
    const dataIssues = roster.issues.filter(i => i.entityId === g.canonicalKey || g.members.some(m => m.wiseTeacherId === i.entityId))
      .map(i => ({ type: "identity", message: i.message }));
    if (roster.blocked.has(g.canonicalKey)) dataIssues.push({ type: "identity", message: "Ambiguous teacher identity" });
    if (modality.issue) dataIssues.push({ type: "modality", message: modality.issue.message });
    const windows: IndexedTutorGroup["availabilityWindows"] = [], leaves: IndexedTutorGroup["leaves"] = [];
    for (const member of g.members) {
      dataIssues.push(...(roster.qualifications.get(member.wiseTeacherId)?.issues ?? []).map(i => ({ type: "qualification", message: i.message })));
      const raw = member.wiseUserId ? availability.get(member.wiseUserId) : undefined;
      if (!raw) { dataIssues.push({ type: "availability", message: "Working hours and leave could not be verified" }); continue; }
      windows.push(...normalizeWorkingHours(raw.workingHours?.slots).map(w => ({ ...w, wiseTeacherId: member.wiseTeacherId,
        modality: member.isOnlineVariant ? "online" : modality.modality === "both" ? "onsite" : modality.modality })));
      leaves.push(...(raw.leaves ?? []).map(l => ({ startTime: new Date(l.startTime), endTime: new Date(l.endTime) })));
    }
    return { id: g.canonicalKey, canonicalKey: g.canonicalKey, displayName: g.displayName,
      supportedModes: modality.modality === "both" ? ["online", "onsite"] : modality.modality === "unresolved" ? [] : [modality.modality],
      qualifications: g.members.flatMap(m => roster.qualifications.get(m.wiseTeacherId)?.qualifications ?? []),
      wiseRecords: g.members.map(m => ({ wiseTeacherId: m.wiseTeacherId, wiseDisplayName: m.wiseDisplayName, isOnline: m.isOnlineVariant })),
      availabilityWindows: windows, leaves, leavesCompleteThrough: new Date(`${addBangkokDays(query.date, 1)}T00:00:00+07:00`),
      sessionBlocks: blocks.filter(b => g.members.some(m => m.wiseTeacherId === b.wiseTeacherId)), dataIssues };
  });
  return { snapshotId: "thea-live-read", profileVersion: "", builtAt: now, syncedAt: now, tutorGroups: indexed,
    byWeekday: new Map(Array.from({ length: 7 }, (_, day) => [day, indexed])) };
}

export function checkedTheaAvailability(value: WiseAvailabilityResponse) {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!Array.isArray(value.workingHours?.slots) || !Array.isArray(value.leaves)
    || value.leaves.some(l => !l || typeof l.startTime !== "string" || typeof l.endTime !== "string"
      || !/(?:Z|[+-]\d{2}:\d{2})$/.test(l.startTime) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(l.endTime)
      || !Number.isFinite(Date.parse(l.startTime)) || !Number.isFinite(Date.parse(l.endTime)) || Date.parse(l.endTime) <= Date.parse(l.startTime))
    || value.workingHours.slots.some(w => !(typeof w.day === "number" ? Number.isInteger(w.day) && w.day >= 0 && w.day <= 6
      : typeof w.day === "string" && /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.test(w.day))
      || !time.test(w.startTime) || !(time.test(w.endTime) || w.endTime === "24:00") || w.endTime <= w.startTime)) {
    throw new Error("Wise returned incomplete working hours or leave; availability cannot be confirmed.");
  }
  return value;
}

export function searchTheaAvailability(index: SearchIndex, query: ReadyTheaQuery) {
  const start = new Date(`${query.date}T${query.start}:00+07:00`);
  const end = query.end === "24:00" ? new Date(`${addBangkokDays(query.date, 1)}T00:00:00+07:00`)
    : new Date(`${query.date}T${query.end}:00+07:00`);
  // Absolute overlaps avoid depending on the host timezone in the shared engine's legacy date comparisons.
  const candidates = index.tutorGroups.filter(g => !g.sessionBlocks.some(b => b.isBlocking && b.startTime < end && b.endTime > start)
    && !g.leaves.some(l => l.startTime < end && l.endTime > start)).map(g => ({ ...g, sessionBlocks: [], leaves: [] }));
  const dayOfWeek = new Date(`${query.date}T12:00:00+07:00`).getUTCDay();
  return executeSearch({ ...index, byWeekday: new Map([[dayOfWeek, candidates]]) }, { searchMode: "one_time",
    slots: [{ id: "thea", date: query.date, dayOfWeek, start: query.start, end: query.end, mode: query.mode }], filters: query.filters }).perSlotResults[0];
}

function boundedLines(lines: string[]) {
  const shown: string[] = [];
  for (const line of lines) {
    if (shown.join("\n").length + line.length > 3100) break;
    shown.push(line);
  }
  return shown.join("\n") + (shown.length < lines.length ? `\n…Showing ${shown.length} of ${lines.length}; narrow the question for more.` : "");
}

export async function answerTheaQuery(reader: TheaWiseReader, roster: TheaRoster, query: ReadyTheaQuery) {
  const groups = qualifiedTheaGroups(roster, query);
  if (query.teacher && groups.length !== 1) return `Please use one exact teacher nickname. ${groups.length ? "Matches: " + groups.map(g => g.displayName).join(", ") : "No matching teacher was found."}`;
  const { data: sessions, checkedAt: sessionsAt } = await reader.read(`day:${query.date}`, 2 * 60_000, async () => {
    // Include the preceding day so an overnight lesson cannot look like a free morning.
    const rows = await fetchWiseSessionsForBangkokDates(reader.client, process.env.WISE_INSTITUTE_ID!, [addBangkokDays(query.date, -1), query.date]);
    if (rows.some(s => isBlockingStatus(s.meetingStatus) && !getWiseSessionTeacherUserId(s))) throw new Error("Some Wise sessions have no verified teacher; availability cannot be confirmed.");
    // No student names, class titles or contact details enter this cache or the model.
    return rows.map(s => ({ _id: s._id, userId: getWiseSessionTeacherUserId(s), teacherId: s.teacherId,
      scheduledStartTime: s.scheduledStartTime, scheduledEndTime: s.scheduledEndTime,
      meetingStatus: s.meetingStatus, type: s.type, location: s.location }));
  });
  const availability = new Map<string, WiseAvailabilityResponse>();
  for (const group of groups) for (const member of group.members) {
    if (!member.wiseUserId || availability.has(member.wiseUserId)) continue;
    const { data } = await reader.read(`availability:${member.wiseUserId}:${query.date}`, 10 * 60_000, async () => {
      const result = await fetchTeacherAvailability(reader.client, process.env.WISE_INSTITUTE_ID!, member.wiseUserId!,
        new Date(`${query.date}T00:00:00+07:00`), new Date(`${addBangkokDays(query.date, 1)}T00:00:00+07:00`));
      return checkedTheaAvailability(result);
    });
    availability.set(member.wiseUserId, data);
  }
  if (await reader.invalidatedAt() >= sessionsAt) throw new Error("Wise changed while I checked. Please ask again for a fresh result.");
  const now = new Date(), index = buildTheaIndex(roster, query, sessions, availability, now);
  const stamp = formatBangkokDateTime(new Date(Math.min(...reader.checks.map(d => d.getTime()))));
  const thai = query.language === "th";
  const header = `${query.date} ${query.start}–${query.end} · Bangkok\n${Object.values(query.filters).join(" · ") || (thai ? "ทุกวิชา" : "All subjects")} · ${query.mode}`;
  const footer = `\n${thai ? "ข้อมูล Wise ตรวจสอบตั้งแต่" : "Wise data checked from"} ${stamp}.\n${thai ? "ผลการตรวจสอบไม่ใช่การจองเวลา" : "This is an availability check, not a booking."}`;
  if (query.intent === "schedule") {
    const g = index.tutorGroups[0];
    if (g.dataIssues.some(i => i.type === "identity" || i.type === "availability")) throw new Error("This teacher's identity or working hours need review.");
    const time = (d: Date) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }).format(d);
    const start = new Date(`${query.date}T${query.start}:00+07:00`), end = new Date(`${query.date}T${query.end}:00+07:00`);
    const status = new Map(sessions.map(s => [s._id, s.meetingStatus?.toUpperCase()]));
    const rows = g.sessionBlocks.filter(b => !["CANCELLED", "CANCELED"].includes(status.get(b.wiseSessionId!) ?? "")
      && b.startTime < end && b.endTime > start).sort((a, b) => +a.startTime - +b.startTime)
      .map(b => `${time(b.startTime)}–${time(b.endTime)} ${thai ? "มีสอน" : "Class"}${b.location ? ` · ${b.location}` : ""}`);
    rows.push(...g.leaves.filter(l => l.startTime < end && l.endTime > start).map(l => `${time(l.startTime)}–${time(l.endTime)} ${thai ? "ลา" : "Leave"}`));
    return `${header}\n${g.displayName}\n${boundedLines(rows) || (thai ? "ไม่พบชั้นเรียนในช่วงเวลานี้ (ไม่ได้หมายความว่าว่างทั้งช่วง)" : "No classes found in this window (this does not mean the whole window is available).")}${footer}`;
  }
  const slot = searchTheaAvailability(index, query);
  const names = slot.available.map(t => `${t.displayName} (${[...new Set(t.qualifications.filter(q => !query.filters.subject || q.subject === query.filters.subject)
    .map(q => `${q.subject} / ${q.curriculum} / ${q.level}`))].join("; ")})`);
  const review = slot.needsReview.length ? `\n${thai ? "ยังยืนยันไม่ได้ ต้องตรวจสอบ" : "Not confirmed; needs review"}: ${slot.needsReview.map(t => t.displayName).join(", ")}` : "";
  return `${header}\n${thai ? "ครูที่ว่าง" : "Available teachers"}:\n${boundedLines(names) || (thai ? "ไม่พบครูที่ยืนยันได้ว่าว่างและตรงเงื่อนไข" : "No verified available matches.")}${review}${footer}`;
}

import { eq, inArray } from "drizzle-orm";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { ensureIndex, type IndexedTutorGroup } from "@/lib/search/index";
import {
  blocksHead,
  headOfficeWindow,
  indexIsStale,
  readCalendar,
  type OfficeContext,
} from "./availability";
import {
  HiringError,
  instant,
  localDate,
  overlap,
  shiftDate,
  weekStart,
  type HiringConfig,
  type Subject,
} from "./model";

export type HeadBlock = {
  kind: "wise" | "leave" | "mock" | "exam" | "sit_in";
  /** Bangkok time of day, "HH:mm", clipped to the day. */
  start: string;
  end: string;
  candidateId?: string;
  candidate?: string;
  subject?: Subject;
  clash: boolean;
};
export type HeadWeek = {
  key: string;
  name: string;
  subjects: Subject[];
  weekStart: string;
  mocks: number;
  limit: number;
  stale: boolean;
  days: {
    date: string;
    office: { start: string; end: string } | null;
    blocks: HeadBlock[];
  }[];
  visits: {
    candidateId: string;
    candidate: string;
    subject: Subject;
    examStart: string;
    mockStart: string;
    mockEnd: string;
    clash: boolean;
  }[];
};
type BookingRow = {
  candidateId: string;
  kind: "paper" | "mock";
  subjects: Subject[];
  status: string;
  visitId: string | null;
  interviewerKey: string | null;
  startTime: Date;
  endTime: Date;
};
type SitIn = { observerCanonicalKey: string; startTime: Date; endTime: Date };
type Range = { start: Date; end: Date };

/**
 * True when a Wise class, leave or sit-in covers the range. This is the one clash rule: the calendar and the
 * candidate table both use it. It follows the same blocks that `availableVisitSlots` checks before booking.
 */
function headBusy(
  group: Pick<IndexedTutorGroup, "leaves" | "sessionBlocks"> | null | undefined,
  sitIns: SitIn[],
  range: Range,
) {
  return (
    !!group?.sessionBlocks.some(
      (b) => b.isBlocking && overlap(range, { start: b.startTime, end: b.endTime }),
    ) ||
    !!group?.leaves.some((l) =>
      overlap(range, { start: l.startTime, end: l.endTime }),
    ) ||
    sitIns.some((o) => overlap(range, { start: o.startTime, end: o.endTime }))
  );
}
const hm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/**
 * One head's Monday–Friday. Pure. Blocks are built from times and kind only: a Wise class never carries a
 * title or student, and a sit-in never carries its lesson. Only mock and exam blocks name the candidate.
 * A clash is a mock that overlaps a class, leave or sit-in. An exam never needs the head, so it never clashes.
 * Every confirmed mock with this head counts, old flow or new, because each one uses the head's hour.
 */
export function buildHeadWeek(input: {
  head: HiringConfig["interviewers"][number];
  name: string;
  weekStart: string;
  limit: number;
  ctx: OfficeContext;
  group: IndexedTutorGroup | null;
  bookings: BookingRow[];
  observations: SitIn[];
  names: Map<string, string>;
  stale: boolean;
}): HeadWeek {
  const { head, group, weekStart: ws } = input;
  const key = head.canonicalKey;
  const confirmed = input.bookings.filter((b) => b.status === "confirmed");
  const mocks = confirmed.filter((b) => b.kind === "mock" && b.interviewerKey === key);
  const visitIds = new Set(mocks.flatMap((m) => (m.visitId ? [m.visitId] : [])));
  const exams = confirmed.filter(
    (b) => b.kind === "paper" && !!b.visitId && visitIds.has(b.visitId),
  );
  const sitIns = input.observations.filter((o) => o.observerCanonicalKey === key);
  const clash = (m: BookingRow) =>
    headBusy(group, sitIns, { start: m.startTime, end: m.endTime });
  const nameOf = (id: string) => input.names.get(id) ?? "Candidate";
  const inWeek = (d: Date) => weekStart(localDate(d)) === ws;

  const days = Array.from({ length: 5 }, (_, i) => {
    const date = shiftDate(ws, i);
    const dayStart = instant(date, 0);
    const day = { start: dayStart, end: new Date(dayStart.getTime() + 86400000) };
    const cut = (
      kind: HeadBlock["kind"],
      span: { startTime: Date; endTime: Date },
      extra: Partial<HeadBlock> = {},
    ): HeadBlock[] =>
      overlap(day, { start: span.startTime, end: span.endTime })
        ? [
            {
              kind,
              start: hm(Math.max(0, Math.round((span.startTime.getTime() - dayStart.getTime()) / 60000))),
              end: hm(Math.min(1440, Math.round((span.endTime.getTime() - dayStart.getTime()) / 60000))),
              ...extra,
              clash: extra.clash ?? false,
            },
          ]
        : [];
    const booked = (kind: "exam" | "mock", rows: BookingRow[]) =>
      rows.flatMap((b) =>
        cut(kind, b, {
          candidateId: b.candidateId,
          candidate: nameOf(b.candidateId),
          subject: b.subjects[0],
          clash: kind === "mock" && clash(b),
        }),
      );
    const blocks = [
      ...(group?.sessionBlocks.filter((b) => b.isBlocking).flatMap((b) => cut("wise", b)) ?? []),
      ...(group?.leaves.flatMap((l) => cut("leave", l)) ?? []),
      ...sitIns.flatMap((o) => cut("sit_in", o)),
      ...booked("exam", exams),
      ...booked("mock", mocks),
    ].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
    return { date, office: headOfficeWindow(head, date, input.ctx), blocks };
  });

  const visits = mocks
    .filter((m) => m.visitId && inWeek(m.startTime))
    .flatMap((m) => {
      const exam = exams.find((e) => e.visitId === m.visitId);
      return exam
        ? [
            {
              candidateId: m.candidateId,
              candidate: nameOf(m.candidateId),
              subject: m.subjects[0],
              examStart: exam.startTime.toISOString(),
              mockStart: m.startTime.toISOString(),
              mockEnd: m.endTime.toISOString(),
              clash: clash(m),
            },
          ]
        : [];
    })
    .sort((a, b) => a.mockStart.localeCompare(b.mockStart));
  return {
    key,
    name: input.name,
    subjects: head.subjects,
    weekStart: ws,
    mocks: mocks.filter((m) => inWeek(m.startTime)).length,
    limit: input.limit,
    stale: input.stale,
    days,
    visits,
  };
}

// A missing index is stale data, not a failed page: the saved hours and bookings still show.
const readIndex = (db: Database) =>
  ensureIndex(db).catch((error) => {
    console.error("Head schedule could not read the Wise index", error instanceof Error ? error.name : "UnknownError");
    return null;
  });

/**
 * One head's week for the Head schedules view. Reads the settings-independent calendar tables (six small
 * selects, one for candidate names) and the warm in-memory index. Stale or missing Wise data sets `stale`;
 * it never hides the week. Refuses an unknown head (404) and a week before the current one (400), because
 * Wise omits past sessions.
 */
export async function headWeek(
  db: Database,
  config: HiringConfig,
  key: string,
  weekStartDate: string,
  now = new Date(),
): Promise<HeadWeek> {
  const head = config.interviewers.find((h) => h.canonicalKey === key);
  if (!head) throw new HiringError(404, "Head not found.");
  const ws = weekStart(weekStartDate);
  if (ws < weekStart(localDate(now)))
    throw new HiringError(400, "Choose this week or a later week.");
  const calendar = await readCalendar(db);
  const index = await readIndex(db);
  const group = index?.tutorGroups.find((g) => g.canonicalKey === key) ?? null;
  const ids = [
    ...new Set(
      calendar.bookings
        .filter((b) => b.kind === "mock" && b.interviewerKey === key)
        .map((b) => b.candidateId),
    ),
  ];
  const people = ids.length
    ? await db
        .select({ id: s.hiringCandidates.id, name: s.hiringCandidates.name })
        .from(s.hiringCandidates)
        .where(inArray(s.hiringCandidates.id, ids))
    : [];
  const weekEnd = instant(shiftDate(ws, 5), 0);
  return buildHeadWeek({
    head,
    name: group?.displayName ?? key,
    weekStart: ws,
    limit: config.onsiteLimits.perHeadPerWeek,
    ctx: calendar,
    group,
    bookings: calendar.bookings,
    observations: calendar.observations,
    names: new Map(people.map((p) => [p.id, p.name])),
    stale:
      !index ||
      indexIsStale(index, now) ||
      !group ||
      blocksHead(group.dataIssues) ||
      !group.leavesCompleteThrough ||
      group.leavesCompleteThrough < weekEnd,
  });
}

/**
 * The candidates whose booked mock now clashes, for the table's clash marker. `bookings` is the list the
 * dashboard already loaded, so this adds no booking query. With no upcoming mock it reads nothing. Otherwise
 * it costs one read of the warm in-memory index for all heads together (a cold index builds once, as for
 * any search) and one select of current sit-ins. A missing or old index returns `stale`, never an error.
 */
export async function visitClashes(
  db: Database,
  bookings: Pick<BookingRow, "candidateId" | "kind" | "status" | "interviewerKey" | "startTime" | "endTime">[],
  now = new Date(),
): Promise<{ candidateIds: string[]; stale: boolean }> {
  const upcoming = bookings.filter(
    (b) => b.status === "confirmed" && b.kind === "mock" && !!b.interviewerKey && b.endTime > now,
  );
  if (!upcoming.length) return { candidateIds: [], stale: false };
  const index = await readIndex(db);
  if (!index) return { candidateIds: [], stale: true };
  const observations = await db
    .select()
    .from(s.tutorSitInObservations)
    .where(eq(s.tutorSitInObservations.current, true));
  let stale = indexIsStale(index, now);
  const ids = new Set<string>();
  for (const b of upcoming) {
    const group = index.tutorGroups.find((g) => g.canonicalKey === b.interviewerKey);
    if (!group) stale = true;
    if (
      headBusy(
        group,
        observations.filter((o) => o.observerCanonicalKey === b.interviewerKey),
        { start: b.startTime, end: b.endTime },
      )
    )
      ids.add(b.candidateId);
  }
  return { candidateIds: [...ids], stale };
}

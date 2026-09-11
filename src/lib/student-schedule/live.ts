import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { fetchInstituteSessionsForDays, type WiseCreditSession } from "@/lib/credit-control/wise";
import { abortableDelay, createWiseClient } from "@/lib/wise/client";
import { getMonthWindow } from "@/lib/calendar/month-grid";
import { addBangkokDays, datesBetweenBangkok, todayBangkok } from "@/lib/room-capacity/dates";
import { createLiveMonthCache, type LiveMonthCache, type LiveMonthEntry } from "./live-cache";

export function studentScheduleLiveEnabled(): boolean {
  return process.env.ENABLE_STUDENT_SCHEDULE_LIVE !== "false";
}

export interface LiveMonthResult {
  sessions: WiseCreditSession[];
  ok: boolean;
  source?: "wise" | "cache";
  sourceAt?: Date;
  stale?: boolean;
}

function complete(entry: LiveMonthEntry | null): entry is LiveMonthEntry & { sessions: WiseCreditSession[]; fetchedAt: Date } {
  return entry?.sessions !== null && entry?.sessions !== undefined && entry.fetchedAt !== null;
}

/** Deadline races even a stalled transport, while its AbortSignal cancels queued/retrying calls. */
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function fetchLiveMonthSessions({
  wiseStudentId, monthKey, deadlineMs = 8_000, forceRefresh = false, cache, signal: callerSignal,
}: {
  wiseStudentId: string;
  monthKey: string;
  deadlineMs?: number;
  forceRefresh?: boolean;
  cache?: LiveMonthCache;
  signal?: AbortSignal;
}): Promise<LiveMonthResult> {
  if (!studentScheduleLiveEnabled()) return { sessions: [], ok: false };
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const key = `v1:${instituteId}:${monthKey}`;
  const requestedAt = new Date();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Schedule refresh timed out")), deadlineMs);
  const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
  let previous: LiveMonthEntry | null = null;
  let lease: string | null = null;
  let repository: LiveMonthCache | undefined;
  const project = (entry: LiveMonthEntry & { sessions: WiseCreditSession[]; fetchedAt: Date }, source: "wise" | "cache", stale: boolean): LiveMonthResult => ({
    // The institute-wide cache is never returned to a route or caller.
    sessions: entry.sessions.filter(session => session.students.includes(wiseStudentId)),
    ok: true, source, sourceAt: entry.fetchedAt, stale,
  });
  try {
    repository = cache ?? createLiveMonthCache(getDb());
    while (true) {
      signal.throwIfAborted();
      previous = await untilAbort(repository.read(key), signal);
      const now = new Date();
      if (complete(previous) && now.getTime() - previous.fetchedAt.getTime() < 60_000
        && (!forceRefresh || (previous.publishedAt && previous.publishedAt >= requestedAt))) {
        return project(previous, "cache", false);
      }
      if (previous?.retryAfter && previous.retryAfter > now) throw new Error("Schedule refresh is cooling down");
      const token = randomUUID();
      if (await untilAbort(repository.claim(key, token, now, forceRefresh, requestedAt), signal)) {
        lease = token;
        signal.throwIfAborted();
        const fetchedAt = new Date();
        const { from, to } = getMonthWindow(monthKey);
        const days = datesBetweenBangkok(addBangkokDays(from, -1), addBangkokDays(to, 1));
        const client = createWiseClient({ signal });
        const sessions = await untilAbort(fetchInstituteSessionsForDays(client, instituteId, days, todayBangkok(), { signal }), signal);
        signal.throwIfAborted();
        const saved = await untilAbort(repository.publish(key, token, sessions, fetchedAt), signal);
        if (!saved) throw new Error("Schedule refresh lease expired");
        lease = null;
        return project({ sessions, fetchedAt, publishedAt: new Date(), retryAfter: null }, "wise", false);
      }
      await abortableDelay(150, signal);
    }
  } catch {
    controller.abort();
    // A failed cache/lease store never falls through to an uncoordinated Wise sweep.
    if (lease && repository) await repository.fail(key, lease).catch(() => undefined);
    return complete(previous) ? project(previous, "cache", true) : { sessions: [], ok: false };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

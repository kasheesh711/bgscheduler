import { and, eq, inArray, sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { workforceBookingClassifications as bookings, workforceCourseLifecycleEvents as lifecycle } from "@/lib/db/schema";
import { workforceContentHash } from "../observations";
import { loadWorkforceEvidenceInTransaction } from "../source-db";
import type { GrowthBookingMetadata, GrowthEvidence, GrowthLifecycleEvent } from "./types";
import { normalizeGrowthBookingMetadata } from "./source";
import { resolveAcademicSubject } from "../subject-mappings";

const CHUNK = 500;
const payload = (value: object): Record<string, unknown> => value as Record<string, unknown>;
function metadataHash(row: GrowthBookingMetadata): string {
  return workforceContentHash({ ...row, observedAt: undefined });
}
function lifecycleHash(row: GrowthLifecycleEvent): string {
  return workforceContentHash({ ...row, revision: undefined, evidenceRevision: undefined, confirmedAt: undefined });
}

export async function storeGrowthBookingMetadata(db: Database, rows: GrowthBookingMetadata[]): Promise<void> {
  if (!rows.length) return;
  await withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('workforce-growth-bookings'))`);
    const ids = [...new Set(rows.map(r => r.wiseSessionId))];
    for (let offset = 0; offset < ids.length; offset += CHUNK) {
      const batch = ids.slice(offset, offset + CHUNK), batchIds = new Set(batch);
      const existing = await tx.select().from(bookings).where(inArray(bookings.wiseSessionId, batch));
      const versions = new Map<string, Array<{ revision: number; contentHash: string; observedAt: Date; isCurrent: boolean }>>();
      for (const row of existing) versions.set(row.wiseSessionId, [...(versions.get(row.wiseSessionId) ?? []), row]);
      const pending: Array<typeof bookings.$inferInsert> = [];
      const changed = new Set<string>();
      for (const row of rows.filter(r => batchIds.has(r.wiseSessionId)).sort((a,b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))) {
        const observedAt = new Date(row.observedAt);
        if (!Number.isFinite(observedAt.getTime())) throw new Error("Invalid growth metadata time");
        const list = versions.get(row.wiseSessionId) ?? [], current = list.find(r => r.isCurrent);
        const contentHash = metadataHash(row);
        const newest = !current || observedAt.getTime() >= current.observedAt.getTime();
        if (newest && current?.contentHash === contentHash) continue;
        if (!newest && list.some(r => r.contentHash === contentHash && r.observedAt.getTime() === observedAt.getTime())) continue;
        if (newest) {
          changed.add(row.wiseSessionId);
          for (const version of list) version.isCurrent = false;
          for (const version of pending) if (version.wiseSessionId === row.wiseSessionId) version.isCurrent = false;
        }
        const revision = Math.max(0, ...list.map(r => r.revision)) + 1;
        const version = { wiseSessionId: row.wiseSessionId, revision, contentHash, observedAt, isCurrent: newest, payload: payload(row) };
        pending.push(version);
        list.push(version);
        versions.set(row.wiseSessionId, list);
      }
      if (changed.size) await tx.update(bookings).set({ isCurrent: false }).where(and(eq(bookings.isCurrent, true), inArray(bookings.wiseSessionId, [...changed])));
      if (pending.length) await tx.insert(bookings).values(pending);
    }
  });
}

/** Persist explicit event revisions. Absence from a partial run never deletes a known event. */
export async function reconcileGrowthLifecycleEvents(db: Database, events: GrowthLifecycleEvent[]): Promise<void> {
  if (!events.length) return;
  await withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('workforce-growth-lifecycle'))`);
    const keys = [...new Set(events.map(e => e.eventKey))];
    for (let offset = 0; offset < keys.length; offset += CHUNK) {
      const batch = keys.slice(offset, offset + CHUNK), batchKeys = new Set(batch);
      const existing = await tx.select().from(lifecycle).where(inArray(lifecycle.eventKey, batch));
      const latest = new Map(existing.filter(e => e.isCurrent).map(e => [e.eventKey, e]));
      const pending: Array<typeof lifecycle.$inferInsert> = [];
      const changed = new Set<string>();
      for (const event of events.filter(e => batchKeys.has(e.eventKey))) {
        const old = latest.get(event.eventKey), contentHash = lifecycleHash(event);
        if (old?.contentHash === contentHash) continue;
        const revision = (old?.revision ?? 0) + 1;
        const row = { eventKey: event.eventKey, revision, studentId: event.studentId, subject: event.subject,
          effectiveMonth: event.effectiveMonth, contentHash, isCurrent: true, payload: payload({ ...event, revision }) };
        for (const earlier of pending) if (earlier.eventKey === event.eventKey) earlier.isCurrent = false;
        pending.push(row);
        latest.set(event.eventKey, { ...row, id: "pending", recordedAt: new Date() });
        changed.add(event.eventKey);
      }
      if (changed.size) await tx.update(lifecycle).set({ isCurrent: false }).where(and(eq(lifecycle.isCurrent, true), inArray(lifecycle.eventKey, [...changed])));
      if (pending.length) await tx.insert(lifecycle).values(pending);
    }
  });
}

export async function loadGrowthEvidence(db: Database, now = new Date()): Promise<GrowthEvidence> {
  return withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    const today = formatInTimeZone(now, "Asia/Bangkok", "yyyy-MM-dd");
    const workforce = await loadWorkforceEvidenceInTransaction(tx, { from: "2026-03-01", to: today, viewMonth: today.slice(0,7), role: "all", modality: "all" }, now);
    const classifications = await tx.select().from(bookings).where(eq(bookings.isCurrent, true));
    const events = await tx.select().from(lifecycle).where(eq(lifecycle.isCurrent, true));
    const retained = new Map(classifications.map(r => [r.wiseSessionId, r.payload as unknown as GrowthBookingMetadata]));
    const bookingMetadata = workforce.sessions.map(session => {
      const prior = retained.get(session.wiseSessionId);
      if (prior?.classification !== "unknown" && prior && !prior.reasonCodes.includes("OWNER_CONFIRMED_TITLE_CLASSIFICATION")) return prior;
      return normalizeGrowthBookingMetadata(session, session.observedAt ?? prior?.observedAt ?? now.toISOString(),
        resolveAcademicSubject({classId:session.wiseClassId, sourceValue:session.classTitle}, workforce.subjectMappings).completeness === "complete");
    });
    return {
      workforce,
      bookingMetadata,
      lifecycleEvents: events.map(r => r.payload as unknown as GrowthLifecycleEvent),
      revision: workforceContentHash({ workforce: workforce.revision, classifications: classifications.map(r => [r.id, r.revision]).sort(), events: events.map(r => [r.id,r.revision]).sort() }),
    };
  });
}

# Tutor Schedule Compare Implementation Plan

## Status Update (2026-04-08)

This plan has been implemented. The shipped UI differs slightly from the original execution plan:

- Compare is embedded in `/search` with `/compare` redirect compatibility.
- Discovery shipped as a modal dialog instead of a persistent side panel.
- Weekly compare now uses lane-based rendering for 2-3 tutors and full-width cards for a single tutor.
- Compare session styling now uses explicit RGBA fills plus per-session modality evidence carried from Wise-derived identity/session data.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated `/compare` page with Google Calendar-style side-by-side tutor schedule view, automated student-level conflict detection, a discovery panel for finding candidate tutors, and a bridge from the existing search page.

**Architecture:** New compare engine (`src/lib/search/compare.ts`) reads from the existing in-memory `SearchIndex` singleton — no new DB queries. Two new API routes expose compare and discover endpoints. The compare page is a client-side component that renders a GCal-style calendar grid with positioned session blocks. Conflict detection runs client-side from the API response.

**Tech Stack:** Next.js 16 App Router, React, TypeScript, Tailwind CSS, shadcn/ui (Popover, Badge, Button), Vitest

---

### Task 1: Compare Types

**Files:**
- Modify: `src/lib/search/types.ts`

- [ ] **Step 1: Add compare-related types to types.ts**

Append to the end of `src/lib/search/types.ts`:

```typescript
// ── Compare types ──────────────────────────────────────────────────

export interface CompareRequest {
  tutorGroupIds: string[];          // 1-3 tutor group IDs
  mode: "recurring" | "one_time";
  dayOfWeek?: number;               // for recurring (0-6)
  date?: string;                    // ISO date for one_time
}

export interface CompareSessionBlock {
  title?: string;
  studentName?: string;
  subject?: string;
  classType?: string;
  recurrenceId?: string;
  location?: string;
  startTime: string;    // "HH:mm"
  endTime: string;      // "HH:mm"
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface CompareTutor {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  qualifications: { subject: string; curriculum: string; level: string; examPrep?: string }[];
  sessions: CompareSessionBlock[];
  availabilityWindows: { weekday: number; startMinute: number; endMinute: number; modality: string }[];
  leaves: { startTime: string; endTime: string }[];
  dataIssues: { type: string; message: string }[];
  weeklyHoursBooked: number;
  studentCount: number;
}

export interface Conflict {
  studentName: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  tutorA: { tutorGroupId: string; displayName: string; sessionTitle: string };
  tutorB: { tutorGroupId: string; displayName: string; sessionTitle: string };
}

export interface SharedFreeSlot {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface CompareResponse {
  snapshotMeta: SnapshotMeta;
  tutors: CompareTutor[];
  conflicts: Conflict[];
  sharedFreeSlots: SharedFreeSlot[];
  latencyMs: number;
  warnings: string[];
}

export interface DiscoverRequest {
  existingTutorGroupIds: string[];
  mode: "recurring" | "one_time";
  dayOfWeek?: number;
  date?: string;
  startTime?: string;    // "HH:mm"
  endTime?: string;      // "HH:mm"
  modeFilter?: "online" | "onsite" | "either";
  filters?: SearchFilters;
}

export interface DiscoverCandidate {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  qualifications: { subject: string; curriculum: string; level: string; examPrep?: string }[];
  conflictCount: number;
  conflicts: Conflict[];
  freeSlots: { start: string; end: string }[];
  hasDataIssues: boolean;
  dataIssueReasons: string[];
}

export interface DiscoverResponse {
  snapshotMeta: SnapshotMeta;
  candidates: DiscoverCandidate[];
  latencyMs: number;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to types.ts

- [ ] **Step 3: Commit**

```bash
git add src/lib/search/types.ts
git commit -m "feat(compare): add compare and discover type definitions"
```

---

### Task 2: Compare Engine — Core Logic

**Files:**
- Create: `src/lib/search/compare.ts`
- Test: `src/lib/search/__tests__/compare.test.ts`

- [ ] **Step 1: Write failing tests for `buildCompareTutor`**

Create `src/lib/search/__tests__/compare.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildCompareTutor, detectConflicts, findSharedFreeSlots } from "../compare";
import type { IndexedTutorGroup, SearchIndex } from "../index";

function makeTutor(overrides: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup {
  return {
    id: "g1",
    displayName: "Test Tutor",
    supportedModes: ["online", "onsite"],
    qualifications: [{ subject: "Math", curriculum: "International", level: "Y2-8" }],
    wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Test Tutor", isOnline: false }],
    availabilityWindows: [
      { weekday: 1, startMinute: 540, endMinute: 1020, modality: "both", wiseTeacherId: "t1" },
    ],
    leaves: [],
    sessionBlocks: [],
    dataIssues: [],
    ...overrides,
  };
}

function makeIndex(tutors: IndexedTutorGroup[]): SearchIndex {
  const byWeekday = new Map<number, IndexedTutorGroup[]>();
  for (const t of tutors) {
    for (const w of t.availabilityWindows) {
      if (!byWeekday.has(w.weekday)) byWeekday.set(w.weekday, []);
      byWeekday.get(w.weekday)!.push(t);
    }
  }
  return { snapshotId: "snap-1", builtAt: new Date(), tutorGroups: tutors, byWeekday };
}

describe("buildCompareTutor", () => {
  it("returns all sessions for the specified weekday", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        {
          startTime: new Date("2024-01-15T09:00:00"),
          endTime: new Date("2024-01-15T10:00:00"),
          weekday: 1, startMinute: 540, endMinute: 600,
          isBlocking: true, wiseTeacherId: "t1",
          studentName: "Ava T.", subject: "Math",
          title: "Math - Ava T.", classType: "ONE_TO_ONE",
        },
        {
          startTime: new Date("2024-01-16T14:00:00"),
          endTime: new Date("2024-01-16T15:00:00"),
          weekday: 2, startMinute: 840, endMinute: 900,
          isBlocking: true, wiseTeacherId: "t1",
          studentName: "Ben K.", subject: "English",
        },
      ],
    });

    const result = buildCompareTutor(tutor, [1]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].studentName).toBe("Ava T.");
    expect(result.sessions[0].weekday).toBe(1);
  });

  it("returns all sessions when no weekday filter (full week)", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        {
          startTime: new Date("2024-01-15T09:00:00"),
          endTime: new Date("2024-01-15T10:00:00"),
          weekday: 1, startMinute: 540, endMinute: 600,
          isBlocking: true, wiseTeacherId: "t1",
          studentName: "Ava T.", subject: "Math",
        },
        {
          startTime: new Date("2024-01-16T14:00:00"),
          endTime: new Date("2024-01-16T15:00:00"),
          weekday: 2, startMinute: 840, endMinute: 900,
          isBlocking: true, wiseTeacherId: "t1",
          studentName: "Ben K.", subject: "English",
        },
      ],
    });

    const result = buildCompareTutor(tutor);
    expect(result.sessions).toHaveLength(2);
  });

  it("computes weeklyHoursBooked from all session blocks", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        {
          startTime: new Date("2024-01-15T09:00:00"),
          endTime: new Date("2024-01-15T10:00:00"),
          weekday: 1, startMinute: 540, endMinute: 600,
          isBlocking: true, wiseTeacherId: "t1",
          studentName: "Ava T.", subject: "Math",
        },
        {
          startTime: new Date("2024-01-15T10:00:00"),
          endTime: new Date("2024-01-15T11:30:00"),
          weekday: 1, startMinute: 600, endMinute: 690,
          isBlocking: true, wiseTeacherId: "t1",
          studentName: "Ben K.", subject: "English",
        },
      ],
    });

    const result = buildCompareTutor(tutor);
    // 60min + 90min = 150min = 2.5 hours
    expect(result.weeklyHoursBooked).toBe(2.5);
  });

  it("computes distinct studentCount", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        {
          startTime: new Date("2024-01-15T09:00:00"),
          endTime: new Date("2024-01-15T10:00:00"),
          weekday: 1, startMinute: 540, endMinute: 600,
          isBlocking: true, wiseTeacherId: "t1",
          studentName: "Ava T.", subject: "Math",
        },
        {
          startTime: new Date("2024-01-16T10:00:00"),
          endTime: new Date("2024-01-16T11:00:00"),
          weekday: 2, startMinute: 600, endMinute: 660,
          isBlocking: true, wiseTeacherId: "t1",
          studentName: "Ava T.", subject: "English",
        },
        {
          startTime: new Date("2024-01-17T14:00:00"),
          endTime: new Date("2024-01-17T15:00:00"),
          weekday: 3, startMinute: 840, endMinute: 900,
          isBlocking: true, wiseTeacherId: "t1",
          studentName: "Ben K.", subject: "Math",
        },
      ],
    });

    const result = buildCompareTutor(tutor);
    expect(result.studentCount).toBe(2);
  });
});

describe("detectConflicts", () => {
  it("detects conflict when same student appears in overlapping slots across tutors", () => {
    const tutorA = makeTutor({
      id: "g1", displayName: "Kevin H.",
      sessionBlocks: [{
        startTime: new Date("2024-01-15T11:00:00"),
        endTime: new Date("2024-01-15T12:00:00"),
        weekday: 1, startMinute: 660, endMinute: 720,
        isBlocking: true, wiseTeacherId: "t1",
        studentName: "Ava T.", subject: "English",
        title: "English - Ava T.",
      }],
    });
    const tutorB = makeTutor({
      id: "g2", displayName: "Samantha W.",
      sessionBlocks: [{
        startTime: new Date("2024-01-15T11:00:00"),
        endTime: new Date("2024-01-15T12:00:00"),
        weekday: 1, startMinute: 660, endMinute: 720,
        isBlocking: true, wiseTeacherId: "t2",
        studentName: "Ava T.", subject: "Math",
        title: "Math - Ava T.",
      }],
    });

    const conflicts = detectConflicts(
      [buildCompareTutor(tutorA), buildCompareTutor(tutorB)],
      [tutorA, tutorB],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].studentName).toBe("Ava T.");
    expect(conflicts[0].tutorA.displayName).toBe("Kevin H.");
    expect(conflicts[0].tutorB.displayName).toBe("Samantha W.");
  });

  it("returns no conflicts when students are different", () => {
    const tutorA = makeTutor({
      id: "g1", displayName: "Kevin H.",
      sessionBlocks: [{
        startTime: new Date("2024-01-15T11:00:00"),
        endTime: new Date("2024-01-15T12:00:00"),
        weekday: 1, startMinute: 660, endMinute: 720,
        isBlocking: true, wiseTeacherId: "t1",
        studentName: "Ava T.", subject: "English",
      }],
    });
    const tutorB = makeTutor({
      id: "g2", displayName: "Samantha W.",
      sessionBlocks: [{
        startTime: new Date("2024-01-15T11:00:00"),
        endTime: new Date("2024-01-15T12:00:00"),
        weekday: 1, startMinute: 660, endMinute: 720,
        isBlocking: true, wiseTeacherId: "t2",
        studentName: "Ben K.", subject: "Math",
      }],
    });

    const conflicts = detectConflicts(
      [buildCompareTutor(tutorA), buildCompareTutor(tutorB)],
      [tutorA, tutorB],
    );
    expect(conflicts).toHaveLength(0);
  });

  it("returns no conflicts when times don't overlap", () => {
    const tutorA = makeTutor({
      id: "g1", displayName: "Kevin H.",
      sessionBlocks: [{
        startTime: new Date("2024-01-15T09:00:00"),
        endTime: new Date("2024-01-15T10:00:00"),
        weekday: 1, startMinute: 540, endMinute: 600,
        isBlocking: true, wiseTeacherId: "t1",
        studentName: "Ava T.", subject: "Math",
      }],
    });
    const tutorB = makeTutor({
      id: "g2", displayName: "Samantha W.",
      sessionBlocks: [{
        startTime: new Date("2024-01-15T11:00:00"),
        endTime: new Date("2024-01-15T12:00:00"),
        weekday: 1, startMinute: 660, endMinute: 720,
        isBlocking: true, wiseTeacherId: "t2",
        studentName: "Ava T.", subject: "English",
      }],
    });

    const conflicts = detectConflicts(
      [buildCompareTutor(tutorA), buildCompareTutor(tutorB)],
      [tutorA, tutorB],
    );
    expect(conflicts).toHaveLength(0);
  });
});

describe("findSharedFreeSlots", () => {
  it("finds shared free time on a given weekday", () => {
    const tutorA = makeTutor({
      id: "g1",
      availabilityWindows: [
        { weekday: 1, startMinute: 540, endMinute: 720, modality: "both", wiseTeacherId: "t1" },
      ],
      sessionBlocks: [{
        startTime: new Date("2024-01-15T09:00:00"),
        endTime: new Date("2024-01-15T10:00:00"),
        weekday: 1, startMinute: 540, endMinute: 600,
        isBlocking: true, wiseTeacherId: "t1",
      }],
    });
    const tutorB = makeTutor({
      id: "g2",
      availabilityWindows: [
        { weekday: 1, startMinute: 600, endMinute: 780, modality: "both", wiseTeacherId: "t2" },
      ],
      sessionBlocks: [],
    });

    // A is free 10:00-12:00 (600-720), B is free 10:00-13:00 (600-780)
    // Shared free: 10:00-12:00 (600-720) — intersection of both
    const slots = findSharedFreeSlots([tutorA, tutorB], [1]);
    expect(slots.length).toBeGreaterThanOrEqual(1);
    expect(slots[0].dayOfWeek).toBe(1);
    expect(slots[0].startMinute).toBe(600);
    expect(slots[0].endMinute).toBe(720);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/search/__tests__/compare.test.ts 2>&1 | tail -20`
Expected: FAIL — module `../compare` not found

- [ ] **Step 3: Implement compare engine**

Create `src/lib/search/compare.ts`:

```typescript
import type { IndexedTutorGroup } from "./index";
import type {
  CompareTutor,
  CompareSessionBlock,
  Conflict,
  SharedFreeSlot,
} from "./types";

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Build a CompareTutor from an IndexedTutorGroup.
 * If weekdays is provided, only include sessions on those days.
 */
export function buildCompareTutor(
  group: IndexedTutorGroup,
  weekdays?: number[],
): CompareTutor {
  const weekdaySet = weekdays ? new Set(weekdays) : null;

  const sessions: CompareSessionBlock[] = group.sessionBlocks
    .filter((s) => s.isBlocking && (!weekdaySet || weekdaySet.has(s.weekday)))
    .map((s) => ({
      title: s.title,
      studentName: s.studentName,
      subject: s.subject,
      classType: s.classType,
      recurrenceId: s.recurrenceId,
      location: s.location,
      startTime: formatMinute(s.startMinute),
      endTime: formatMinute(s.endMinute),
      weekday: s.weekday,
      startMinute: s.startMinute,
      endMinute: s.endMinute,
    }));

  // Compute stats from ALL sessions (not filtered by weekday)
  const allBlockingSessions = group.sessionBlocks.filter((s) => s.isBlocking);
  const totalMinutes = allBlockingSessions.reduce(
    (sum, s) => sum + (s.endMinute - s.startMinute),
    0,
  );
  const studentNames = new Set(
    allBlockingSessions.map((s) => s.studentName).filter(Boolean),
  );

  return {
    tutorGroupId: group.id,
    displayName: group.displayName,
    supportedModes: group.supportedModes,
    qualifications: group.qualifications,
    sessions,
    availabilityWindows: group.availabilityWindows.map((w) => ({
      weekday: w.weekday,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
      modality: w.modality,
    })),
    leaves: group.leaves.map((l) => ({
      startTime: l.startTime.toISOString(),
      endTime: l.endTime.toISOString(),
    })),
    dataIssues: group.dataIssues,
    weeklyHoursBooked: Math.round((totalMinutes / 60) * 100) / 100,
    studentCount: studentNames.size,
  };
}

/**
 * Detect student-level conflicts: same student has overlapping sessions
 * across different selected tutors.
 */
export function detectConflicts(
  compareTutors: CompareTutor[],
  indexedGroups: IndexedTutorGroup[],
): Conflict[] {
  const conflicts: Conflict[] = [];

  // Build a map: studentName → list of { tutorIndex, session }
  const studentSessions = new Map<
    string,
    { tutorIdx: number; session: CompareSessionBlock }[]
  >();

  for (let i = 0; i < compareTutors.length; i++) {
    for (const session of compareTutors[i].sessions) {
      if (!session.studentName) continue;
      const key = session.studentName.toLowerCase();
      if (!studentSessions.has(key)) studentSessions.set(key, []);
      studentSessions.get(key)!.push({ tutorIdx: i, session });
    }
  }

  // For each student, check for overlapping sessions across different tutors
  const seen = new Set<string>();

  for (const [, entries] of studentSessions) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];

        // Must be different tutors
        if (a.tutorIdx === b.tutorIdx) continue;

        // Must be same weekday
        if (a.session.weekday !== b.session.weekday) continue;

        // Check time overlap
        if (
          a.session.startMinute < b.session.endMinute &&
          a.session.endMinute > b.session.startMinute
        ) {
          // Dedup by student+day+time+tutor pair
          const dedup = [
            a.session.studentName,
            a.session.weekday,
            Math.min(a.tutorIdx, b.tutorIdx),
            Math.max(a.tutorIdx, b.tutorIdx),
          ].join("|");

          if (seen.has(dedup)) continue;
          seen.add(dedup);

          const overlapStart = Math.max(a.session.startMinute, b.session.startMinute);
          const overlapEnd = Math.min(a.session.endMinute, b.session.endMinute);

          conflicts.push({
            studentName: a.session.studentName!,
            dayOfWeek: a.session.weekday,
            startMinute: overlapStart,
            endMinute: overlapEnd,
            tutorA: {
              tutorGroupId: compareTutors[a.tutorIdx].tutorGroupId,
              displayName: compareTutors[a.tutorIdx].displayName,
              sessionTitle: a.session.title ?? `${a.session.subject ?? "Session"} — ${a.session.studentName}`,
            },
            tutorB: {
              tutorGroupId: compareTutors[b.tutorIdx].tutorGroupId,
              displayName: compareTutors[b.tutorIdx].displayName,
              sessionTitle: b.session.title ?? `${b.session.subject ?? "Session"} — ${b.session.studentName}`,
            },
          });
        }
      }
    }
  }

  return conflicts;
}

/**
 * Find time ranges where ALL tutors are simultaneously free on given weekdays.
 * Free = has an availability window AND no blocking session at that time.
 */
export function findSharedFreeSlots(
  groups: IndexedTutorGroup[],
  weekdays: number[],
): SharedFreeSlot[] {
  if (groups.length === 0) return [];

  const results: SharedFreeSlot[] = [];

  for (const weekday of weekdays) {
    // For each tutor, compute free intervals on this weekday
    const freePerTutor: { start: number; end: number }[][] = [];

    for (const group of groups) {
      // Get availability windows for this weekday
      const windows = group.availabilityWindows.filter((w) => w.weekday === weekday);
      if (windows.length === 0) {
        freePerTutor.push([]);
        continue;
      }

      // Get blocking sessions for this weekday
      const blocks = group.sessionBlocks
        .filter((s) => s.isBlocking && s.weekday === weekday)
        .sort((a, b) => a.startMinute - b.startMinute);

      // Subtract blocks from windows
      const free: { start: number; end: number }[] = [];
      for (const w of windows) {
        let cursor = w.startMinute;
        for (const b of blocks) {
          if (b.startMinute >= w.endMinute) break;
          if (b.endMinute <= cursor) continue;
          if (b.startMinute > cursor) {
            free.push({ start: cursor, end: Math.min(b.startMinute, w.endMinute) });
          }
          cursor = Math.max(cursor, b.endMinute);
        }
        if (cursor < w.endMinute) {
          free.push({ start: cursor, end: w.endMinute });
        }
      }

      freePerTutor.push(free);
    }

    // Intersect all tutors' free intervals
    if (freePerTutor.some((f) => f.length === 0)) continue;

    let intersection = freePerTutor[0];
    for (let i = 1; i < freePerTutor.length; i++) {
      intersection = intersectIntervals(intersection, freePerTutor[i]);
    }

    for (const slot of intersection) {
      if (slot.end - slot.start >= 30) {
        results.push({
          dayOfWeek: weekday,
          startMinute: slot.start,
          endMinute: slot.end,
        });
      }
    }
  }

  return results;
}

function intersectIntervals(
  a: { start: number; end: number }[],
  b: { start: number; end: number }[],
): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (start < end) {
      result.push({ start, end });
    }
    if (a[i].end < b[j].end) i++;
    else j++;
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/search/__tests__/compare.test.ts 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/compare.ts src/lib/search/__tests__/compare.test.ts
git commit -m "feat(compare): add compare engine with conflict detection and free slot computation"
```

---

### Task 3: Compare API Route

**Files:**
- Create: `src/app/api/compare/route.ts`

- [ ] **Step 1: Create the compare API route**

Create `src/app/api/compare/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { buildCompareTutor, detectConflicts, findSharedFreeSlots } from "@/lib/search/compare";
import type { CompareResponse, SnapshotMeta } from "@/lib/search/types";

const compareRequestSchema = z.object({
  tutorGroupIds: z.array(z.string()).min(1).max(3),
  mode: z.enum(["recurring", "one_time"]),
  dayOfWeek: z.number().min(0).max(6).optional(),
  date: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = compareRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { tutorGroupIds, mode, dayOfWeek, date } = parsed.data;
  const db = getDb();

  try {
    const startTime = Date.now();
    const index = await ensureIndex(db);
    const warnings: string[] = [];

    const snapshotMeta: SnapshotMeta = {
      snapshotId: index.snapshotId,
      syncedAt: index.builtAt.toISOString(),
      stale: Date.now() - index.builtAt.getTime() > 35 * 60 * 1000,
    };

    if (snapshotMeta.stale) {
      warnings.push("Search data may be stale — last sync was more than 35 minutes ago");
    }

    // Look up the requested tutor groups from the index
    const indexedGroups = tutorGroupIds
      .map((id) => index.tutorGroups.find((g) => g.id === id))
      .filter((g): g is NonNullable<typeof g> => g !== undefined);

    if (indexedGroups.length === 0) {
      return NextResponse.json(
        { error: "No matching tutor groups found in active snapshot" },
        { status: 404 },
      );
    }

    // Determine which weekdays to include
    const weekdays: number[] | undefined =
      dayOfWeek !== undefined
        ? [dayOfWeek]
        : date
          ? [new Date(date).getDay()]
          : undefined; // undefined = all 7 days

    const compareTutors = indexedGroups.map((g) => buildCompareTutor(g, weekdays));
    const conflicts = detectConflicts(compareTutors, indexedGroups);
    const sharedFreeSlots = findSharedFreeSlots(
      indexedGroups,
      weekdays ?? [0, 1, 2, 3, 4, 5, 6],
    );

    const response: CompareResponse = {
      snapshotMeta,
      tutors: compareTutors,
      conflicts,
      sharedFreeSlots,
      latencyMs: Date.now() - startTime,
      warnings,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compare failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify route compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/api/compare/route.ts
git commit -m "feat(compare): add POST /api/compare endpoint"
```

---

### Task 4: Discover API Route

**Files:**
- Create: `src/app/api/compare/discover/route.ts`

- [ ] **Step 1: Create the discover API route**

Create `src/app/api/compare/discover/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { buildCompareTutor, detectConflicts } from "@/lib/search/compare";
import { parseTimeToMinutes } from "@/lib/normalization/timezone";
import type { DiscoverResponse, DiscoverCandidate, SnapshotMeta } from "@/lib/search/types";

const discoverRequestSchema = z.object({
  existingTutorGroupIds: z.array(z.string()).max(2),
  mode: z.enum(["recurring", "one_time"]),
  dayOfWeek: z.number().min(0).max(6).optional(),
  date: z.string().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  modeFilter: z.enum(["online", "onsite", "either"]).optional(),
  filters: z
    .object({
      subject: z.string().optional(),
      curriculum: z.string().optional(),
      level: z.string().optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = discoverRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { existingTutorGroupIds, mode, dayOfWeek, date, startTime, endTime, modeFilter, filters } =
    parsed.data;

  const db = getDb();

  try {
    const start = Date.now();
    const index = await ensureIndex(db);

    const snapshotMeta: SnapshotMeta = {
      snapshotId: index.snapshotId,
      syncedAt: index.builtAt.toISOString(),
      stale: Date.now() - index.builtAt.getTime() > 35 * 60 * 1000,
    };

    const existingSet = new Set(existingTutorGroupIds);
    const existingGroups = existingTutorGroupIds
      .map((id) => index.tutorGroups.find((g) => g.id === id))
      .filter((g): g is NonNullable<typeof g> => g !== undefined);
    const existingCompareTutors = existingGroups.map((g) => buildCompareTutor(g));

    const weekday = dayOfWeek ?? (date ? new Date(date).getDay() : undefined);
    const slotStartMin = startTime ? parseTimeToMinutes(startTime) : undefined;
    const slotEndMin = endTime ? parseTimeToMinutes(endTime) : undefined;

    const candidates: DiscoverCandidate[] = [];

    for (const group of index.tutorGroups) {
      // Skip already-selected tutors
      if (existingSet.has(group.id)) continue;

      // Mode filter
      if (modeFilter && modeFilter !== "either") {
        if (!group.supportedModes.includes(modeFilter)) continue;
      }

      // Qualification filters
      if (filters) {
        const matchesQuals = group.qualifications.some((q) => {
          if (filters.subject && q.subject.toLowerCase() !== filters.subject.toLowerCase()) return false;
          if (filters.curriculum && q.curriculum.toLowerCase() !== filters.curriculum.toLowerCase()) return false;
          if (filters.level && q.level.toLowerCase() !== filters.level.toLowerCase()) return false;
          return true;
        });
        if (!matchesQuals && (filters.subject || filters.curriculum || filters.level)) continue;
      }

      // Check availability at requested time (if specified)
      const freeSlots: { start: string; end: string }[] = [];
      let hasAvailabilityAtRequestedTime = true;

      if (weekday !== undefined && slotStartMin !== undefined && slotEndMin !== undefined) {
        // Check if tutor has an availability window covering the requested time
        const hasWindow = group.availabilityWindows.some(
          (w) => w.weekday === weekday && w.startMinute <= slotStartMin && w.endMinute >= slotEndMin,
        );

        // Check if blocked
        const isBlocked = group.sessionBlocks.some(
          (s) =>
            s.isBlocking &&
            s.weekday === weekday &&
            s.startMinute < slotEndMin &&
            s.endMinute > slotStartMin,
        );

        hasAvailabilityAtRequestedTime = hasWindow && !isBlocked;

        if (hasAvailabilityAtRequestedTime) {
          freeSlots.push({ start: startTime!, end: endTime! });
        }
      }

      // Detect conflicts against existing tutors
      const candidateCompareTutor = buildCompareTutor(group);
      const allCompareTutors = [...existingCompareTutors, candidateCompareTutor];
      const allIndexedGroups = [...existingGroups, group];
      const conflicts = detectConflicts(allCompareTutors, allIndexedGroups);

      // Only include conflicts involving this candidate
      const candidateConflicts = conflicts.filter(
        (c) =>
          c.tutorA.tutorGroupId === group.id || c.tutorB.tutorGroupId === group.id,
      );

      const hasDataIssues = group.dataIssues.length > 0 || group.supportedModes.length === 0;
      const dataIssueReasons = [
        ...group.dataIssues.map((i) => `${i.type}: ${i.message}`),
        ...(group.supportedModes.length === 0 ? ["Unresolved modality"] : []),
      ];

      candidates.push({
        tutorGroupId: group.id,
        displayName: group.displayName,
        supportedModes: group.supportedModes,
        qualifications: group.qualifications,
        conflictCount: candidateConflicts.length,
        conflicts: candidateConflicts,
        freeSlots,
        hasDataIssues,
        dataIssueReasons,
      });
    }

    // Sort: no conflicts + available first, then by conflict count, data issues last
    candidates.sort((a, b) => {
      if (a.hasDataIssues !== b.hasDataIssues) return a.hasDataIssues ? 1 : -1;
      if (a.conflictCount !== b.conflictCount) return a.conflictCount - b.conflictCount;
      return b.freeSlots.length - a.freeSlots.length;
    });

    const response: DiscoverResponse = {
      snapshotMeta,
      candidates,
      latencyMs: Date.now() - start,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Discover failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify route compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/api/compare/discover/route.ts
git commit -m "feat(compare): add POST /api/compare/discover endpoint for tutor discovery"
```

---

### Task 5: Compare Page — Shell & Tutor Selector

**Files:**
- Create: `src/app/compare/page.tsx`
- Create: `src/components/compare/tutor-selector.tsx`

- [ ] **Step 1: Create tutor selector component**

Create `src/components/compare/tutor-selector.tsx`:

```typescript
"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const TUTOR_COLORS = ["#3b82f6", "#f472b6", "#a78bfa"];

interface TutorChip {
  tutorGroupId: string;
  displayName: string;
  color: string;
}

interface TutorSelectorProps {
  tutors: TutorChip[];
  onRemove: (id: string) => void;
  onOpenDiscovery: () => void;
}

export function TutorSelector({ tutors, onRemove, onOpenDiscovery }: TutorSelectorProps) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {tutors.map((t) => (
        <div
          key={t.tutorGroupId}
          className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
          style={{ borderColor: t.color }}
        >
          <div
            className="h-2 w-2 rounded-full"
            style={{ background: t.color }}
          />
          <span>{t.displayName}</span>
          <button
            onClick={() => onRemove(t.tutorGroupId)}
            className="text-muted-foreground hover:text-foreground text-xs ml-1"
          >
            ✕
          </button>
        </div>
      ))}
      {tutors.length < 3 && (
        <Button variant="outline" size="sm" onClick={onOpenDiscovery} className="border-dashed">
          + Add tutor
        </Button>
      )}
      <span className="text-xs text-muted-foreground ml-auto">
        {tutors.length}/3 tutors
      </span>
    </div>
  );
}

export { TUTOR_COLORS };
export type { TutorChip };
```

- [ ] **Step 2: Create compare page shell**

Create `src/app/compare/page.tsx`:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TutorSelector, TUTOR_COLORS } from "@/components/compare/tutor-selector";
import type { TutorChip } from "@/components/compare/tutor-selector";
import type { CompareResponse } from "@/lib/search/types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ComparePage() {
  const searchParams = useSearchParams();
  const [tutors, setTutors] = useState<TutorChip[]>([]);
  const [activeDay, setActiveDay] = useState<number | null>(null); // null = week overview
  const [response, setResponse] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);

  // Load tutors from URL params on mount
  useEffect(() => {
    const tutorIds = searchParams.get("tutors")?.split(",").filter(Boolean) ?? [];
    if (tutorIds.length > 0) {
      // Fetch tutor names via compare API
      fetchCompare(tutorIds);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchCompare = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setResponse(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tutorGroupIds: ids,
          mode: "recurring",
          // No dayOfWeek = full week
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Compare failed (${res.status})`);
      }

      const data: CompareResponse = await res.json();
      setResponse(data);

      // Update tutor chips from response
      setTutors(
        data.tutors.map((t, i) => ({
          tutorGroupId: t.tutorGroupId,
          displayName: t.displayName,
          color: TUTOR_COLORS[i % TUTOR_COLORS.length],
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compare failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRemoveTutor = (id: string) => {
    const remaining = tutors.filter((t) => t.tutorGroupId !== id);
    setTutors(remaining);
    fetchCompare(remaining.map((t) => t.tutorGroupId));
  };

  const handleAddTutor = (id: string, name: string) => {
    if (tutors.length >= 3) return;
    const updated = [
      ...tutors,
      { tutorGroupId: id, displayName: name, color: TUTOR_COLORS[tutors.length] },
    ];
    setTutors(updated);
    setDiscoveryOpen(false);
    fetchCompare(updated.map((t) => t.tutorGroupId));
  };

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Compare Tutors</h1>
        <a href="/search" className="text-sm text-blue-600 hover:underline">
          ← Back to Search
        </a>
      </div>

      <Card>
        <CardContent className="pt-6">
          <TutorSelector
            tutors={tutors}
            onRemove={handleRemoveTutor}
            onOpenDiscovery={() => setDiscoveryOpen(true)}
          />
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading && (
        <div className="text-center text-sm text-muted-foreground py-8">Loading schedules...</div>
      )}

      {response && !loading && (
        <>
          {/* Snapshot meta */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Snapshot: {response.snapshotMeta.snapshotId.slice(0, 8)}</span>
            <span>|</span>
            <span>Synced: {new Date(response.snapshotMeta.syncedAt).toLocaleString()}</span>
            <span>|</span>
            <span>{response.latencyMs}ms</span>
            {response.snapshotMeta.stale && (
              <Badge variant="destructive" className="text-xs">Stale Data</Badge>
            )}
          </div>

          {/* Day tabs */}
          <div className="flex border-b">
            <button
              className={`px-4 py-2 text-sm font-medium ${activeDay === null ? "border-b-2 border-blue-500 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setActiveDay(null)}
            >
              Week
            </button>
            {[1, 2, 3, 4, 5, 6, 0].map((day) => (
              <button
                key={day}
                className={`px-4 py-2 text-sm font-medium ${activeDay === day ? "border-b-2 border-blue-500 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setActiveDay(day)}
              >
                {DAY_NAMES[day]}
              </button>
            ))}
          </div>

          {/* Calendar grid placeholder — implemented in Task 6 */}
          <Card>
            <CardContent className="pt-6">
              {activeDay !== null ? (
                <div className="text-center text-sm text-muted-foreground py-12">
                  Day view for {DAY_NAMES[activeDay]} — calendar grid renders here
                </div>
              ) : (
                <div className="text-center text-sm text-muted-foreground py-12">
                  Week overview — compressed grid renders here
                </div>
              )}
            </CardContent>
          </Card>

          {/* Conflicts summary */}
          {response.conflicts.length > 0 && (
            <div className="rounded-md border border-red-500/30 bg-red-950/10 p-3 text-sm">
              <span className="font-semibold text-red-400">
                {response.conflicts.length} conflict{response.conflicts.length > 1 ? "s" : ""} detected
              </span>
              <ul className="mt-1 space-y-1 text-red-300/80 text-xs">
                {response.conflicts.map((c, i) => (
                  <li key={i}>
                    ⚠ {c.studentName} — {DAY_NAMES[c.dayOfWeek]}{" "}
                    {formatMinute(c.startMinute)}–{formatMinute(c.endMinute)} —{" "}
                    {c.tutorA.displayName} vs {c.tutorB.displayName}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {/* Discovery panel placeholder — implemented in Task 8 */}
    </div>
  );
}

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}
```

- [ ] **Step 3: Verify page compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/app/compare/page.tsx src/components/compare/tutor-selector.tsx
git commit -m "feat(compare): add compare page shell with tutor selector and day tabs"
```

---

### Task 6: Calendar Day View Grid

**Files:**
- Create: `src/components/compare/calendar-grid.tsx`

- [ ] **Step 1: Create the GCal-style calendar day view**

Create `src/components/compare/calendar-grid.tsx`:

```typescript
"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { CompareTutor, Conflict, SharedFreeSlot } from "@/lib/search/types";
import type { TutorChip } from "./tutor-selector";

const HOUR_HEIGHT = 60; // px per hour
const START_HOUR = 7;   // grid starts at 7 AM
const END_HOUR = 21;    // grid ends at 9 PM
const TOTAL_HOURS = END_HOUR - START_HOUR;

function minuteToY(minute: number): number {
  return ((minute / 60) - START_HOUR) * HOUR_HEIGHT;
}

function minuteToLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function formatClassType(ct?: string): string {
  if (ct === "ONE_TO_ONE") return "1:1";
  if (ct === "GROUP") return "Group";
  return ct ?? "";
}

interface CalendarGridProps {
  tutors: CompareTutor[];
  tutorChips: TutorChip[];
  conflicts: Conflict[];
  sharedFreeSlots: SharedFreeSlot[];
  dayOfWeek: number;
  onFindAlternatives?: (conflict: Conflict) => void;
  onTutorNameClick?: (tutorGroupId: string) => void;
}

export function CalendarGrid({
  tutors,
  tutorChips,
  conflicts,
  sharedFreeSlots,
  dayOfWeek,
  onFindAlternatives,
  onTutorNameClick,
}: CalendarGridProps) {
  const dayConflicts = useMemo(
    () => conflicts.filter((c) => c.dayOfWeek === dayOfWeek),
    [conflicts, dayOfWeek],
  );

  const dayFreeSlots = useMemo(
    () => sharedFreeSlots.filter((s) => s.dayOfWeek === dayOfWeek),
    [sharedFreeSlots, dayOfWeek],
  );

  const conflictRanges = useMemo(() => {
    return dayConflicts.map((c) => ({
      top: minuteToY(c.startMinute),
      height: ((c.endMinute - c.startMinute) / 60) * HOUR_HEIGHT,
      conflict: c,
    }));
  }, [dayConflicts]);

  return (
    <div className="relative" style={{ marginLeft: 50 }}>
      {/* Column headers */}
      <div className="flex border-b sticky top-0 bg-background z-10">
        {tutors.map((t, i) => {
          const chip = tutorChips[i];
          return (
            <div key={t.tutorGroupId} className="flex-1 px-3 py-2 text-center border-r last:border-r-0">
              <button
                className="font-semibold text-sm hover:underline"
                style={{ color: chip?.color }}
                onClick={() => onTutorNameClick?.(t.tutorGroupId)}
              >
                {t.displayName}
              </button>
              <div className="text-[10px] text-muted-foreground">
                {t.supportedModes.join(" · ")} · {t.qualifications.map((q) => q.subject).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
              </div>
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div className="relative" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}>
        {/* Time labels */}
        <div className="absolute top-0 h-full" style={{ left: -50, width: 45 }}>
          {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => {
            const hour = START_HOUR + i;
            return (
              <div
                key={hour}
                className="absolute text-[10px] text-muted-foreground text-right pr-2"
                style={{ top: i * HOUR_HEIGHT - 6, width: 45 }}
              >
                {hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`}
              </div>
            );
          })}
        </div>

        {/* Grid lines */}
        {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => (
          <div
            key={i}
            className="absolute left-0 right-0 border-t border-border/30"
            style={{ top: i * HOUR_HEIGHT }}
          />
        ))}

        {/* Column dividers */}
        {tutors.slice(0, -1).map((_, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 border-l border-border/30"
            style={{ left: `${((i + 1) / tutors.length) * 100}%` }}
          />
        ))}

        {/* Conflict highlight bands */}
        {conflictRanges.map((cr, i) => (
          <div
            key={`conflict-${i}`}
            className="absolute left-0 right-0 bg-red-500/5 border-y border-red-500/20 z-0"
            style={{ top: cr.top, height: cr.height }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 bg-red-500 text-white text-[9px] px-2 py-0.5 rounded-l font-semibold whitespace-nowrap flex items-center gap-1">
              <span>⚠ {cr.conflict.studentName}</span>
              {onFindAlternatives && (
                <button
                  className="underline ml-1"
                  onClick={() => onFindAlternatives(cr.conflict)}
                >
                  Find alt
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Session blocks per tutor */}
        {tutors.map((t, tutorIdx) => {
          const chip = tutorChips[tutorIdx];
          const colWidth = 100 / tutors.length;
          const colLeft = tutorIdx * colWidth;

          return t.sessions
            .filter((s) => s.weekday === dayOfWeek)
            .map((s, sIdx) => {
              const top = minuteToY(s.startMinute);
              const height = ((s.endMinute - s.startMinute) / 60) * HOUR_HEIGHT;
              const isConflict = dayConflicts.some(
                (c) =>
                  s.studentName &&
                  c.studentName.toLowerCase() === s.studentName.toLowerCase() &&
                  s.startMinute < c.endMinute &&
                  s.endMinute > c.startMinute,
              );
              const bgColor = isConflict
                ? "rgba(239, 68, 68, 0.25)"
                : `${chip?.color}33`;
              const borderColor = isConflict ? "#ef4444" : chip?.color;

              return (
                <Popover key={`${t.tutorGroupId}-${sIdx}`}>
                  <PopoverTrigger asChild>
                    <div
                      className="absolute rounded cursor-pointer overflow-hidden z-[1]"
                      style={{
                        top: top + 2,
                        left: `calc(${colLeft}% + 4px)`,
                        width: `calc(${colWidth}% - 8px)`,
                        height: height - 4,
                        background: bgColor,
                        borderLeft: `3px solid ${borderColor}`,
                      }}
                    >
                      <div className="p-1.5 text-[11px] leading-tight">
                        <div className="font-semibold" style={{ color: isConflict ? "#fca5a5" : `${chip?.color}dd` }}>
                          {s.subject ?? "Session"} — {s.studentName ?? "Unknown"}
                          {isConflict && " ⚠️"}
                        </div>
                        <div className="text-muted-foreground text-[10px]">
                          {minuteToLabel(s.startMinute)}–{minuteToLabel(s.endMinute)}
                          {s.classType && ` · ${formatClassType(s.classType)}`}
                          {s.location && ` · ${s.location}`}
                        </div>
                      </div>
                    </div>
                  </PopoverTrigger>
                  <PopoverContent side="top" className="w-56 p-3 text-xs space-y-1">
                    {s.studentName && <p className="font-semibold">{s.studentName}</p>}
                    {s.subject && <p className="text-muted-foreground">{s.subject}</p>}
                    <p>{minuteToLabel(s.startMinute)}–{minuteToLabel(s.endMinute)}</p>
                    <div className="flex gap-1 flex-wrap">
                      {s.classType && <Badge variant="outline" className="text-[10px] px-1 py-0">{formatClassType(s.classType)}</Badge>}
                      {s.location && <Badge variant="outline" className="text-[10px] px-1 py-0">{s.location}</Badge>}
                      {s.recurrenceId && <Badge variant="secondary" className="text-[10px] px-1 py-0">recurring</Badge>}
                    </div>
                  </PopoverContent>
                </Popover>
              );
            });
        })}

        {/* Shared free slot indicators */}
        {dayFreeSlots.map((slot, i) => {
          const top = minuteToY(slot.startMinute);
          const height = ((slot.endMinute - slot.startMinute) / 60) * HOUR_HEIGHT;
          return (
            <div
              key={`free-${i}`}
              className="absolute left-0 right-0 flex items-center justify-center z-[1] pointer-events-none"
              style={{ top, height }}
            >
              <div className="bg-green-500/5 border border-dashed border-green-500/20 rounded px-3 py-0.5 text-green-400 text-[10px]">
                {minuteToLabel(slot.startMinute)}–{minuteToLabel(slot.endMinute)} · All free
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire CalendarGrid into the compare page**

In `src/app/compare/page.tsx`, replace the placeholder `<Card>` in the day view section. Add the import at the top:

```typescript
import { CalendarGrid } from "@/components/compare/calendar-grid";
```

Replace the `{/* Calendar grid placeholder — implemented in Task 6 */}` Card with:

```typescript
<Card>
  <CardContent className="pt-6">
    {activeDay !== null && response ? (
      <CalendarGrid
        tutors={response.tutors}
        tutorChips={tutors}
        conflicts={response.conflicts}
        sharedFreeSlots={response.sharedFreeSlots}
        dayOfWeek={activeDay}
        onFindAlternatives={(conflict) => {
          // Will wire to discovery panel in Task 8
          setDiscoveryOpen(true);
        }}
        onTutorNameClick={(id) => {
          // Will wire to profile popover in Task 9
        }}
      />
    ) : response ? (
      <div className="text-center text-sm text-muted-foreground py-12">
        Week overview — click a day tab to see detailed schedules
      </div>
    ) : null}
  </CardContent>
</Card>
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/compare/calendar-grid.tsx src/app/compare/page.tsx
git commit -m "feat(compare): add GCal-style calendar day view with conflict highlighting"
```

---

### Task 7: Week Overview Grid

**Files:**
- Create: `src/components/compare/week-overview.tsx`
- Modify: `src/app/compare/page.tsx`

- [ ] **Step 1: Create compressed weekly overview component**

Create `src/components/compare/week-overview.tsx`:

```typescript
"use client";

import type { CompareTutor, Conflict, SharedFreeSlot } from "@/lib/search/types";
import type { TutorChip } from "./tutor-selector";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun

function minuteToLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

interface WeekOverviewProps {
  tutors: CompareTutor[];
  tutorChips: TutorChip[];
  conflicts: Conflict[];
  onDayClick: (day: number) => void;
}

export function WeekOverview({ tutors, tutorChips, conflicts, onDayClick }: WeekOverviewProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="w-[120px] px-3 py-2 text-left font-medium">Tutor</th>
            {DISPLAY_DAYS.map((day) => {
              const dayConflicts = conflicts.filter((c) => c.dayOfWeek === day);
              return (
                <th
                  key={day}
                  className="min-w-[100px] px-2 py-2 text-center font-medium text-xs cursor-pointer hover:bg-muted/80 transition-colors"
                  onClick={() => onDayClick(day)}
                >
                  {DAY_NAMES[day]}
                  {dayConflicts.length > 0 && (
                    <span className="ml-1 text-red-400">⚠</span>
                  )}
                  <span className="block text-[10px] text-muted-foreground font-normal">click to expand</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {tutors.map((t, idx) => {
            const chip = tutorChips[idx];
            return (
              <tr key={t.tutorGroupId} className="border-b">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full" style={{ background: chip?.color }} />
                    <span className="font-medium text-xs">{t.displayName}</span>
                  </div>
                </td>
                {DISPLAY_DAYS.map((day) => {
                  const daySessions = t.sessions.filter((s) => s.weekday === day);
                  const dayConflicts = conflicts.filter(
                    (c) =>
                      c.dayOfWeek === day &&
                      (c.tutorA.tutorGroupId === t.tutorGroupId ||
                        c.tutorB.tutorGroupId === t.tutorGroupId),
                  );

                  return (
                    <td
                      key={day}
                      className="px-2 py-1.5 align-top cursor-pointer hover:bg-muted/30"
                      onClick={() => onDayClick(day)}
                    >
                      {daySessions.length === 0 ? (
                        <span className="text-[10px] text-muted-foreground/30">—</span>
                      ) : (
                        <div className="space-y-0.5">
                          {daySessions.slice(0, 3).map((s, si) => {
                            const isConflict = dayConflicts.some(
                              (c) =>
                                s.studentName &&
                                c.studentName.toLowerCase() === s.studentName?.toLowerCase() &&
                                s.startMinute < c.endMinute &&
                                s.endMinute > c.startMinute,
                            );
                            return (
                              <div
                                key={si}
                                className="text-[10px] px-1 py-0.5 rounded truncate"
                                style={{
                                  background: isConflict ? "rgba(239, 68, 68, 0.15)" : `${chip?.color}15`,
                                  borderLeft: `2px solid ${isConflict ? "#ef4444" : chip?.color}`,
                                  color: isConflict ? "#fca5a5" : undefined,
                                }}
                              >
                                {minuteToLabel(s.startMinute)} {s.subject ?? ""}
                              </div>
                            );
                          })}
                          {daySessions.length > 3 && (
                            <div className="text-[9px] text-muted-foreground">
                              +{daySessions.length - 3} more
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Wire WeekOverview into the compare page**

In `src/app/compare/page.tsx`, add import:

```typescript
import { WeekOverview } from "@/components/compare/week-overview";
```

Replace the week overview placeholder text (`Week overview — click a day tab...`) with:

```typescript
<WeekOverview
  tutors={response.tutors}
  tutorChips={tutors}
  conflicts={response.conflicts}
  onDayClick={(day) => setActiveDay(day)}
/>
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/compare/week-overview.tsx src/app/compare/page.tsx
git commit -m "feat(compare): add compressed weekly overview grid"
```

---

### Task 8: Discovery Panel

**Files:**
- Create: `src/components/compare/discovery-panel.tsx`
- Modify: `src/app/compare/page.tsx`

- [ ] **Step 1: Create the discovery panel component**

Create `src/components/compare/discovery-panel.tsx`:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { DiscoverResponse, DiscoverCandidate, Conflict, SearchFilters } from "@/lib/search/types";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface FilterOptions {
  subjects: string[];
  curriculums: string[];
  levels: string[];
}

interface DiscoveryPanelProps {
  open: boolean;
  onClose: () => void;
  existingTutorGroupIds: string[];
  onAdd: (id: string, name: string) => void;
  prefillConflict?: Conflict | null;
}

export function DiscoveryPanel({
  open,
  onClose,
  existingTutorGroupIds,
  onAdd,
  prefillConflict,
}: DiscoveryPanelProps) {
  const [nameSearch, setNameSearch] = useState("");
  const [dayOfWeek, setDayOfWeek] = useState<number | undefined>(prefillConflict?.dayOfWeek);
  const [startTime, setStartTime] = useState(prefillConflict ? minuteToHHMM(prefillConflict.startMinute) : "");
  const [endTime, setEndTime] = useState(prefillConflict ? minuteToHHMM(prefillConflict.endMinute) : "");
  const [modeFilter, setModeFilter] = useState<"online" | "onsite" | "either">("either");
  const [subjectFilter, setSubjectFilter] = useState(prefillConflict?.tutorB.sessionTitle.split(" — ")[0] ?? "");
  const [filterByTime, setFilterByTime] = useState(!!prefillConflict);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);

  const [response, setResponse] = useState<DiscoverResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // Load filter options
  useEffect(() => {
    if (!open) return;
    fetch("/api/filters")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setFilterOptions(data); })
      .catch(() => {});
  }, [open]);

  // Update prefill when conflict changes
  useEffect(() => {
    if (prefillConflict) {
      setDayOfWeek(prefillConflict.dayOfWeek);
      setStartTime(minuteToHHMM(prefillConflict.startMinute));
      setEndTime(minuteToHHMM(prefillConflict.endMinute));
      setFilterByTime(true);
    }
  }, [prefillConflict]);

  const handleSearch = useCallback(async () => {
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        existingTutorGroupIds,
        mode: "recurring",
        modeFilter: modeFilter !== "either" ? modeFilter : undefined,
        filters: {
          subject: subjectFilter || undefined,
        },
      };

      if (filterByTime && dayOfWeek !== undefined && startTime && endTime) {
        body.dayOfWeek = dayOfWeek;
        body.startTime = startTime;
        body.endTime = endTime;
      }

      const res = await fetch("/api/compare/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data: DiscoverResponse = await res.json();
        setResponse(data);
      }
    } catch {
      // Silently fail — user can retry
    } finally {
      setLoading(false);
    }
  }, [existingTutorGroupIds, modeFilter, subjectFilter, filterByTime, dayOfWeek, startTime, endTime]);

  // Auto-search when panel opens or filters change
  useEffect(() => {
    if (open && existingTutorGroupIds.length > 0) {
      handleSearch();
    }
  }, [open, handleSearch, existingTutorGroupIds.length]);

  if (!open) return null;

  const filteredCandidates = response?.candidates.filter((c) =>
    !nameSearch || c.displayName.toLowerCase().includes(nameSearch.toLowerCase()),
  ) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="w-[360px] bg-background border-l flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="font-semibold">Add Tutor</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">
            ✕ Close
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 space-y-3">
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            placeholder="Search by name..."
            value={nameSearch}
            onChange={(e) => setNameSearch(e.target.value)}
          />

          {/* Filters */}
          <div className="flex gap-2 flex-wrap">
            <select
              className="rounded-md border px-2 py-1 text-xs"
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
            >
              <option value="">Subject</option>
              {filterOptions?.subjects.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select
              className="rounded-md border px-2 py-1 text-xs"
              value={modeFilter}
              onChange={(e) => setModeFilter(e.target.value as "online" | "onsite" | "either")}
            >
              <option value="either">Mode</option>
              <option value="online">Online</option>
              <option value="onsite">Onsite</option>
            </select>
          </div>

          {/* Time filter */}
          <div className="rounded-md border p-2 space-y-1">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={filterByTime}
                onChange={(e) => setFilterByTime(e.target.checked)}
              />
              Only show tutors free at:
            </label>
            {filterByTime && (
              <div className="flex gap-2 items-center pl-5 text-xs">
                <select
                  className="rounded border px-1 py-0.5"
                  value={dayOfWeek ?? ""}
                  onChange={(e) => setDayOfWeek(e.target.value ? Number(e.target.value) : undefined)}
                >
                  <option value="">Day</option>
                  {DAY_NAMES.map((d, i) => (
                    <option key={i} value={i}>{d.slice(0, 3)}</option>
                  ))}
                </select>
                <input
                  type="time"
                  className="rounded border px-1 py-0.5"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
                <span>–</span>
                <input
                  type="time"
                  className="rounded border px-1 py-0.5"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </div>
            )}
          </div>

          <Button size="sm" onClick={handleSearch} disabled={loading} className="w-full">
            {loading ? "Searching..." : "Search"}
          </Button>
        </div>

        {/* Results count */}
        {response && (
          <div className="px-4 pb-2 text-[10px] text-muted-foreground uppercase tracking-wide">
            {filteredCandidates.length} tutors
          </div>
        )}

        {/* Results list */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
          {filteredCandidates.map((c) => (
            <CandidateCard
              key={c.tutorGroupId}
              candidate={c}
              onAdd={() => onAdd(c.tutorGroupId, c.displayName)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function CandidateCard({ candidate, onAdd }: { candidate: DiscoverCandidate; onAdd: () => void }) {
  const c = candidate;

  return (
    <div
      className={`rounded-lg border p-3 space-y-2 ${c.hasDataIssues ? "opacity-50" : ""}`}
    >
      <div className="flex justify-between items-start">
        <div>
          <div className="font-semibold text-sm">{c.displayName}</div>
          <div className="text-xs text-muted-foreground">
            {c.qualifications.map((q) => q.subject).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
            {" · "}
            {c.supportedModes.join("/")}
          </div>
        </div>
        {c.hasDataIssues ? (
          <Badge variant="outline" className="text-[10px] text-yellow-500 border-yellow-500/30">
            Needs review
          </Badge>
        ) : c.conflictCount > 0 ? (
          <Badge variant="outline" className="text-[10px] text-red-400 border-red-400/30">
            {c.conflictCount} conflict{c.conflictCount > 1 ? "s" : ""}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] text-green-400 border-green-400/30">
            No conflicts
          </Badge>
        )}
      </div>

      {c.freeSlots.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {c.freeSlots.map((s, i) => (
            <span key={i} className="text-[10px] bg-green-500/10 text-green-400 px-1.5 py-0.5 rounded">
              {s.start}–{s.end} free ✓
            </span>
          ))}
        </div>
      )}

      <div className="text-right">
        <Button
          size="sm"
          variant={c.conflictCount > 0 || c.hasDataIssues ? "outline" : "default"}
          className="text-xs h-7"
          onClick={onAdd}
        >
          {c.conflictCount > 0 ? "Add anyway" : c.hasDataIssues ? "Add anyway" : "Add to compare"}
        </Button>
      </div>
    </div>
  );
}

function minuteToHHMM(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
```

- [ ] **Step 2: Wire DiscoveryPanel into compare page**

In `src/app/compare/page.tsx`, add import:

```typescript
import { DiscoveryPanel } from "@/components/compare/discovery-panel";
```

Add state for prefill conflict:

```typescript
const [prefillConflict, setPrefillConflict] = useState<Conflict | null>(null);
```

Add the import for `Conflict`:

```typescript
import type { CompareResponse, Conflict } from "@/lib/search/types";
```

Replace `{/* Discovery panel placeholder — implemented in Task 8 */}` at the end of the return with:

```typescript
<DiscoveryPanel
  open={discoveryOpen}
  onClose={() => { setDiscoveryOpen(false); setPrefillConflict(null); }}
  existingTutorGroupIds={tutors.map((t) => t.tutorGroupId)}
  onAdd={handleAddTutor}
  prefillConflict={prefillConflict}
/>
```

Update the `onFindAlternatives` callback on `CalendarGrid` to:

```typescript
onFindAlternatives={(conflict) => {
  setPrefillConflict(conflict);
  setDiscoveryOpen(true);
}}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/compare/discovery-panel.tsx src/app/compare/page.tsx
git commit -m "feat(compare): add discovery panel with search, filters, and conflict badges"
```

---

### Task 9: Tutor Profile Popover & Search Bridge

**Files:**
- Create: `src/components/compare/tutor-profile-popover.tsx`
- Modify: `src/app/compare/page.tsx`
- Modify: `src/components/search/availability-grid.tsx`

- [ ] **Step 1: Create tutor profile popover**

Create `src/components/compare/tutor-profile-popover.tsx`:

```typescript
"use client";

import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { CompareTutor } from "@/lib/search/types";

interface TutorProfilePopoverProps {
  tutor: CompareTutor;
  color: string;
  children: React.ReactNode;
}

export function TutorProfilePopover({ tutor, color, children }: TutorProfilePopoverProps) {
  const subjects = [...new Set(tutor.qualifications.map((q) => q.subject))];

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="bottom" className="w-64 p-4 space-y-3">
        <div>
          <div className="font-semibold" style={{ color }}>{tutor.displayName}</div>
          <div className="text-xs text-muted-foreground">{tutor.supportedModes.join(" / ")}</div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">Weekly hours</div>
            <div className="font-semibold">{tutor.weeklyHoursBooked}h</div>
          </div>
          <div>
            <div className="text-muted-foreground">Students</div>
            <div className="font-semibold">{tutor.studentCount}</div>
          </div>
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">Subjects</div>
          <div className="flex gap-1 flex-wrap">
            {subjects.map((s) => (
              <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
            ))}
          </div>
        </div>

        {tutor.dataIssues.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">Data issues</div>
            <Badge variant="destructive" className="text-[10px]">
              {tutor.dataIssues.length} issue{tutor.dataIssues.length > 1 ? "s" : ""}
            </Badge>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Wire profile popover into CalendarGrid**

In `src/components/compare/calendar-grid.tsx`, add import:

```typescript
import { TutorProfilePopover } from "./tutor-profile-popover";
```

In the column headers section, wrap the tutor name button with the popover. Replace the `<button>` element inside the column headers:

```typescript
<TutorProfilePopover tutor={t} color={chip?.color ?? "#888"}>
  <button
    className="font-semibold text-sm hover:underline"
    style={{ color: chip?.color }}
  >
    {t.displayName}
  </button>
</TutorProfilePopover>
```

Remove the `onTutorNameClick` prop and its usage — the popover replaces it.

- [ ] **Step 3: Add "Compare schedules" button to search page**

In `src/components/search/availability-grid.tsx`, add a `compareEnabled` prop and render a link button. Add to the `AvailabilityGridProps` interface:

```typescript
interface AvailabilityGridProps {
  subSlots: { start: string; end: string }[];
  grid: RangeGridRow[];
  needsReview: TutorReviewResult[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  compareButton?: React.ReactNode; // injected from parent
}
```

Add `compareButton` to the destructured props. Then in the parent `src/app/search/page.tsx`, update the results header to pass a compare button. In the `<div className="flex items-center gap-3">` where `CopyButton` is rendered, add after it:

```typescript
{selectedIds.size >= 2 && selectedIds.size <= 3 && (
  <a
    href={`/compare?tutors=${[...selectedIds].join(",")}`}
    className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
  >
    Compare schedules ({selectedIds.size})
  </a>
)}
```

- [ ] **Step 4: Verify everything compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/compare/tutor-profile-popover.tsx src/components/compare/calendar-grid.tsx src/app/compare/page.tsx src/components/search/availability-grid.tsx src/app/search/page.tsx
git commit -m "feat(compare): add tutor profile popover and search-to-compare bridge"
```

---

### Task 10: Tests & Final Verification

**Files:**
- Test: `src/lib/search/__tests__/compare.test.ts` (already created)
- All created files

- [ ] **Step 1: Run all existing tests to ensure no regressions**

Run: `npx vitest run 2>&1 | tail -30`
Expected: All tests pass (72 existing + new compare tests)

- [ ] **Step 2: Run TypeScript check across full project**

Run: `npx tsc --noEmit --pretty 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 3: Start dev server and verify pages load**

Run: `npx next dev`

Manual checks:
1. Navigate to `/compare` — page loads with empty tutor selector
2. Navigate to `/compare?tutors=<id1>,<id2>` — loads with tutors (use real IDs from DB)
3. Click day tabs — switches between week overview and day view
4. Click "+ Add tutor" — discovery panel opens
5. On `/search`, select 2 tutors — "Compare schedules" link appears
6. Click "Compare schedules" — navigates to `/compare` with tutors pre-loaded

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(compare): address test and compilation issues"
```

// ----------------------------------------------------------------------------
// EFF-09 probe: does Wise's availability endpoint honour a window wider than
// 7 days? Read-only — GET-only Wise reads, no database writes, no Wise writes.
//
// `fetchTeacherFullAvailability` stitches 26 seven-day windows per teacher to
// cover the 180-day horizon (src/lib/wise/fetchers.ts:63-105). At ~131
// teachers that is ~3,400 GETs per snapshot sync, and the stitching exists
// because nobody ever confirmed the endpoint's real window ceiling. This probe
// answers that empirically: for each teacher it fetches the same horizon three
// ways and compares the NORMALIZED result, not the raw payload —
// `normalizeLeaves` merges and de-duplicates overlaps, so windows that split a
// leave differently still have to agree once normalized.
//
//   26x7   the current strategy, exactly as the orchestrator runs it
//   1x180  one 180-day window
//   6x30   six 30-day windows
//
// `normalizeWorkingHours` comes from window 1 in every strategy (Wise returns
// recurring workingHours on any window), so it is compared too — a wider
// window that silently drops workingHours would be a false positive otherwise.
//
// A strategy is only "equal" when both its leaves and its workingHours match
// the 26x7 baseline. Anything else is reported verbatim, never smoothed over.
//
// Usage:
//   npx tsx --tsconfig scripts/tsconfig.json scripts/probe-wise-availability-range.ts \
//     --limit=5 --concurrency=5 --out=/tmp/probe.json
// ----------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import { addDays } from "date-fns";

import { createWiseClient, type WiseClient } from "@/lib/wise/client";
import { fetchAllTeachers, fetchTeacherAvailability } from "@/lib/wise/fetchers";
import { normalizeWorkingHours, type RecurringWindow } from "@/lib/normalization/availability";
import { normalizeLeaves, type NormalizedLeave } from "@/lib/normalization/leaves";
import { getWiseTeacherDisplayName, getWiseTeacherUserId } from "@/lib/wise/types";
import type { WiseAvailabilityResponse } from "@/lib/wise/types";

loadEnvConfig(process.cwd());

const HORIZON_DAYS = 180;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_OUT = path.join(process.cwd(), "probe-wise-availability-range.json");

/** Accepts both `--flag=value` and `--flag value`. */
function arg(name: string, fallback: string): string {
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
}

interface StrategyResult {
  label: string;
  windows: number;
  requests: number;
  leaves: NormalizedLeave[];
  workingHours: RecurringWindow[];
  error: string | null;
}

interface TeacherProbe {
  teacherId: string;
  teacherUserId: string;
  name: string;
  leaves26: number;
  leaves180: number;
  leaves30x6: number;
  equal180: boolean;
  equal30: boolean;
  notes: string;
}

/** Stable JSON of the normalized leave set, for cross-strategy comparison. */
function leaveFingerprint(leaves: NormalizedLeave[]): string {
  return JSON.stringify(
    leaves
      .map((leave) => [leave.startTime.toISOString(), leave.endTime.toISOString()])
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))),
  );
}

function windowFingerprint(windows: RecurringWindow[]): string {
  return JSON.stringify(
    [...windows]
      .map((window) => [window.weekday, window.startMinute, window.endMinute])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]),
  );
}

/**
 * Fetch one horizon as `windowCount` consecutive windows of `spanDays` each
 * and normalize the union. workingHours always come from window 1, matching
 * what `fetchTeacherFullAvailability` does.
 */
async function probeStrategy(
  client: WiseClient,
  instituteId: string,
  teacherUserId: string,
  label: string,
  spanDays: number,
  windowCount: number,
  from: Date,
): Promise<StrategyResult> {
  try {
    const responses: WiseAvailabilityResponse[] = [];
    for (let index = 0; index < windowCount; index += 1) {
      const start = addDays(from, index * spanDays);
      responses.push(
        await fetchTeacherAvailability(client, instituteId, teacherUserId, start, addDays(start, spanDays)),
      );
    }

    const allLeaves = responses.flatMap((response) => response.leaves ?? []);
    return {
      label,
      windows: windowCount,
      requests: windowCount,
      leaves: normalizeLeaves(allLeaves),
      workingHours: normalizeWorkingHours(responses[0]?.workingHours?.slots),
      error: null,
    };
  } catch (error) {
    return {
      label,
      windows: windowCount,
      requests: 0,
      leaves: [],
      workingHours: [],
      error: error instanceof Error ? error.message : "availability fetch failed",
    };
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

async function main(): Promise<void> {
  const instituteId = process.env.WISE_INSTITUTE_ID;
  if (!instituteId) throw new Error("WISE_INSTITUTE_ID is not set");

  const limitRaw = arg("limit", "");
  const limit = limitRaw ? Number(limitRaw) : null;
  const concurrency = Number(arg("concurrency", String(DEFAULT_CONCURRENCY)));
  const outPath = arg("out", DEFAULT_OUT);
  const from = new Date();

  const client = createWiseClient();
  const allTeachers = await fetchAllTeachers(client, instituteId);
  const teachers = limit && limit > 0 ? allTeachers.slice(0, limit) : allTeachers;

  console.log(
    `Probing ${teachers.length} of ${allTeachers.length} teachers `
    + `(horizon ${HORIZON_DAYS}d, concurrency ${concurrency}, from ${from.toISOString()})`,
  );

  const probes = await mapLimit(teachers, concurrency, async (teacher): Promise<TeacherProbe> => {
    const name = getWiseTeacherDisplayName(teacher);
    const teacherUserId = getWiseTeacherUserId(teacher);
    if (!teacherUserId) {
      return {
        teacherId: teacher._id,
        teacherUserId: "",
        name,
        leaves26: 0,
        leaves180: 0,
        leaves30x6: 0,
        equal180: false,
        equal30: false,
        notes: "missing Wise user id",
      };
    }

    const [stitched, single, monthly] = [
      await probeStrategy(client, instituteId, teacherUserId, "26x7", 7, Math.ceil(HORIZON_DAYS / 7), from),
      await probeStrategy(client, instituteId, teacherUserId, "1x180", HORIZON_DAYS, 1, from),
      await probeStrategy(client, instituteId, teacherUserId, "6x30", 30, 6, from),
    ];

    const baseLeaves = leaveFingerprint(stitched.leaves);
    const baseHours = windowFingerprint(stitched.workingHours);
    const notes: string[] = [];
    for (const strategy of [stitched, single, monthly]) {
      if (strategy.error) notes.push(`${strategy.label}: ${strategy.error}`);
    }
    if (!single.error && windowFingerprint(single.workingHours) !== baseHours) {
      notes.push("1x180 workingHours differ");
    }
    if (!monthly.error && windowFingerprint(monthly.workingHours) !== baseHours) {
      notes.push("6x30 workingHours differ");
    }

    return {
      teacherId: teacher._id,
      teacherUserId,
      name,
      leaves26: stitched.leaves.length,
      leaves180: single.leaves.length,
      leaves30x6: monthly.leaves.length,
      equal180:
        !single.error &&
        leaveFingerprint(single.leaves) === baseLeaves &&
        windowFingerprint(single.workingHours) === baseHours,
      equal30:
        !monthly.error &&
        leaveFingerprint(monthly.leaves) === baseLeaves &&
        windowFingerprint(monthly.workingHours) === baseHours,
      notes: notes.join("; "),
    };
  });

  console.log("");
  console.log(
    `${pad("teacherId", 26)} ${pad("name", 28)} ${pad("l26", 5)} ${pad("l180", 5)} `
    + `${pad("l30x6", 6)} ${pad("eq180", 6)} ${pad("eq30", 5)} notes`,
  );
  for (const probe of probes) {
    console.log(
      `${pad(probe.teacherId, 26)} ${pad(probe.name, 28)} ${pad(String(probe.leaves26), 5)} `
      + `${pad(String(probe.leaves180), 5)} ${pad(String(probe.leaves30x6), 6)} `
      + `${pad(String(probe.equal180), 6)} ${pad(String(probe.equal30), 5)} ${probe.notes}`,
    );
  }

  const totals = {
    teachersProbed: probes.length,
    equal180: probes.filter((probe) => probe.equal180).length,
    equal30: probes.filter((probe) => probe.equal30).length,
    withNotes: probes.filter((probe) => probe.notes).length,
    wiseRequests: client.getStats().requests,
    wiseByPath: client.getStats().byPath,
  };

  console.log("");
  console.log(
    `Totals: ${totals.equal180}/${totals.teachersProbed} match on 1x180, `
    + `${totals.equal30}/${totals.teachersProbed} match on 6x30, `
    + `${totals.withNotes} with notes, ${totals.wiseRequests} Wise GETs.`,
  );
  console.log(
    totals.equal180 === totals.teachersProbed
      ? "1x180 reproduces the stitched result for every teacher probed."
      : "1x180 does NOT reproduce the stitched result everywhere — keep the 26x7 stitch.",
  );

  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  writeFileSync(
    path.resolve(outPath),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        horizonDays: HORIZON_DAYS,
        from: from.toISOString(),
        teacherCount: allTeachers.length,
        totals,
        probes,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${path.resolve(outPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

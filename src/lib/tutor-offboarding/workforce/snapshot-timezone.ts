interface SnapshotClockEvidence {
  startTime: Date;
  endTime: Date;
  weekday: number;
  startMinute: number;
  endMinute: number;
}
interface SnapshotInterval {
  startAt: string;
  endAt: string;
  scheduledMinutes: number;
  reasonCodes: string[];
}
const HOUR = 3_600_000;
// Bangkok uses UTC+07:00 throughout the supported workforce period (March 2026 onward).
function bangkokClock(instant: number) {
  const local = new Date(instant + 7 * HOUR);
  return { weekday: local.getUTCDay(), minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/**
 * Snapshot normalization stores toZonedTime Dates, whose epoch depends on the writer's
 * process timezone. The supported UTC and Bangkok writers produce two possible instants.
 * Independently retained Bangkok weekday/minute fields must identify exactly one.
 * Raw workforce/credit-control timestamps never pass through this recovery path.
 */
export function interpretSnapshotSessionInterval(block: SnapshotClockEvidence): SnapshotInterval | null {
  const start = block.startTime.getTime(), end = block.endTime.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
    || !Number.isInteger(block.weekday) || block.weekday < 0 || block.weekday > 6
    || !Number.isInteger(block.startMinute) || block.startMinute < 0 || block.startMinute >= 1440
    || !Number.isInteger(block.endMinute) || block.endMinute < 0 || block.endMinute >= 1440) return null;
  const candidates = [0, -7 * HOUR].filter(offset => {
    const first = bangkokClock(start + offset), last = bangkokClock(end + offset);
    return first.weekday === block.weekday && first.minute === block.startMinute && last.minute === block.endMinute;
  });
  if (candidates.length !== 1) return null;
  const offset = candidates[0];
  return {
    startAt: new Date(start + offset).toISOString(),
    endAt: new Date(end + offset).toISOString(),
    scheduledMinutes: (end - start) / 60_000,
    reasonCodes: offset ? ["SNAPSHOT_WALL_CLOCK_TIMESTAMP_RECOVERED"] : [],
  };
}

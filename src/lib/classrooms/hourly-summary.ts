export interface ClassroomHourItem {
  startMinute: number;
  endMinute: number;
  /** false only for remote/online items that never occupy a centre room. */
  needsCentreRoom: boolean;
  /** true iff currently holding a valid active room; irrelevant when !needsCentreRoom. */
  placed: boolean;
}

export interface ClassroomHourSummary {
  hourStart: number;
  classes: number;
  roomsNeeded: number;
  noRoom: number;
  over: boolean;
}

export interface ClassroomDaySummary {
  classes: number;
  noRoom: number;
  busiest: { startMinute: number; endMinute: number; needed: number; roomCount: number };
}

interface ClassroomHourBounds {
  startMinute: number;
  endMinute: number;
  roomCount: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatHourLabel(minute: number): string {
  return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
}

export function summarizeClassroomHours(items: ClassroomHourItem[], bounds: ClassroomHourBounds): ClassroomHourSummary[] {
  const result: ClassroomHourSummary[] = [];
  for (let h = bounds.startMinute; h < bounds.endMinute; h += 60) {
    const running = items.filter(item => item.startMinute < h + 60 && item.endMinute > h);
    let peak = 0;
    for (let t = h; t < h + 60; t += 15) {
      const count = items.filter(item => item.needsCentreRoom && item.startMinute < t + 15 && item.endMinute > t).length;
      peak = Math.max(peak, count);
    }
    const noRoom = running.filter(item => item.needsCentreRoom && !item.placed).length;
    result.push({ hourStart: h, classes: running.length, roomsNeeded: peak, noRoom, over: peak > bounds.roomCount });
  }
  return result;
}

export function summarizeClassroomDay(items: ClassroomHourItem[], bounds: ClassroomHourBounds): ClassroomDaySummary {
  const classes = items.length;
  const noRoom = items.filter(item => item.needsCentreRoom && !item.placed).length;
  let busiestMinute = bounds.startMinute;
  let busiestNeeded = 0;
  for (let t = bounds.startMinute; t < bounds.endMinute; t += 15) {
    const count = items.filter(item => item.needsCentreRoom && item.startMinute < t + 15 && item.endMinute > t).length;
    if (count > busiestNeeded) { busiestNeeded = count; busiestMinute = t; }
  }
  let busiestEnd = busiestMinute + 15;
  while (busiestEnd < bounds.endMinute) {
    const count = items.filter(item => item.needsCentreRoom && item.startMinute < busiestEnd + 15 && item.endMinute > busiestEnd).length;
    if (count !== busiestNeeded) break;
    busiestEnd += 15;
  }
  return { classes, noRoom, busiest: { startMinute: busiestMinute, endMinute: busiestEnd, needed: busiestNeeded, roomCount: bounds.roomCount } };
}

export function formatClassroomDaySummary(day: ClassroomDaySummary): string {
  return `${day.classes} classes · ${day.noRoom} without a room · busiest ${formatHourLabel(day.busiest.startMinute)}–${formatHourLabel(day.busiest.endMinute)}: ${day.busiest.needed} classes need a room, only ${day.busiest.roomCount} rooms`;
}

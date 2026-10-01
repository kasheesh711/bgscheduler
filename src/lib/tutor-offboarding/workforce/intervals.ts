/** Half-open epoch-millisecond intervals: [start, end). */
export interface Interval { start: number; end: number; }

export function unionIntervals(intervals: readonly Interval[]): Interval[] {
  for (const value of intervals) {
    if (!Number.isFinite(value.start) || !Number.isFinite(value.end) || value.end < value.start) {
      throw new RangeError("Invalid interval bounds");
    }
  }
  const sorted = intervals.filter(value => value.end > value.start).map(value => ({ ...value })).sort((a,b) => a.start - b.start || a.end - b.end);
  const result: Interval[] = [];
  for (const value of sorted) {
    const previous = result.at(-1);
    if (previous && value.start <= previous.end) previous.end = Math.max(previous.end,value.end);
    else result.push(value);
  }
  return result;
}

export function intersectIntervals(left: readonly Interval[], right: readonly Interval[]): Interval[] {
  const a = unionIntervals(left), b = unionIntervals(right), result: Interval[] = [];
  let i=0, j=0;
  while (i<a.length && j<b.length) {
    const start=Math.max(a[i].start,b[j].start), end=Math.min(a[i].end,b[j].end);
    if (end>start) result.push({start,end});
    if (a[i].end < b[j].end) i++; else j++;
  }
  return result;
}

export function subtractIntervals(source: readonly Interval[], removed: readonly Interval[]): Interval[] {
  const a=unionIntervals(source), b=unionIntervals(removed), result: Interval[]=[];
  let j=0;
  for (const value of a) {
    let cursor=value.start;
    while (j<b.length && b[j].end<=cursor) j++;
    for (let k=j; k<b.length && b[k].start<value.end; k++) {
      if (b[k].start>cursor) result.push({start:cursor,end:Math.min(b[k].start,value.end)});
      cursor=Math.max(cursor,b[k].end);
      if (cursor>=value.end) break;
    }
    if (cursor<value.end) result.push({start:cursor,end:value.end});
  }
  return result;
}
export function clipIntervals(intervals: readonly Interval[], bounds: Interval): Interval[] {
  return intersectIntervals(intervals,[bounds]);
}
/** Physical time is unioned; use session durations separately for billed/teaching sums. */
export function intervalMinutes(intervals: readonly Interval[]): number {
  return unionIntervals(intervals).reduce((total,value)=>total+(value.end-value.start)/60_000,0);
}
export function bangkokDayStart(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError("Invalid Bangkok date");
  const value=Date.parse(`${day}T00:00:00+07:00`);
  if (!Number.isFinite(value) || new Date(value+7*3_600_000).toISOString().slice(0,10)!==day) throw new RangeError("Invalid Bangkok date");
  return value;
}
export function bangkokMonthBounds(month: string): Interval {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError("Invalid Bangkok month");
  const [year,number]=month.split("-").map(Number);
  const next=new Date(Date.UTC(year,number,1)).toISOString().slice(0,10);
  return {start:bangkokDayStart(`${month}-01`),end:bangkokDayStart(next)};
}

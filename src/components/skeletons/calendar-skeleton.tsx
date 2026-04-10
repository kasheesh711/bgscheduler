/** Shimmer skeleton matching the WeekOverview calendar grid (day headers + time rows). */

const HOUR_COUNT = 14; // 7AM-9PM (inclusive start hours)

export function CalendarSkeleton() {
  return (
    <div className="space-y-1">
      {/* Day headers */}
      <div className="flex gap-2 pl-10">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="h-6 w-12 rounded bg-muted animate-pulse"
          />
        ))}
      </div>

      {/* Time grid rows */}
      <div className="space-y-1">
        {Array.from({ length: HOUR_COUNT }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="h-4 w-8 rounded bg-muted animate-pulse flex-shrink-0" />
            <div className="h-10 flex-1 rounded bg-muted/30 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

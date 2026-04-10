/** Shimmer skeleton matching the SearchForm layout (3-column grid rows). */
export function FormSkeleton() {
  return (
    <>
      {/* Header row: title + recent searches */}
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <div className="h-4 w-14 rounded bg-muted animate-pulse" />
        <div className="h-4 w-20 rounded bg-muted animate-pulse" />
      </div>

      <div className="flex-shrink-0 space-y-2">
        {/* Mode toggle */}
        <div className="flex gap-1.5">
          <div className="h-7 w-16 rounded-md bg-muted animate-pulse" />
          <div className="h-7 w-16 rounded-md bg-muted animate-pulse" />
        </div>

        {/* Row 1: Day/Date, From, To */}
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div className="h-3 w-8 rounded bg-muted animate-pulse mb-1" />
              <div className="h-8 rounded-md bg-muted animate-pulse" />
            </div>
          ))}
        </div>

        {/* Row 2: Duration, Mode, Search button */}
        <div className="grid grid-cols-3 gap-2">
          {[0, 1].map((i) => (
            <div key={i}>
              <div className="h-3 w-10 rounded bg-muted animate-pulse mb-1" />
              <div className="h-8 rounded-md bg-muted animate-pulse" />
            </div>
          ))}
          <div className="flex items-end">
            <div className="h-8 w-full rounded-md bg-muted animate-pulse" />
          </div>
        </div>

        {/* Row 3: Subject, Curriculum, Level */}
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div className="h-3 w-12 rounded bg-muted animate-pulse mb-1" />
              <div className="h-8 rounded-md bg-muted animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

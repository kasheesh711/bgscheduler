/** Full-page shimmer skeleton matching the sales-dashboard shell layout. */
export function SalesDashboardSkeleton() {
  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Header bar: title + action buttons */}
      <div className="flex flex-col gap-3 border-b bg-card px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-6">
        <div className="space-y-2">
          <div className="h-4 w-36 animate-pulse rounded bg-muted" />
          <div className="h-3 w-52 animate-pulse rounded bg-muted/70" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-8 w-36 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      </div>

      {/* Period toolbar: preset buttons + date range */}
      <div className="flex flex-col gap-3 border-b bg-card px-4 py-2 lg:flex-row lg:items-center lg:justify-between lg:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-7 w-20 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="h-8 w-36 animate-pulse rounded-md bg-muted" />
          <div className="h-3 w-4 animate-pulse rounded bg-muted/70" />
          <div className="h-8 w-36 animate-pulse rounded-md bg-muted" />
        </div>
      </div>

      {/* Content: tab strip + revenue hero + panels */}
      <div className="min-h-0 flex-1 overflow-hidden px-4 py-4 lg:px-6">
        <div className="flex items-center gap-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-6 w-20 animate-pulse rounded bg-muted/70" />
          ))}
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="h-56 animate-pulse rounded-lg bg-muted/50" />
          <div className="h-56 animate-pulse rounded-lg bg-muted/40" />
        </div>
        <div className="mt-4 h-72 animate-pulse rounded-lg bg-muted/40" />
      </div>
    </main>
  );
}

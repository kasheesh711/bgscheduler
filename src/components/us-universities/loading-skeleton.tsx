export function UsUniversitiesSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-6" aria-busy="true" aria-label="Loading US Universities">
      <div className="h-8 w-64 animate-pulse rounded-md bg-muted" />
      <div className="h-10 w-full max-w-md animate-pulse rounded-md bg-muted" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-48 animate-pulse rounded-lg border bg-muted/50" />
        ))}
      </div>
    </div>
  );
}

export default function DossierLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6" aria-busy="true" aria-live="polite">
      <div className="h-4 w-32 animate-pulse rounded bg-muted" />
      <div className="space-y-3">
        <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
        <div className="flex gap-2">
          <div className="h-6 w-24 animate-pulse rounded bg-muted" />
          <div className="h-6 w-28 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded bg-muted" />
        ))}
      </div>
      <div className="h-64 w-full animate-pulse rounded bg-muted" />
    </div>
  );
}

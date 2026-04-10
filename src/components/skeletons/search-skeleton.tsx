import { FormSkeleton } from "./form-skeleton";

/** Full-page shimmer skeleton matching the SearchWorkspace side-by-side layout. */
export function SearchSkeleton() {
  return (
    <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
      {/* Left panel: Search */}
      <div className="w-1/2 flex flex-col overflow-hidden min-w-0 border-r border-border/50 pr-3">
        <FormSkeleton />

        {/* Result row placeholders */}
        <div className="space-y-1.5 mt-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-10 rounded-md bg-muted/50 animate-pulse"
            />
          ))}
        </div>
      </div>

      {/* Right panel: Compare */}
      <div className="w-1/2 flex flex-col overflow-hidden min-w-0 pl-1">
        {/* Tutor selector row */}
        <div className="flex items-center gap-2 mb-2 flex-shrink-0">
          <div className="h-7 w-32 rounded-md bg-muted animate-pulse" />
          <div className="h-4 w-8 rounded bg-muted animate-pulse ml-auto" />
        </div>

        {/* Empty compare placeholder */}
        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          <div className="h-4 w-28 rounded bg-muted animate-pulse" />
          <div className="h-3 w-48 rounded bg-muted animate-pulse" />
        </div>
      </div>
    </div>
  );
}

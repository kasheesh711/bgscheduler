import { cn } from "@/lib/utils";
import { TONE_TEXT } from "./atoms";
import { whenAfter } from "./format";

// ----------------------------------------------------------------------------
// What the page says about its own state: what could not refresh or be saved,
// and whether it reloads when it is shown again. Pure, so it is tested without
// a browser; the shell holds the state.
// ----------------------------------------------------------------------------

/** Hidden for at least this long (a visit to another page), the page reloads everything when it is shown again. */
export const RESHOWN_RELOAD_MS = 1_000;

/**
 * Whether the page, shown again, reloads at once. The app keeps it hidden with its state while the owner is on
 * another page (`cacheComponents`): `hiddenAt` is when it was hidden, null on its first mount. A hide and show within
 * the same moment (React's double run of effects in development) is not a visit.
 */
export function reloadsWhenShown(hiddenAt: number | null, now: number): boolean {
  return hiddenAt !== null && now - hiddenAt >= RESHOWN_RELOAD_MS;
}

/**
 * What to say while the review data could not refresh: why, and as of when the review data on the page is (with its
 * date when that is not the dashboard's day). Null when the last review refresh succeeded.
 */
export function staleReviewMessage(reviewError: string | null, reviewGeneratedAt: string | null, dashboardGeneratedAt: string): string | null {
  if (!reviewError) return null;
  const asOf = reviewGeneratedAt
    ? ` The posts to review, the incidents and the pilot health are as of ${whenAfter(dashboardGeneratedAt, reviewGeneratedAt)}.`
    : "";
  return `Review data not refreshed (${reviewError.replace(/\.$/u, "")}).${asOf}`;
}

/**
 * The page's own messages under the system line: everything that went wrong, each on its line, and the note of the
 * last action that went through. The note never gives way to a problem: a Pause that was saved says so while the
 * review data cannot refresh.
 */
export function StatusLines({ problems, note }: { problems: ReadonlyArray<string | null>; note: string | null }) {
  const shown = problems.filter((problem): problem is string => Boolean(problem));
  if (shown.length === 0 && !note) return null;
  return (
    <div className="mt-3 space-y-2">
      {shown.length > 0 ? (
        <div role="status" data-status="problems" className="space-y-1 rounded-md border border-red-300 px-3 py-2 text-xs text-red-700">
          {shown.map((problem) => <p key={problem}>{problem}</p>)}
        </div>
      ) : null}
      {note ? (
        <div role="status" data-status="note" className={cn("rounded-md border border-available/30 px-3 py-2 text-xs", TONE_TEXT.green)}>{note}</div>
      ) : null}
    </div>
  );
}

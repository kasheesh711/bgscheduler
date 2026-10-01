import { Badge } from "@/components/ui/badge";
import type { ReviewQueueItem } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import { FIELD_LABELS, when } from "./format";
import { ARM_LABEL } from "./model-labels";
import { ACTOR_LABEL, OUTCOME_LABEL, REVIEW_STATUS_LABEL, REVIEW_STATUS_TONE, measuredFixesLabel, verdictLabel } from "./review-helpers";

/** The four feedback fields of a draft or a post, in form order. */
export function FeedbackFields({ fields }: { fields: Record<string, string> }) {
  return (
    <div className="space-y-2">
      {Object.entries(FIELD_LABELS).map(([key, label]) => (
        <div key={key}>
          <div className="text-[11px] font-medium">{label}</div>
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{fields[key] || "—"}</p>
        </div>
      ))}
    </div>
  );
}

const CURRENT_SOURCE_LABEL: Record<ReviewQueueItem["current"]["source"], string> = {
  wise_feedback_version: "as Class Feedback last read it from Wise",
  correction: "the last verified correction",
  policy: "the owner's policy re-post (not a fix)",
  first_shot: "unchanged since the first post",
};

/**
 * One posted class as the owner judges it: where its review stands, the immutable first shot next to the current
 * text with the word diff, every save measured in Wise, the corrections and the verdict log. Read-only; the verdict
 * form is the drawer's.
 */
export function ReviewDetail({ item }: { item: ReviewQueueItem }) {
  const reconstructed = item.firstShot.provenance === "backfill";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className={REVIEW_STATUS_TONE[item.status]}>{REVIEW_STATUS_LABEL[item.status]}</Badge>
        {item.currentVerdict ? <Badge variant="outline">{verdictLabel(item.currentVerdict)}</Badge> : null}
        {item.changed ? <Badge variant="outline" className="border-violet-300 text-violet-800 dark:text-violet-200">Changed since first post</Badge> : null}
        {item.measuredFixCount > 0 ? (
          <span className="text-muted-foreground">
            {item.measuredFixCount} measured fix{item.measuredFixCount === 1 ? "" : "es"} ({measuredFixesLabel(item.measuredFixesByActor)})
          </span>
        ) : null}
      </div>

      {item.openFlags.length > 0 ? (
        <ul className="space-y-1 text-xs text-red-700 dark:text-red-300">
          {item.openFlags.map((flag) => (
            <li key={flag.id}>
              Flag ({flag.source}{flag.suggestedSeverity ? `, suggested ${flag.suggestedSeverity}` : ""}): {flag.note ?? "—"}
            </li>
          ))}
        </ul>
      ) : null}
      {item.firstShot.outcome !== "verified" ? (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          {OUTCOME_LABEL[item.firstShot.outcome] ?? item.firstShot.outcome}
          {item.firstShot.problems.length > 0 ? ` (${item.firstShot.problems.join(", ")})` : ""}. Open the class in Wise and judge what is there.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold">First shot</h3>
            <Badge variant="outline" className="text-[10px]">
              {reconstructed ? "reconstructed · hash-verified" : "recorded at post · hash-verified"}
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              posted {when(item.firstShot.postStartedAt)}
              {item.firstShot.arm ? ` · ${ARM_LABEL[item.firstShot.arm] ?? item.firstShot.arm}` : ""}
              {item.firstShot.evidence === "transcript" ? " · transcript" : ""}
            </span>
          </div>
          <FeedbackFields fields={item.firstShot.fields} />
        </div>
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold">Current text</h3>
            <span className="text-[11px] text-muted-foreground">
              {CURRENT_SOURCE_LABEL[item.current.source]}
              {item.current.at ? ` · ${when(item.current.at)}` : ""}
            </span>
          </div>
          {item.changed ? (
            <div className="space-y-2" data-testid="first-shot-diff">
              {item.diff.map((entry) => (
                <div key={entry.field}>
                  <div className="text-[11px] font-medium">{FIELD_LABELS[entry.field]}</div>
                  <p className="whitespace-pre-wrap text-xs">
                    {entry.segments.map((segment, index) => segment.kind === "same"
                      ? <span key={index} className="text-muted-foreground">{segment.text}</span>
                      : segment.kind === "removed"
                        ? <del key={index} className="bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200">{segment.text}</del>
                        : <ins key={index} className="bg-green-100 text-green-900 no-underline dark:bg-green-950 dark:text-green-200">{segment.text}</ins>)}
                  </p>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-muted-foreground">Same as the first shot.</p>}
        </div>
      </div>

      <div className="grid gap-4 border-t pt-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-[13px] font-semibold">Saves in Wise</h3>
          {item.fixEvents.length === 0 ? <p className="text-xs text-muted-foreground">No activity events mirrored yet.</p> : (
            <ul className="space-y-0.5 text-xs">
              {item.fixEvents.map((event) => (
                <li key={event.wiseEventId} className="flex justify-between gap-2">
                  <span>
                    {ACTOR_LABEL[event.actorKind] ?? event.actorKind}
                    {event.counted ? <strong className="ml-1 text-amber-700">· fix</strong> : null}
                    {event.countsAsFix && !event.counted ? <span className="ml-1 text-muted-foreground">· after approval — not counted</span> : null}
                  </span>
                  <span className="text-muted-foreground">{when(event.at)}</span>
                </li>
              ))}
            </ul>
          )}
          {item.corrections.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {item.corrections.map((correction, index) => (
                <li key={index}>
                  {correction.kind === "policy" ? "Policy re-post (not a fix)" : "Correction"} by {correction.actor} ({correction.outcome})
                  {" · "}{correction.reason ?? "—"} · {when(correction.at)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div>
          <h3 className="mb-1 text-[13px] font-semibold">Verdicts</h3>
          {item.verdicts.length === 0 ? <p className="text-xs text-muted-foreground">No verdict yet.</p> : (
            <ul className="space-y-1 text-xs">
              {item.verdicts.map((verdict) => (
                <li key={verdict.id} className={cn(!verdict.current && "text-muted-foreground line-through")}>
                  {verdictLabel(verdict)} · {verdict.reviewer} · {when(verdict.createdAt)}{verdict.note ? ` — ${verdict.note}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

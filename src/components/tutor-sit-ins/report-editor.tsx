"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  RATINGS,
  RATING_LABELS,
  type ReportData,
} from "@/lib/tutor-sit-ins/rubric";
import type { Report } from "@/lib/tutor-sit-ins/client-types";
import { api, control, Notice, panel, when } from "./shared";
export function ReportEditor({
  report,
  editable,
  onSubmit,
}: {
  report: Report;
  editable: boolean;
  onSubmit: () => void;
}) {
  const [data, setData] = useState<ReportData>(report.data),
    [status, setStatus] = useState("Saved"),
    [error, setError] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const revision = useRef(report.revision),
    latest = useRef(data),
    saved = useRef(JSON.stringify(report.data)),
    pending = useRef<Promise<void> | null>(null),
    conflicted = useRef(false),
    mounted = useRef(true);
  latest.current = data;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = useCallback(
    async (submit = false) => {
      if (!editable || conflicted.current) return;
      if (pending.current) {
        await pending.current;
        if (!submit) return;
      }
      if (
        conflicted.current ||
        (!submit && saved.current === JSON.stringify(latest.current))
      )
        return;
      const payload = structuredClone(latest.current);
      setStatus(submit ? "Submitting…" : "Saving…");
      setError("");
      const task = (async () => {
        try {
          const result = await api<Report>(
            "/reports/" + report.id,
            { expectedRevision: revision.current, submit, data: payload },
            "PUT",
          );
          revision.current = result.revision;
          saved.current = JSON.stringify(payload);
          if (mounted.current) setStatus(submit ? "Submitted" : "Saved");
          if (submit) onSubmit();
        } catch (e) {
          if (mounted.current) {
            setError((e as Error).message);
            setStatus("Not saved");
          }
          if (
            /changed|submitted|access|sign in|outside/i.test(
              (e as Error).message,
            )
          )
            conflicted.current = true;
          throw e;
        }
      })();
      pending.current = task;
      try {
        await task;
      } finally {
        pending.current = null;
      }
    },
    [editable, onSubmit, report.id],
  );
  useEffect(() => {
    if (
      !editable ||
      status === "Not saved" ||
      saved.current === JSON.stringify(data) ||
      conflicted.current
    )
      return;
    const timer = window.setTimeout(() => {
      void save().catch(() => undefined);
    }, 900);
    return () => clearTimeout(timer);
  }, [data, editable, save, status]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (editable && saved.current !== JSON.stringify(latest.current)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [editable]);
  const criteria = report.rubric.sections.flatMap((s) => s.criteria),
    answered = criteria.filter((c) => data.scores[c.id] !== undefined).length;
  const total = criteria.reduce((sum, c) => sum + (data.scores[c.id] || 0), 0);
  function change(next: ReportData) {
    setData(next);
    setStatus("Unsaved changes");
  }
  async function submit() {
    setSubmitting(true);
    try {
      await save(true);
    } catch {
      /* Keep the draft and validation error visible. */
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="space-y-4" aria-label="Observation rubric">
      <div className={panel}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Observation report</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Revision {report.reportVersion} · {report.rubric.version}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums">
              {total}
              <span className="text-sm font-normal text-muted-foreground">
                {" "}
                / 100
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {answered} of {criteria.length} criteria rated
            </p>
          </div>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          {report.submittedAt
            ? "Submitted " +
              when(report.submittedAt) +
              (report.late ? " · Late" : "")
            : "Drafts save automatically. Complete every rating and the three short report sections before submitting."}
        </p>
        {editable && (
          <p
            aria-live="polite"
            className={
              "mt-2 text-sm font-medium " +
              (status === "Not saved" ? "text-destructive" : "text-primary")
            }
          >
            {status}
          </p>
        )}
        {error && (
          <div className="mt-3">
            <Notice error>
              {error}
              {conflicted.current &&
                " Keep a copy of your latest text before reloading this page."}
            </Notice>
          </div>
        )}
      </div>
      <fieldset
        disabled={!editable || submitting}
        className="min-w-0 space-y-5"
      >
        {report.rubric.sections.map((section) => (
          <section className={panel} key={section.title}>
            <div className="mb-5 flex items-center justify-between gap-3 border-b pb-3">
              <h3 className="text-lg font-semibold">{section.title}</h3>
              <span className="text-sm tabular-nums text-muted-foreground">
                {section.criteria.reduce(
                  (sum, c) => sum + (data.scores[c.id] || 0),
                  0,
                )}{" "}
                / {section.criteria.length * 10}
              </span>
            </div>
            <div className="space-y-7">
              {section.criteria.map((c) => (
                <fieldset key={c.id} className="min-w-0">
                  <legend className="mb-3 text-sm font-semibold">
                    {c.title}
                  </legend>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {RATINGS.map((score, index) => (
                      <label
                        key={score}
                        className={
                          "flex min-h-16 cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm " +
                          (data.scores[c.id] === score
                            ? "border-primary bg-primary/10 ring-1 ring-primary"
                            : "hover:bg-muted/50")
                        }
                      >
                        <input
                          className="mt-1"
                          type="radio"
                          name={report.id + c.id}
                          checked={data.scores[c.id] === score}
                          value={score}
                          onChange={() =>
                            change({
                              ...data,
                              scores: { ...data.scores, [c.id]: score },
                            })
                          }
                        />
                        <span>
                          <strong className="block">{score}</strong>
                          <span className="text-xs">
                            {RATING_LABELS[index]}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {data.scores[c.id] !== undefined && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {c.guidance[RATINGS.indexOf(data.scores[c.id])]}
                    </p>
                  )}
                  <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="w-fit cursor-pointer py-1">
                      Rating guidance
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {RATINGS.map((r, i) => (
                        <li key={r}>
                          <strong>
                            {r} · {RATING_LABELS[i]}:
                          </strong>{" "}
                          {c.guidance[i]}
                        </li>
                      ))}
                    </ul>
                  </details>
                  <label className="mt-3 block text-xs text-muted-foreground">
                    Evidence notes (optional)
                    <textarea
                      className={control + " mt-1 min-h-20"}
                      maxLength={2000}
                      value={data.notes[c.id] || ""}
                      onChange={(e) =>
                        change({
                          ...data,
                          notes: { ...data.notes, [c.id]: e.target.value },
                        })
                      }
                    />
                  </label>
                </fieldset>
              ))}
            </div>
          </section>
        ))}
        <section className={panel + " space-y-4"}>
          <h3 className="text-lg font-semibold">Reflection and next steps</h3>
          {(
            [
              ["strengths", "Strengths", "What worked well for the learner?"],
              [
                "priorities",
                "Development priorities",
                "What would most improve this tutor’s lessons?",
              ],
              [
                "nextSteps",
                "Next steps",
                "Record specific actions and follow-up.",
              ],
            ] as const
          ).map(([key, label, placeholder]) => (
            <label key={key} className="block text-sm font-medium">
              {label} <span className="text-destructive">*</span>
              <textarea
                required
                maxLength={5000}
                rows={4}
                placeholder={placeholder}
                className={control + " mt-2"}
                value={data[key]}
                onChange={(e) => change({ ...data, [key]: e.target.value })}
              />
            </label>
          ))}
          <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={data.occurred}
              onChange={(e) => change({ ...data, occurred: e.target.checked })}
            />
            <span>
              I confirm that this observation took place and these ratings
              reflect the lesson I observed.
            </span>
          </label>
        </section>
      </fieldset>
      {editable && (
        <div
          className={
            panel + " flex flex-wrap items-center justify-between gap-4"
          }
        >
          <p className="max-w-xl text-sm text-muted-foreground">
            Submission completes this quarter’s assignment. An administrator can
            reopen it as a new revision. Assessment content stays inside this
            dashboard.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={submitting || conflicted.current}
              onClick={() => void save().catch(() => undefined)}
            >
              Save draft
            </Button>
            <Button
              disabled={
                submitting ||
                answered !== criteria.length ||
                !data.occurred ||
                !data.strengths.trim() ||
                !data.priorities.trim() ||
                !data.nextSteps.trim() ||
                conflicted.current
              }
              onClick={() => void submit()}
            >
              {submitting ? "Submitting…" : "Submit report"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

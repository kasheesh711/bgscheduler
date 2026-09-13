"use client";
import { useEffect, useRef, useState } from "react";
import type { JobProgress as Progress } from "@/lib/progress-tests/workspace/progress";
import { API, Button, command, readApi } from "./shared";
import css from "./workspace.module.css";
const steps = [{ id: "queued", label: "Queued" }, { id: "reading", label: "Reading paper" }, { id: "formatting", label: "Formatting" }, { id: "building", label: "Building PDF" }, { id: "checking", label: "Checking" }, { id: "ready", label: "Ready" }];
const duration = (n: number) => n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${n % 60}s`;
export function JobProgress({ id, onFinished, onRetry }: { id: string; onFinished: () => void; onRetry: (id: string) => void }) {
  const [job, setJob] = useState<Progress | null>(null), [error, setError] = useState("");
  const callback = useRef(onFinished), delivered = useRef("");
  useEffect(() => { callback.current = onFinished; }, [onFinished]);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { job: next } = await readApi<{ job: Progress }>(`${API}/jobs/${id}`);
        if (stopped) return;
        setJob(next); setError("");
        if (["completed", "failed", "superseded"].includes(next.status)) {
          if (delivered.current !== id) { delivered.current = id; callback.current(); }
          return;
        }
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : "Unable to check progress."); }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [id]);
  const activeSteps = job?.kind === "convert-paper" ? [{ id: "queued", label: "Queued" }, { id: "converting", label: "Converting DOCX" }, { id: "ready", label: "Ready to preview" }] : steps;
  const index = Math.max(0, activeSteps.findIndex(s => s.id === job?.stage));
  return <div className={css.processing} aria-label="Paper processing progress">
    <div className={css.actions}><strong role="status" aria-live="polite">{job?.status === "failed" ? (job.kind === "convert-paper" ? "Conversion needs attention" : "Formatting needs attention") : activeSteps[index].label}</strong>{job && <span>{duration(job.elapsedSeconds)} elapsed</span>}</div>
    <progress max={activeSteps.length - 1} value={index} aria-label="Processing stages completed" aria-valuetext={activeSteps[index].label}/>
    <ol className={css.processingSteps}>{activeSteps.map((step, i) => <li key={step.id} data-active={index === i} data-done={index > i}>{step.label}</li>)}</ol>
    {job?.estimate && <p className={css.hint}>{job.estimate.takingLonger ? "Taking longer than similar papers. Your progress is saved." : `Approximately ${duration(job.estimate.minSeconds)}–${duration(job.estimate.maxSeconds)} remaining`}</p>}
    {job && ["queued", "running"].includes(job.status) && <p className={css.hint}>{job.retryAt ? "A temporary problem interrupted processing. A retry is scheduled from the saved progress." : "You can leave this page. Processing continues and your PDF will appear here."}</p>}
    {(error || job?.error) && <p role="alert" className={css.hint}>{error || job?.error}</p>}
    {job?.status === "failed" && <Button onClick={async () => { try { const result = await command({ action: "retry-job", id }); if (result.jobId) onRetry(result.jobId); } catch (e) { setError(e instanceof Error ? e.message : "Retry failed."); } }}>Retry saved progress</Button>}
  </div>;
}

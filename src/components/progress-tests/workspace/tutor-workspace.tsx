"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, BookOpen, ClipboardList, FileText, History, LoaderCircle, RefreshCw, Search, Upload, Users } from "lucide-react";
import type { AssessmentDetail, Overview, PaperDetail } from "@/lib/progress-tests/workspace/data";
import { AssessmentEditor, STAGE_LABELS } from "./assessment-editor";
import { PaperEditor } from "./paper-editor";
import { Button, Empty, Field, command, fileUrl, formatDate, type Serialized } from "./shared";
import { hasUploadIssue, milestoneSession, publicationLabel, taskKind, tutorRows, type TaskKind, type TutorView } from "./tutor-view-model";
import legacy from "./workspace.module.css";
import css from "./tutor-workspace.module.css";

type Detail = { kind: "assessment"; data: Serialized<AssessmentDetail> } | { kind: "paper"; data: Serialized<PaperDetail> };
type Props = { overview: Serialized<Overview>; detail: Detail | null; loading: boolean; error: string; onError: (error: string) => void; open: (kind: "assessment" | "paper", id: string) => Promise<void>; close: () => void; refresh: () => Promise<unknown>; saved: () => Promise<void> };
const views = [{ id: "tasks", label: "Tasks", icon: ClipboardList }, { id: "students", label: "My students", icon: Users }, { id: "library", label: "Test library", icon: BookOpen }, { id: "history", label: "History", icon: History }] as const;
const filters = [{ id: "all", label: "All tasks" }, { id: "preparation", label: "Preparation" }, { id: "submission", label: "Submission" }, { id: "review", label: "Review" }, { id: "upload", label: "Upload issues" }] as const;

export function TeacherProgressWorkspace({ overview, detail, loading, error, onError, open, close, refresh, saved }: Props) {
  const [view, setView] = useState<TutorView>("tasks");
  const [filter, setFilter] = useState<TaskKind | "all">("all");
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState("system");
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const allowDeparture = useRef(false);
  const pending = useRef<() => void>(() => {});
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => { try { const value = localStorage.getItem("begifted-tutor-theme-v1"); if (value && ["light", "dark", "system"].includes(value)) setTheme(value); } catch {} }, []);
  const changeTheme = (value: string) => { setTheme(value); try { localStorage.setItem("begifted-tutor-theme-v1", value); } catch {} };
  const hasEdits = dirty || creating && title.trim().length > 0;
  const guard = (action: () => void) => {
    if (!hasEdits) { action(); return; }
    pending.current = action; returnFocus.current = document.activeElement as HTMLElement; dialog.current?.showModal();
  };
  useEffect(() => {
    if (!hasEdits) return;
    allowDeparture.current = false;
    const beforeUnload = (event: BeforeUnloadEvent) => { if (allowDeparture.current) return; event.preventDefault(); event.returnValue = ""; };
    // Shared navigation belongs to the application. Guard only departure while this record has edits.
    const leave = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || root.current?.contains(link) || link.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); pending.current = () => { window.location.assign(link.href); };
      returnFocus.current = link; dialog.current?.showModal();
    };
    window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", leave, true); };
  }, [hasEdits]);
  const navigate = (next: TutorView) => guard(() => { close(); setDirty(false); setCreating(false); setTitle(""); setView(next); setQuery(""); onError(""); });
  const tasks = overview.assessments.filter(a => taskKind(a) !== null);
  const rows = tutorRows(overview.assessments, view, query, filter);
  const papers = overview.papers.filter(p => p.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const jobs = overview.jobs.filter(j => !detail || j.targetId === detail.data.id || detail.kind === "assessment" && [...detail.data.publications, ...detail.data.preparationPublications].some(p => p.id === j.targetId)).filter(j => j.status !== "completed").slice(0, 8);
  const back = () => guard(() => { close(); setDirty(false); });
  return <div ref={root} className={css.surface} data-begifted-surface="tutor-progress" data-theme={theme}>
    <div className={css["bg-brandbar"]}>
      {/* Exact released artwork; no redrawn wordmark. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/tutor-progress/logo.png" width="150" height="52" alt="BeGifted"/>
      <span className={css["bg-brandlabel"]}>TUTOR WORKSPACE</span>
      <div className={css["bg-brandtools"]}><select aria-label="Workspace appearance" value={theme} onChange={e => changeTheme(e.target.value)}><option value="system">System theme</option><option value="light">Light theme</option><option value="dark">Dark theme</option></select></div>
    </div>
    <div className={css["bg-content"]}>
      <header className={css["bg-title"]}><div><span className={css["bg-eyebrow"]}>A LITTLE CHECK. A BIG STEP FORWARD.</span><h1>Progress Tests<span>.</span></h1></div><details><summary>How it works</summary><p>Class 6: Prepare a paper.<br/>Class 7: Share revision topics.<br/>Class 8: Assess during class.</p></details></header>
      <nav className={css["bg-tabs"]} aria-label="Progress test views">{views.map(t => <button key={t.id} aria-current={view === t.id ? "page" : undefined} onClick={() => navigate(t.id)}><t.icon size={17}/>{t.label}{t.id === "tasks" && <span>{tasks.length}</span>}</button>)}</nav>
      {!overview.activatedAt && <div className={legacy.notice}>Launch pending. Your class counters will start at zero when the workflow launches. You can prepare your test library now.</div>}
      {error && <div className={legacy.error} role="alert">{error}</div>}
      {loading ? <div className={legacy.loading} role="status"><LoaderCircle className={legacy.spinner}/>Opening record…</div> : detail ? <>
        {!overview.capabilities.uploads && <div className={legacy.notice}>Uploads and PDF generation are unavailable. Existing papers and reviewed work remain available.</div>}
        {detail.kind === "assessment" ? <AssessmentEditor key={detail.data.id} guided data={detail.data} overview={overview} onBack={back} onSaved={saved} onError={onError} onDirtyChange={setDirty}/> : <PaperEditor key={detail.data.id} guided data={detail.data} overview={overview} onBack={back} onSaved={saved} onError={onError} onDirtyChange={setDirty}/>}
      </> : <>
        <div className={css["bg-sectionhead"]}><div><h2>{view === "tasks" ? "Your next steps" : view === "students" ? "Every student. Every cycle." : view === "library" ? "Your papers, ready to reuse." : "A record of learning."}</h2><p>{view === "tasks" ? `${tasks.length} assessments need attention${tasks.some(a => a.overdue) ? ` · ${tasks.filter(a => a.overdue).length} overdue` : ""}.` : view === "students" ? "All assessments, from early preparation to approved results." : view === "library" ? "Original papers first. Private marking keys. Optional AI formatting." : "Approved reports and their publication status."}</p></div><div className={legacy.actions}>{view === "library" && <Button variant="primary" onClick={() => setCreating(true)}><Upload size={16}/>New paper</Button>}<Button aria-label="Refresh workspace" variant="quiet" onClick={() => { void refresh().catch(e => onError(e.message)); }}><RefreshCw size={16}/></Button></div></div>
        <div className={css["bg-toolbar"]}><label className={css["bg-search"]}><Search size={17}/><input aria-label="Search progress tests" placeholder={view === "library" ? "Find a paper…" : "Find a student or course…"} value={query} onChange={e => setQuery(e.target.value)}/></label>{view === "tasks" && <div className={css["bg-filters"]} aria-label="Task filters">{filters.map(f => <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}</div>}</div>
        {view === "library" ? <>
          {creating && <form className={legacy.createPaper} onSubmit={async e => { e.preventDefault(); setBusy(true); onError(""); try { const created = await command({ action: "create-paper", title }); setCreating(false); setTitle(""); await refresh(); await open("paper", created.id!); } catch(e) { onError(e instanceof Error ? e.message : "Unable to create paper."); } finally { setBusy(false); } }}><Field label="Paper title"><input autoFocus value={title} onChange={e => setTitle(e.target.value)} required maxLength={300} placeholder="e.g. Algebra essentials"/></Field><Button type="submit" variant="primary" disabled={busy || !title.trim()}>Create paper</Button><Button onClick={() => guard(() => { setCreating(false); setTitle(""); })}>Cancel</Button></form>}
          {papers.length ? <div className={css["bg-library"]}>{papers.map(p => <button key={p.id} className={css["bg-paper-card"]} onClick={() => guard(() => { void open("paper", p.id); })}><div className={css["bg-paper-icon"]}><FileText size={30}/><span>YOUR ORIGINAL & VERSIONS</span></div><h3>{p.title}</h3><p>{p.revision ? `Revision ${p.revision}` : "New draft"} · {formatDate(p.createdAt)}</p><footer>Private tutor library<span>Open paper <ArrowRight size={14}/></span></footer></button>)}</div> : <Empty title={query ? "No matching papers" : "Start with your first paper"}>Upload your own PDF or DOCX, preview it, and mark it ready to reuse.</Empty>}
        </> : rows.length ? <div className={css["bg-table"]}>
          <div className={css["bg-tablehead"]} aria-hidden="true"><span>STUDENT / COURSE</span><span>EIGHT-CLASS CYCLE</span><span>NEXT MILESTONE</span><span>ACTION</span></div>
          {rows.map(a => <article className={css["bg-row"]} key={a.id} aria-label={`${a.series.studentName}, ${a.series.courseName}, cycle ${a.cycle}`}>
            <div className={css["bg-student"]}><span className={css["bg-avatar"]} aria-hidden="true">{a.series.studentName.split(/\s+/).slice(0, 2).map(n => n[0]).join("")}</span><div><h3>{a.series.studentName}</h3><p>{a.series.courseName}</p></div></div>
            <div className={css["bg-progress"]}><div><strong>{a.position} <span>/ 8 classes</span></strong><small>CYCLE {a.cycle}</small></div><div className={css["bg-meter"]} role="meter" aria-label="Classes completed in cycle" aria-valuenow={a.position} aria-valuemin={0} aria-valuemax={8}>{Array.from({ length: 8 }, (_, i) => <i key={i} data-filled={i < a.position}/>)}</div><p>{a.series.count} classes with this tutor</p></div>
            <div className={css["bg-milestone"]}><span className={`${css["bg-badge"]} ${a.overdue ? css["bg-warning"] : hasUploadIssue(a) ? css["bg-failure"] : a.stage === "approved" ? css["bg-success"] : ""}`}>{a.overdue ? "Overdue · " : ""}{hasUploadIssue(a) ? "Upload issue" : STAGE_LABELS[a.stage]}</span><p>Class {a.dueClass} · {a.stage === "approved" ? "Cycle complete" : a.series.count >= a.dueClass ? "Assessment due" : formatDate(milestoneSession(a))}</p>{publicationLabel(a, overview.publication.ready) && <small>{publicationLabel(a, overview.publication.ready)}</small>}</div>
            <button className={css["bg-rowaction"]} onClick={() => { void open("assessment", a.id); }}>{hasUploadIssue(a) ? "Review upload" : a.stage === "prepare" ? "Prepare test" : a.stage === "ready" ? "View preparation" : a.stage === "awaiting_submission" ? "Submit work" : a.stage === "tutor_review" ? "Review results" : "View report"}<ArrowRight size={15}/></button>
          </article>)}
        </div> : <Empty title={query ? "No matching assessments" : view === "tasks" ? "All clear in this view" : view === "history" ? "Progress takes shape here" : "Your students will appear here"}>{view === "tasks" ? "Try another filter, or open My students for the complete overview." : "Assessments appear after verified classes. Approved results are kept in History."}</Empty>}
      </>}
      {jobs.length > 0 && <details className={css.activity} open={jobs.some(j => j.status === "failed")}><summary>Processing activity · {jobs.length}</summary><p>Original files remain available while optional jobs run.</p>{jobs.map(j => <div className={legacy.job} key={j.id}><div><strong>{({ "convert-paper": "Convert original DOCX", "format-paper": "Optional AI formatting · Beta", "parse-paper": "Format paper", "render-paper": "Paper PDF", grade: "AI grading draft · Beta", report: "AI report draft · Beta", "render-review": "Review PDFs", "publish-preparation": "Paper upload", publish: "Report publication" } as Record<string, string>)[j.kind] ?? j.kind.replaceAll("-", " ")}</strong><p>{j.error}</p></div><span>{j.status === "queued" && !overview.publication.ready && ["publish", "publish-preparation"].includes(j.kind) ? "Paused" : j.status.replaceAll("_", " ")}</span>{j.status === "failed" && <Button onClick={async () => { try { await command({ action: "retry-job", id: j.id }); await refresh(); } catch(e) { onError(e instanceof Error ? e.message : "Retry failed."); } }}>Retry</Button>}{typeof j.result?.fileId === "string" && <a href={`${fileUrl(j.result.fileId)}?download=1`}>Download PDF</a>}</div>)}</details>}
      <footer className={css["bg-footer"]}><span>Bangkok dates · Original papers · Tutor-reviewed results</span>{!overview.publication.ready && <span>Wise publishing paused · Preparation and grading remain available</span>}</footer>
    </div>
    <dialog ref={dialog} className={css["bg-dialog"]} aria-labelledby="tutor-discard-title" onClose={() => returnFocus.current?.focus()}><h2 id="tutor-discard-title">Leave unsaved changes?</h2><p>Your last saved version will be kept. Changes since then will be discarded.</p><div className={legacy.actions}><Button autoFocus onClick={() => dialog.current?.close()}>Keep editing</Button><Button variant="primary" onClick={() => { allowDeparture.current = true; dialog.current?.close(); setDirty(false); setCreating(false); setTitle(""); pending.current(); }}>Discard changes</Button></div></dialog>
  </div>;
}

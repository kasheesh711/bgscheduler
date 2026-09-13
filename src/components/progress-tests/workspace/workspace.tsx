"use client";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ArrowRight, BookOpen, CheckCheck, Clock3, FileText, History, LoaderCircle, Plus, RefreshCw, Search, Users } from "lucide-react";
import type { AssessmentDetail, Overview, PaperDetail } from "@/lib/progress-tests/workspace/data";
import { API, Button, Empty, Field, command, fileUrl, formatDate, readApi, type Serialized } from "./shared";
import { AssessmentEditor, STAGE_LABELS } from "./assessment-editor";
import { PaperEditor } from "./paper-editor";
import { PracticeGuide } from "./practice-guide";
import css from "./workspace.module.css";

type Tab = "students" | "library" | "grading" | "history";
type Detail = { kind: "assessment"; data: Serialized<AssessmentDetail> } | { kind: "paper"; data: Serialized<PaperDetail> };
const tabs = [{ id:"students", label:"My students", icon:Users }, { id:"library", label:"Test library", icon:BookOpen }, { id:"grading", label:"Grading queue", icon:CheckCheck }, { id:"history", label:"History", icon:History }] as const;

export function TutorProgressWorkspace() {
  const [overview, setOverview] = useState<Serialized<Overview> | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("students");
  const [theme, setTheme] = useState("system");
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("");
  const [attention, setAttention] = useState("all");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [createOwner, setCreateOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { const data = await readApi<Serialized<Overview>>(API); setOverview(data); return data; }, []);
  const open = useCallback(async (kind: "assessment" | "paper", id: string) => {
    setError(""); setLoadingDetail(true);
    try {
      if (kind === "assessment") setDetail({ kind, data:await readApi<Serialized<AssessmentDetail>>(`${API}/assessments/${id}`) });
      else setDetail({ kind, data:await readApi<Serialized<PaperDetail>>(`${API}/papers/${id}`) });
      window.scrollTo({ top:0,behavior:"instant" });
    } catch(e) { setError(e instanceof Error ? e.message : "Unable to open record."); }
    finally { setLoadingDetail(false); }
  }, []);
  useEffect(() => {
    let mounted = true;
    load().catch(e => { if (mounted) setError(e.message); });
    const assessment = new URL(window.location.href).searchParams.get("assessment");
    if (assessment && /^[0-9a-f-]{36}$/.test(assessment)) void open("assessment",assessment);
    return () => { mounted = false; };
  }, [load,open]);
  const running = overview?.jobs.some(j => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load().catch(() => undefined); },5000);
    return () => clearInterval(timer);
  }, [running,load]);
  const refreshed = async () => {
    await load();
    if (detail) {
      if (detail.kind === "paper") setDetail({ kind:"paper",data:await readApi<Serialized<PaperDetail>>(`${API}/papers/${detail.data.id}`) });
      else setDetail({ kind:"assessment",data:await readApi<Serialized<AssessmentDetail>>(`${API}/assessments/${detail.data.id}`) });
    }
  };
  if (!overview) return <div className={css.workspace} data-begifted-surface="ops">{error ? <div role="alert" className={css.error}>{error}<Button onClick={() => { setError(""); void load().catch(e => setError(e.message)); }}>Retry</Button></div> : <div role="status" className={css.loading}><LoaderCircle className={css.spinner}/>Loading your workspace…</div>}</div>;
  const all = overview.assessments.filter(a => !owner || a.series.ownerKey === owner);
  const active = all.filter(a => a.stage !== "approved");
  const filtered = all.filter(a => `${a.series.studentName} ${a.series.courseName} ${a.series.tutorName}`.toLowerCase().includes(search.toLowerCase()))
    .filter(a => attention === "all" || (attention === "overdue" ? a.overdue : ["blocked", "failed", "uncertain", "needs_review"].includes(a.publicationStatus)));
  const rows = filtered.filter(a => attention === "publication" || (tab === "grading" ? a.stage === "tutor_review" || a.stage === "awaiting_submission" : tab === "history" ? a.stage === "approved" || a.cycle * 8 < a.series.count : a.stage !== "approved"));
  const hasFilters = !!search || !!owner || attention !== "all";
  const papers = overview.papers.filter(p => (!owner || p.ownerKey === owner) && p.title.toLowerCase().includes(search.toLowerCase()));
  const legacy = overview.legacy.filter(r => (!owner || r.ownerKey === owner) && `${r.student} ${r.course} ${r.tutor}`.toLowerCase().includes(search.toLowerCase()));
  const jobList = overview.jobs.filter(j => !detail || j.targetId === detail.data.id || (detail.kind==="assessment" && detail.data.publications.some(p=>p.id===j.targetId))).slice(0,detail ? 8 : 5);
  const renderRow = (a: Serialized<Overview>["assessments"][number]) => {
    const discussion = a.series.upcomingSessions[a.discussionClass-a.series.count-1];
    const test = a.series.upcomingSessions[a.dueClass-a.series.count-1];
    return <div className={css.row} key={a.id}><div className={css.student}><div className={css.avatar}>{a.series.studentName.split(/\s+/).slice(0,2).map(x => x[0]).join("")}</div><div><h3>{a.series.studentName}</h3><p>{a.series.courseName}</p>{overview.user.role === "admin" && <p>{a.series.tutorName}</p>}</div></div>
      <div className={css.countBlock}><div className={css.cycle}><span>{a.position} / 8 classes</span><small>CYCLE {a.cycle}</small></div><div className={css.meter} aria-label={`${a.position} of 8 classes completed`}>{Array.from({ length:8 },(_,i) => <span key={i} data-filled={i<a.position}/>)}</div><small>{a.series.count} total with this tutor</small></div>
      <div className={css.next}><span className={`${css.badge} ${a.overdue ? css.warning : a.stage === "approved" ? css.success : ""}`}>{a.overdue ? "Overdue · " : ""}{STAGE_LABELS[a.stage]}</span><p>{a.series.count < a.discussionClass ? `Class ${a.discussionClass} · ${formatDate(discussion?.date)}` : a.preparation.studentInformed ? "Topics shared with student" : "Confirm topics with student"}</p><small>{a.series.count < a.dueClass ? `Test: ${formatDate(test?.date)}` : `Test due in class ${a.dueClass}`}</small></div>
      <div className={css.rowAction}><Button onClick={() => open("assessment",a.id)}>{a.nextAction}<ArrowRight size={14}/></Button>{a.stage === "approved" && <small>{a.publicationStatus === "published" ? "Published to Wise" : "Publication pending"}</small>}</div></div>;
  };
  return <div className={css.workspace} data-begifted-surface="ops" data-theme={theme}>
    <div className={css.actions} style={{justifyContent:"space-between",marginBottom:12}}><PracticeGuide admin={overview.user.role==="admin"} theme={theme}/><label className={css.theme}><span>Appearance</span><select aria-label="Workspace appearance" value={theme} onChange={event => setTheme(event.target.value)}><option value="system">System theme</option><option value="light">Light theme</option><option value="dark">Dark theme</option></select></label></div>
    <div className={css.hero}><div><div className={css.topline}><span className={css.brandDot}/>BeGifted · Tutor workspace</div><h1>Progress Tests</h1><p>Thoughtful assessments. Clear next steps.<br/>Prepare, review and share each student’s progress, every eight classes.</p></div><div className={css.heroAside}>{[{ n:6,label:"Prepare",text:"Reminder arrives" },{ n:7,label:"Discuss",text:"Share the topics" },{ n:8,label:"Assess",text:"Test within class" }].map(m => <div className={css.milestone} key={m.n}><span>Class {m.n}</span><strong>{m.label}</strong><p>{m.text}</p></div>)}</div></div>
    {!overview.activatedAt && <div className={css.notice}><Clock3 size={18}/><div><strong>Launch pending</strong><p>Class counters will start at zero when this workflow launches. You can prepare your personal test library now.</p></div></div>}
    {!detail && <div className={css.stats}>{[{ label:"Student courses",value:new Set(all.map(a => a.series.id)).size,note:"Tracked separately for each tutor" },{ label:"Preparation needed",value:active.filter(a => a.stage === "prepare").length,note:"Choose papers and share topics" },{ label:"Ready for review",value:active.filter(a => a.stage === "tutor_review").length,note:"Check marks and progress reports" },{ label:"Overdue",value:active.filter(a => a.overdue).length,note:"Earlier cycles stay on your list" }].map(s => <div className={css.stat} key={s.label}><span>{s.label}</span><strong>{s.value}</strong><small>{s.note}</small></div>)}</div>}
    <nav className={css.tabs} role="tablist" aria-label="Progress test views">{tabs.map((t,index) => <button key={t.id} id={`pt-tab-${t.id}`} role="tab" aria-controls="pt-tab-panel" aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} onKeyDown={event => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next !== null) { event.preventDefault(); setTab(tabs[next].id); setDetail(null); setError(""); document.getElementById(`pt-tab-${tabs[next].id}`)?.focus(); }
    }} onClick={() => { setTab(t.id); setDetail(null); setError(""); }}><t.icon size={17}/>{t.label}{t.id === "grading" && active.some(a => a.stage==="tutor_review") && <small>{active.filter(a => a.stage==="tutor_review").length}</small>}</button>)}</nav>
    {error && <div className={css.error} role="alert">{error}</div>}
    {detail && !overview.capabilities.uploads && <div className={css.notice}><FileText size={18}/><p>File uploads and PDF generation are not available yet. You can still prepare papers, edit marking rubrics and save your work.</p></div>}
    <section id="pt-tab-panel" role="tabpanel" aria-labelledby={`pt-tab-${tab}`}>
    {loadingDetail ? <div className={css.loading} role="status"><LoaderCircle className={css.spinner}/>Opening record…</div> : detail ? <>
      <div className={css.actions} style={{ justifyContent:"flex-end",marginBottom:10 }}><Button variant="quiet" onClick={() => { void refreshed().catch(e => setError(e.message)); }}><RefreshCw size={14}/>Refresh saved results</Button></div>
      {detail.kind === "paper" ? <PaperEditor key={`${detail.data.id}:${detail.data.revision}`} data={detail.data} overview={overview} onBack={() => { setDetail(null);setTab("library"); }} onSaved={refreshed} onError={setError}/> : <AssessmentEditor key={`${detail.data.id}:${detail.data.revision}`} data={detail.data} overview={overview} onBack={() => setDetail(null)} onSaved={refreshed} onError={setError}/>}
    </> : <>
      <div className={css.toolbar}><div><h2>{{ students:"Your students, at a glance",library:"Your test library",grading:"Ready for your attention",history:"A record of progress" }[tab]}</h2><p>{{ students:"Each course follows its own eight-class cycle.",library:"Create once, review carefully, reuse with confidence.",grading:"Submit completed work, review results and approve the final documents.",history:"Earlier cycles and reviewed versions are preserved here." }[tab]}</p></div><div className={css.filters}><label><Search size={15}/><input aria-label="Search progress tests" placeholder={tab === "library" ? "Find a test paper…" : "Find a student or course…"} value={search} onChange={e => setSearch(e.target.value)}/></label>{overview.user.role === "admin" && <select aria-label="Filter by tutor" value={owner} onChange={e => setOwner(e.target.value)}><option value="">All tutors</option>{overview.tutors.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}</select>}{tab === "library" ? <Button variant="primary" onClick={() => setCreating(!creating)}><Plus size={15}/>New paper</Button> : <Button variant="quiet" aria-label="Refresh workspace" onClick={() => { void load().catch(e => setError(e.message)); }}><RefreshCw size={16}/></Button>}</div></div>
      {overview.user.role === "admin" && tab !== "library" && <div className={css.filters} style={{marginBottom:16}}><select aria-label="Attention queue" value={attention} onChange={e => setAttention(e.target.value)}><option value="all">All assessments</option><option value="overdue">Overdue work</option><option value="publication">Publication needs attention</option></select><Button disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { await readApi(`${API}/sync`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" }); await load(); }
        catch (error) { setError(error instanceof Error ? error.message : "Synchronization failed."); }
        finally { setBusy(false); }
      }}><RefreshCw size={14}/>{busy ? "Synchronizing…" : "Sync attendance"}</Button></div>}
      {tab === "library" ? <>{creating && <form className={css.createPaper} onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { const created = await command({ action:"create-paper",title,ownerKey:createOwner || owner || overview.tutors[0]?.key }); setCreating(false);setTitle("");await load();await open("paper",created.id!); } catch(e) { setError(e instanceof Error ? e.message : "Unable to create paper."); } finally { setBusy(false); } }}><Field label="Paper title"><input value={title} onChange={e => setTitle(e.target.value)} required placeholder="e.g. Algebra — topic test"/></Field>{overview.user.role === "admin" && <Field label="Tutor who owns this paper"><select value={createOwner || owner || overview.tutors[0]?.key} onChange={e => setCreateOwner(e.target.value)}>{overview.tutors.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}</select></Field>}<Button type="submit" variant="primary" disabled={busy || !title.trim() || !overview.tutors.length}>Create paper</Button></form>}
        {papers.length ? <div className={css.library}>{papers.map(p => <button className={css.paperCard} key={p.id} onClick={() => open("paper",p.id)}><FileText size={28}/><h3>{p.title}</h3><p>{p.revision ? `Version ${p.revision}` : "New draft"} · {formatDate(p.createdAt)}</p>{overview.user.role === "admin" && <p>{overview.tutors.find(t => t.key===p.ownerKey)?.name || "Tutor identity needs review"}</p>}<span>Open paper →</span></button>)}</div> : <Empty title="Start with your first test paper">Upload a PDF or DOCX, or write the questions yourself. Your papers and marking keys belong to your personal library.</Empty>}
      </> : rows.length ? <div className={css.list}>{rows.map(renderRow)}</div> : <Empty title={hasFilters ? "No matching assessments" : tab === "grading" ? "Your queue is clear" : tab === "history" ? "Progress takes shape here" : "Your students will appear here"}>{hasFilters ? "Try another name, course, tutor or attention filter." : tab === "grading" ? "Completed tests will appear here for your review. Upcoming preparation stays in My students." : tab === "history" ? "Reviewed results and earlier cycles will appear as students complete their assessments." : "After launch, verified teaching sessions will connect each student and course to the tutor who taught them."}</Empty>}
      {tab === "history" && overview.user.role === "admin" && <section className={css.jobs}><h3>Before this workflow launched</h3><p className={css.hint}>Previous enrollment records are preserved as history. They do not contribute to the new counters.</p>{legacy.length ? legacy.map(r => <div className={css.job} key={r.id}><div><strong>{r.student} · {r.course}</strong><p>{r.tutor || "Tutor was unresolved"} · {r.count} classes in the previous cycle</p></div><span>{r.status.replaceAll("_", " ")} · {formatDate(r.date)}</span></div>) : <p className={css.hint}>No previous records match these filters.</p>}</section>}
      {overview.user.role === "admin" && overview.unresolved.length > 0 && <section className={css.jobs}><h3>Instructor identities needing review</h3><p className={css.hint}>Resolve these instructor bindings in Wise / Tutor Profiles, then synchronize again. These records grant no tutor access.</p>{overview.unresolved.map(r => <div className={css.job} key={r.id}><strong>{r.student} · {r.course}</strong><span>{formatDate(r.date)}</span></div>)}</section>}
    </>}
    </section>
    {jobList.length > 0 && <section className={css.jobs}><h3>Processing activity {running && <LoaderCircle size={14} className={css.spinner}/>}</h3><p className={css.hint}>Jobs continue when you leave. Refresh saved results after processing finishes.</p>{jobList.map(j => <div className={css.job} key={j.id}><div><strong>{{ "parse-paper":"Format paper", "render-paper":"Paper PDF",grade:"Grade student work",report:"Draft progress report","render-review":"Review PDFs" }[j.kind] || j.kind}</strong><p>{j.error}</p></div><span>{j.status.replaceAll("_"," ")}</span><div className={css.actions}>{j.status === "failed" && <Button variant="quiet" onClick={async () => { try { await command({ action:"retry-job",id:j.id });await load(); } catch(e) { setError(e instanceof Error ? e.message : "Retry failed."); } }}>Retry</Button>}{j.status === "completed" && typeof j.result?.fileId === "string" && <a href={fileUrl(j.result.fileId)} target="_blank" rel="noreferrer">Open PDF ↗</a>}</div></div>)}</section>}
    {overview.user.role === "admin" && <section className={css.jobs}><h3>Workspace administration</h3><p className={css.hint}>One-to-one courses only. Publication can be paused while preparation, grading and counters continue.</p><div className={css.actions}>
      {!overview.activatedAt && <Button disabled={busy || !overview.publication.configured} onClick={async()=>{setBusy(true);try{await command({action:"activate"});await load();}catch(e){setError(e instanceof Error?e.message:"Activation failed.");}finally{setBusy(false);}}}>Activate workflow and publishing</Button>}
      <Button disabled={busy || !overview.publication.configured} onClick={async()=>{setBusy(true);try{await command({action:"publishing",enabled:overview.publication.paused,expectedRevision:overview.publication.revision});await load();}catch(e){setError(e instanceof Error?e.message:"Unable to change publishing.");}finally{setBusy(false);}}}>{overview.publication.paused?"Resume Wise publishing":"Pause Wise publishing"}</Button>
    </div>{overview.sourceIssues.length>0&&<details><summary>Course identities needing review · {overview.sourceIssues.length}</summary>{overview.sourceIssues.map(i=><p key={i.sourceKey}>{i.studentName} · {i.courseName}: {i.reason}</p>)}</details>}</section>}
    {overview.user.role === "admin" && !overview.publication.ready && <div className={css.notice} style={{ marginTop:24 }}><AlertCircle size={18}/><div><strong>Wise publishing</strong><p>{overview.publication.reason}</p></div></div>}
  </div>;
}

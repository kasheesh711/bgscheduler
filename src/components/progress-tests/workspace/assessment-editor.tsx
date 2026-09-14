"use client";
import { useState } from "react";
import { ArrowLeft, CheckCheck, ClipboardCheck, FileText, RefreshCw, Sparkles } from "lucide-react";
import type { AssessmentDetail, Overview } from "@/lib/progress-tests/workspace/data";
import { emptyReport, validateMarks, isOriginalPaper, isUploadedReview, scoreTotals, sameJsonValue, cleanReport, type Mark, type PageRef, type Report } from "@/lib/progress-tests/workspace/model";
import type { Command } from "@/lib/progress-tests/workspace/commands";
import { Button, Field, PageOrder, UploadField, command, useSavedDraft, formatDate, fileUrl, type Serialized, type Uploaded } from "./shared";
import css from "./workspace.module.css";
import { PdfViewer } from "./pdf-viewer";
import { AssessmentPaperPreparation } from "./paper-editor";

export const STAGE_LABELS = { prepare: "Prepare", ready: "Ready", awaiting_submission: "Awaiting submission", tutor_review: "Tutor review", approved: "Approved" };
export function AssessmentEditor({ data, overview, onBack, onSaved, onError }: { data: Serialized<AssessmentDetail>; overview: Serialized<Overview>; onBack: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const current = data.reviews.find(r => r.id === data.currentReviewId);
  const selectedPaper = data.versions.find(v => v.version.id === data.preparation.paperVersionId)?.version;
  const paperContent = selectedPaper?.paper;
  const currentPaper = paperContent && !isOriginalPaper(paperContent) ? paperContent : null;
  const uploadedReview = current && isUploadedReview(current.data) ? current.data : null;
  const [manual, setManual] = useSavedDraft(!!uploadedReview || !!paperContent && isOriginalPaper(paperContent));
  const [markedFileId, setMarkedFileId] = useSavedDraft<string | null>(uploadedReview?.markedFileId ?? null);
  const [earned, setEarned] = useSavedDraft(uploadedReview?.earned.toString() ?? "");
  const [possible, setPossible] = useSavedDraft(uploadedReview?.possible.toString() ?? "");
  const [paperId, setPaperId] = useSavedDraft(data.preparation.paperVersionId ?? "");
  const [topics, setTopics] = useSavedDraft(data.preparation.topics);
  const [informed, setInformed] = useSavedDraft(data.preparation.studentInformed);
  const [sessionId, setSessionId] = useState("");
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [order, setOrder] = useState<PageRef[]>([]);
  const [marks, setMarks] = useSavedDraft<Mark[]>((current && !isUploadedReview(current.data) ? current.data.marks : undefined) ?? currentPaper?.questions.map(q => ({ questionId:q.id, marks:0, explanation:"", answerReference:"", needsReview:true })) ?? []);
  const [report, setReport] = useSavedDraft<Report>(current?.data.report ?? { ...emptyReport(), contextLimitations: data.feedback.length ? "" : "Verified class feedback from this tutor was unavailable for this cycle." });
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const paperArtifacts = data.paperArtifacts.filter(a => a.versionId === paperId);
  const displayPreview = preview ?? (!data.currentSubmissionId ? paperArtifacts.find(a => a.kind === "paper")?.fileId : data.artifacts.find(a => a.reviewId === data.currentReviewId)?.fileId);
  const sameReview = !!current && (isUploadedReview(current.data) ? manual && current.data.markedFileId === markedFileId && earned.trim() !== "" && possible.trim() !== "" && current.data.earned === Number(earned) && current.data.possible === Number(possible) : !manual && sameJsonValue(current.data.marks, marks)) && sameJsonValue(current.data.report, cleanReport(report));
  const artifacts = data.artifacts.filter(a => a.reviewId === data.currentReviewId);
  const totals = (() => { try { return manual ? earned.trim() && possible.trim() ? scoreTotals(Number(earned), Number(possible)) : null : currentPaper ? validateMarks(currentPaper,marks) : null; } catch { return null; } })();
  const run = async (c: Command) => {
    setBusy(true); onError(""); setMessage("");
    try { const result = await command(c); setMessage(result.jobId ? "Processing started. You can close this page; your job will continue." : c.action === "approve" ? "Results approved. Both documents are queued for Wise publication." : "Saved."); await onSaved(); }
    catch (e) { onError(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  };
  const target = { id: data.id, expectedRevision: data.revision };
  const saveReview = () => manual ? markedFileId && totals && run({ action: "save-marked-review", ...target, markedFileId, earned: Number(earned), possible: Number(possible), report }) : run({ action: "save-review", ...target, marks, report });
  const setMark = (id: string, patch: Partial<Mark>) => { setMarks(marks.map(m => m.questionId === id ? { ...m,...patch } : m)); setConfirmed(false); };
  return <>
    <div className={css.detailHeader}><div className={css.detailHeading}><Button variant="quiet" aria-label="Back to workspace" onClick={onBack}><ArrowLeft size={18}/></Button><div><h2>{data.series.studentName}</h2><p>{data.series.courseName} · {data.series.tutorName} · Cycle {data.cycle} · Due in class {data.dueClass}</p></div></div><div className={css.actions}><span className={`${css.badge} ${data.overdue ? css.warning : ""}`}>{STAGE_LABELS[data.stage]}{data.overdue ? " · Overdue" : ""}</span><Button variant="quiet" aria-label="Refresh saved results" onClick={() => { void onSaved().catch(e => onError(e.message)); }}><RefreshCw size={16}/></Button></div></div>
    {message && <div className={css.notice} role="status">{message}</div>}
    <div className={css.detailGrid}><div>
      <section className={css.panel}><h3>1. Prepare the test <small>Discuss in class {data.discussionClass}</small></h3>
        <Field label="Ready test paper"><select value={paperId} disabled={!!data.currentSubmissionId} onChange={e => { setPaperId(e.target.value); setPreview(null); }}><option value="">Choose a paper from your library</option>{data.versions.map(v => <option value={v.version.id} key={v.version.id}>{v.version.paper.title} · {isOriginalPaper(v.version.paper) ? "Original" : "Formatted"} · version {v.version.revision}</option>)}</select></Field>
        <div className={css.inlinePaper}>{!data.currentSubmissionId && <AssessmentPaperPreparation assessment={data} capabilities={overview.capabilities} onSaved={onSaved} onReady={setPaperId} onPreview={setPreview} onError={onError}/>}</div>
        <Field label="Topics the student should revise"><textarea value={topics} disabled={!!data.currentSubmissionId} placeholder="For example: linear equations, substitution and interpreting graphs." onChange={e => setTopics(e.target.value)}/></Field>
        <label className={css.check}><input type="checkbox" checked={informed} disabled={!!data.currentSubmissionId} onChange={e => setInformed(e.target.checked)}/>I explained the test and its covered topics to the student.</label>
        {!data.currentSubmissionId && <Button variant="primary" disabled={busy || !paperId || !topics.trim()} onClick={() => run({ action:"prepare",...target,paperVersionId:paperId,topics,studentInformed:informed })}>Save preparation</Button>}
      </section>
      <section className={css.panel}><h3>2. Submit student work <small>Within an ordinary class</small></h3><p className={css.hint}>Record the class in which you administered the test. A late test does not move the next eight-class deadline.</p>
        <Field label="Class in which the test was administered"><select value={sessionId} onChange={e => setSessionId(e.target.value)}><option value="">Choose a completed class</option>{data.sessions.filter(s => s.ordinal > (data.cycle-1)*8).map(s => <option key={s.id} value={s.id}>Class {s.ordinal} · {formatDate(s.date)}</option>)}</select></Field>
        <UploadField purpose="work" ownerKey={data.series.ownerKey} assessmentId={data.id} disabled={!overview.capabilities.uploads || !data.preparation.paperVersionId} onUploaded={uploaded => { setFiles([...files,...uploaded]); setOrder([...order,...uploaded.flatMap(f => Array.from({ length:f.pageCount },(_,i) => ({ fileId:f.id,page:i+1 })))]); }}/>
        {files.length > 0 && <PageOrder files={files} order={order} onOrder={setOrder} onRemove={id => { setFiles(files.filter(f => f.id!==id)); setOrder(order.filter(p => p.fileId!==id)); }}/ >}
        <Button variant="primary" disabled={busy || !sessionId || !files.length} onClick={() => run({ action:"submit",...target,sessionId,fileIds:files.map(f => f.id),pageOrder:order })}>{data.currentSubmissionId ? "Submit corrected work as a new version" : "Submit for review"}</Button>
        {data.submissions.length > 0 && <details className={css.versionList}><summary>Submitted work · {data.submissions.length} version(s)</summary>{data.submissions.map((s,i) => <div key={s.id}><strong>{i===0 ? "Latest submission" : "Earlier submission"} · {formatDate(s.createdAt)}</strong><p>{data.sessions.find(c => c.id===s.data.sessionId) ? `Administered in class ${data.sessions.find(c => c.id===s.data.sessionId)!.ordinal}` : "Recorded class needs attendance review"}</p><div className={css.actions}>{s.data.fileIds.map((id,j) => <Button variant="quiet" key={id} onClick={() => setPreview(id)}>Original file {j+1}</Button>)}</div></div>)}</details>}
      </section>
      {data.currentSubmissionId && paperContent && <section className={css.panel}><h3>3. Review the marked test</h3>
        {currentPaper && <div className={css.actions}><Button variant={!manual ? "primary" : "quiet"} onClick={() => { setManual(false); setConfirmed(false); }}>Question marks</Button><Button variant={manual ? "primary" : "quiet"} onClick={() => { setManual(true); setConfirmed(false); }}>Upload a marked PDF instead</Button></div>}
        {manual ? <>
          <p className={css.hint}>Upload the test you marked and enter its final score. The uploaded PDF will be published exactly as reviewed, alongside your progress report. Original student-work uploads stay private.</p>
          <UploadField purpose="marked" ownerKey={data.series.ownerKey} assessmentId={data.id} disabled={busy || !overview.capabilities.uploads} onUploaded={files => { setMarkedFileId(files[0].id); setConfirmed(false); setPreview(files[0].id); }}/>
          {markedFileId && <div className={css.actions}><Button onClick={() => setPreview(markedFileId)}>Preview marked test</Button><a href={`${fileUrl(markedFileId)}?download=1`}>Download marked test</a></div>}
          <Field label="Awarded marks"><input type="number" min="0" step="any" value={earned} onChange={e => { setEarned(e.target.value); setConfirmed(false); }}/></Field>
          <Field label="Possible marks"><input type="number" min="0.01" step="any" value={possible} onChange={e => { setPossible(e.target.value); setConfirmed(false); }}/></Field>
          {totals && <div className={css.resultScore}>{totals.earned} / {totals.possible} <small>({totals.percent}%)</small></div>}
          <Button disabled={busy || !markedFileId || !totals} onClick={() => { void saveReview(); }}>Save marked test and score</Button>
        </> : currentPaper && <><p className={css.hint}>AI provides a draft. Check it against the original responses and approved rubric, then resolve every flagged answer. You can enter all marks manually.</p>
        <div className={css.actions}><Button disabled={busy || !overview.capabilities.ai || !selectedPaper?.rubricApproved} onClick={() => run({ action:"grade",...target })}><Sparkles size={15}/>{current ? "Create a new AI grading draft" : "Grade with AI"}</Button>{totals && <div className={css.resultScore}>{totals.earned} / {totals.possible} <small>({totals.percent}%)</small></div>}</div>
        {!selectedPaper?.rubricApproved && <p className={css.hint}>Review and approve the private rubric in your Test library before AI grading, or upload a marked PDF.</p>}
        {currentPaper.questions.map((q,i) => { const mark = marks.find(m => m.questionId===q.id); if (!mark) return null; return <div className={css.markRow} key={q.id}><div className={css.markTitle}><strong>Question {i+1} · {q.topic || "Test question"}</strong><label className={css.actions}><input aria-label={`Marks for question ${i+1}`} className={css.markInput} type="number" min="0" max={q.maxMarks} step="0.5" value={mark.marks} onChange={e => setMark(q.id,{ marks:Number(e.target.value) })}/><span>/ {q.maxMarks}</span></label></div><p>{q.text}</p><details><summary>Approved marking rubric</summary><p className={css.hint}>{q.rubric}</p></details>
          <Field label="Marking explanation"><textarea value={mark.explanation} onChange={e => setMark(q.id,{ explanation:e.target.value })}/></Field>
          <Field label="Reference to the student's answer"><input value={mark.answerReference} placeholder="Page 2, question 3, second line" onChange={e => setMark(q.id,{ answerReference:e.target.value })}/></Field>
          <label className={css.check}><input type="checkbox" checked={mark.needsReview} onChange={e => setMark(q.id,{ needsReview:e.target.checked })}/>This answer is unclear or still needs my review.</label>
        </div>; })}
        <Button disabled={busy} onClick={() => { void saveReview(); }}>Save reviewed marks</Button>
        </>}
      </section>}
      {data.currentSubmissionId && paperContent && <section className={css.panel}><h3>4. Write the progress report</h3><p className={css.hint}>Class feedback adds learning context and recommendations. It never changes the numerical test marks.</p>
        {!manual && <Button disabled={busy || !overview.capabilities.ai || !sameReview || marks.some(m => m.needsReview)} onClick={() => run({ action:"report",...target })}><Sparkles size={15}/>Draft report from saved results</Button>}
        <Field label="Progress summary"><textarea value={report.summary} onChange={e => { setReport({ ...report,summary:e.target.value }); setConfirmed(false); }}/></Field>
        {(["strengths","focusAreas","nextSteps"] as const).map(key => <Field label={{ strengths:"Strengths — one per line",focusAreas:"Areas to develop — one per line",nextSteps:"Next steps — one per line" }[key]} key={key}><textarea value={report[key].join("\n")} onChange={e => { setReport({ ...report,[key]:e.target.value.split("\n") }); setConfirmed(false); }}/></Field>)}
        <Field label="Context limitations or missing evidence"><textarea value={report.contextLimitations} onChange={e => { setReport({ ...report,contextLimitations:e.target.value }); setConfirmed(false); }}/></Field>
        <Button variant="primary" disabled={busy || (manual && (!markedFileId || !totals))} onClick={() => { void saveReview(); }}>Save report and marks</Button>
      </section>}
    </div><aside>
      <section className={css.panel}><h3><FileText size={18}/>Document preview</h3><div className={css.actions}>{!data.currentSubmissionId && paperArtifacts.map(a => <Button key={a.id} onClick={() => setPreview(a.fileId)}>{a.kind === "paper" ? "Test paper" : "Private marking scheme"}</Button>)}{artifacts.map(a => <Button key={a.id} onClick={() => setPreview(a.fileId)}>{a.kind === "graded" ? "Graded test" : "Progress report"}</Button>)}</div>
        {displayPreview ? <PdfViewer fileId={displayPreview} title="Assessment document preview"/> : <div className={css.empty}><FileText/><p>{data.currentSubmissionId ? "Open original work or build both reviewed PDFs." : "Upload your own paper, or select a ready paper to preview it here."}</p></div>}
        {current && <><Button disabled={busy || !overview.capabilities.uploads || !sameReview} onClick={() => run({ action:"preview-review",...target })}><FileText size={15}/>Build both PDF previews</Button><label className={css.check}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>I reviewed every page of the graded test and progress report, checked that the score matches the marked test, and approve these results.</label>
          <Button variant="primary" disabled={busy || !sameReview || !confirmed || artifacts.length < 2 || current.approved} onClick={() => run({ action:"approve",...target,confirmed:true })}><CheckCheck size={15}/>{overview.publication.ready ? "Approve and publish" : "Approve and queue"}</Button>
        </>}
        {!overview.publication.ready && <p className={css.hint}>Wise publishing is currently unavailable. Approved PDFs are kept privately in this workspace until publication is available.</p>}
        {data.publicationError && <p className={css.hint}>Publication: {data.publicationStatus === "blocked" ? "Waiting for Wise publishing" : data.publicationStatus}</p>}
      </section>
      <details className={css.panel}><summary><ClipboardCheck size={18}/>Class feedback</summary><p className={css.hint}>Only verified feedback from this tutor, student and course cycle is included.</p><div className={css.versionList}>{data.feedback.length ? data.feedback.map(f => <div key={f.id}><strong>{formatDate(f.date)}</strong><p style={{ whiteSpace:"pre-wrap" }}>{f.text}</p></div>) : <p>No verified feedback is available for this cycle. Record this limitation in the report.</p>}</div></details>
      <details className={css.panel}><summary>Review history</summary><p className={css.hint}>Wise destination: Content → Progress Tests. Earlier approved versions are retained.</p>
      {data.publications.map(p=><div className={css.notice} key={p.id}><div><strong>Version {p.version} · {p.status.replaceAll("_"," ")}</strong><p>{p.error}</p>{data.publicationFiles.filter(f=>f.publicationId===p.id).map(f=><p key={f.id}>{f.kind==="graded"?"Graded test":"Progress report"}: {f.status==="verified"?"Verified in Wise":f.status}</p>)}{p.status!=="published"&&<Button disabled={busy} onClick={()=>run({action:"publish",...target,publicationId:p.id})}>Check Wise and retry</Button>}{p.status==="published"&&<a href={`https://learn.begiftededucation.com/teacher/classes/${data.series.wiseClassId}/overview?type=one_to_one&tab=content`} target="_blank" rel="noreferrer">Open Wise Content ↗</a>}</div></div>)}<div className={css.versionList}>{data.reviews.map((r,i) => <div key={r.id}><strong>{r.approved ? "Approved" : "Draft"} · {formatDate(r.createdAt)}</strong><p>{i===0 ? "Latest review" : "Earlier review"} · {r.data.feedback.length} feedback references</p><div className={css.actions}>{data.artifacts.filter(a => a.reviewId===r.id).map(a => <Button key={a.id} variant="quiet" onClick={() => setPreview(a.fileId)}>{a.kind === "graded" ? "Graded test" : "Report"}</Button>)}</div></div>)}</div></details>
    </aside></div>
  </>;
}

"use client";
import { useState } from "react";
import { ArrowLeft, Check, FileText, Plus, Sparkles, Trash2 } from "lucide-react";
import type { Paper } from "@/lib/progress-tests/workspace/model";
import type { Overview, PaperDetail } from "@/lib/progress-tests/workspace/data";
import { Button, Field, UploadField, useWorkspaceTransport, formatDate, type Serialized } from "./shared";
import css from "./workspace.module.css";

export function PaperEditor({ data, overview, onBack, onSaved, onError }: { data: Serialized<PaperDetail>; overview: Serialized<Overview>; onBack: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const {command,fileUrl}=useWorkspaceTransport();
  const latest = data.versions[0];
  const [paper, setPaper] = useState<Paper>(latest?.paper ?? { title: data.title, instructions: "Answer all questions. Show your working where appropriate.", questions: [{ id: "q1", text: "", topic: "", maxMarks: 1, rubric: "", sourcePage: null, needsVisual: false }], warnings: [] });
  const [sourceId, setSourceId] = useState<string | null>(latest?.sourceFileId ?? null);
  const [keyId, setKeyId] = useState<string | null>(latest?.keyFileId ?? null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const sameDraft = !!latest && JSON.stringify(paper) === JSON.stringify(latest.paper) && sourceId === latest.sourceFileId && keyId === latest.keyFileId;
  const pdfJob = overview.jobs.find(j => j.targetId === data.id && j.expectedRevision === data.revision && j.kind === "render-paper" && j.status === "completed" && typeof j.result?.fileId === "string");
  const pdfId = pdfJob?.result?.fileId as string | undefined;
  const run = async (action: "save-paper" | "process-paper" | "preview-paper", approved = false) => {
    setBusy(true); onError("");
    try {
      if (action === "save-paper") await command({ action, id: data.id, expectedRevision: data.revision, paper, sourceFileId: sourceId, keyFileId: keyId, approved });
      else if (action === "process-paper") { if (!sourceId) throw new Error("Upload a source paper first."); await command({ action, id: data.id, expectedRevision: data.revision, sourceFileId: sourceId, keyFileId: keyId }); }
      else await command({ action, id: data.id, expectedRevision: data.revision });
      await onSaved();
    } catch (e) { onError(e instanceof Error ? e.message : "Could not save the paper."); }
    finally { setBusy(false); }
  };
  const updateQuestion = (index: number, patch: Partial<Paper["questions"][number]>) => { setReviewed(false); setPaper({ ...paper, questions: paper.questions.map((q,i) => i === index ? { ...q, ...patch } : q) }); };
  return <>
    <div className={css.detailHeader}><div><Button variant="quiet" onClick={onBack}><ArrowLeft size={15}/>Test library</Button><h2>{data.title}</h2><p>Version {data.revision || "—"} · {latest?.approved ? "Ready to use" : "Draft — review before use"}</p></div><div className={css.actions}><Button disabled={busy} onClick={() => run("save-paper")}>Save draft</Button><Button variant="primary" disabled={busy || !overview.capabilities.uploads || !latest || !sameDraft} onClick={() => run("preview-paper")}><FileText size={15}/>Build PDF preview</Button></div></div>
    <div className={css.detailGrid}><div><section className={css.panel}><h3><Sparkles size={18}/>Import your paper</h3><p className={css.hint}>Upload a paper and an optional answer key. AI creates an editable draft for you to check. You can also write the questions and rubric below.</p>
      <UploadField ownerKey={data.ownerKey} purpose="paper" disabled={!overview.capabilities.uploads} onUploaded={files => { setSourceId(files[0].id); setReviewed(false); setPreview(files[0].id); }}/>
      {sourceId && <a className={css.fileLink} href={fileUrl(sourceId)} target="_blank" rel="noreferrer">Open original paper ↗</a>}
      <UploadField ownerKey={data.ownerKey} purpose="key" disabled={!overview.capabilities.uploads} onUploaded={files => { setKeyId(files[0].id); setReviewed(false); }}/>
      {keyId && <div className={css.actions}><a href={fileUrl(keyId)} target="_blank" rel="noreferrer">Open private marking key ↗</a><Button variant="quiet" onClick={() => setKeyId(null)}>Remove key</Button></div>}
      <Button disabled={busy || !sourceId || !overview.capabilities.ai} onClick={() => run("process-paper")}><Sparkles size={15}/>Format with AI</Button>{!overview.capabilities.ai && <p className={css.hint}>AI processing is unavailable. You can edit and review the paper manually.</p>}
    </section><section className={css.panel}><h3>Editable assessment <small>{paper.questions.length} questions</small></h3>
      <Field label="Test title"><input value={paper.title} maxLength={300} onChange={e => { setPaper({ ...paper, title: e.target.value }); setReviewed(false); }}/></Field>
      <Field label="Instructions for the student"><textarea value={paper.instructions} onChange={e => { setPaper({ ...paper, instructions: e.target.value }); setReviewed(false); }}/></Field>
      {paper.warnings.length > 0 && <div className={css.error}><strong>Check these items against the source</strong><ul>{paper.warnings.map((w,i) => <li key={i}>{w}</li>)}</ul><Button onClick={() => setPaper({ ...paper, warnings: [] })}>I corrected each flagged item</Button></div>}
      {paper.questions.map((q,index) => <div className={css.question} key={q.id}><div className={css.questionHeader}><h3>Question {index+1}</h3><Button variant="quiet" aria-label={`Remove question ${index+1}`} disabled={paper.questions.length === 1} onClick={() => { setPaper({ ...paper, questions: paper.questions.filter((_,i) => i!==index) }); setReviewed(false); }}><Trash2 size={15}/></Button></div>
        <Field label={`Question ${index+1} text`}><textarea value={q.text} onChange={e => updateQuestion(index,{ text: e.target.value })}/></Field>
        <div className={css.compact}><Field label="Topic"><input value={q.topic} onChange={e => updateQuestion(index,{ topic:e.target.value })}/></Field><Field label="Marks"><input type="number" min="0.5" max="1000" step="0.5" value={q.maxMarks} onChange={e => updateQuestion(index,{ maxMarks:Number(e.target.value) })}/></Field></div>
        <Field label="Private marking rubric / partial credit"><textarea value={q.rubric} placeholder="Describe the accepted answer and how marks are awarded." onChange={e => updateQuestion(index,{ rubric:e.target.value })}/></Field>
        <label className={css.check}><input type="checkbox" checked={q.needsVisual} onChange={e => updateQuestion(index,{ needsVisual:e.target.checked })}/>This question refers to an illustration in the original paper.</label>
        {q.needsVisual && <Field label="Original illustration page"><input type="number" min="1" value={q.sourcePage ?? ""} onChange={e => updateQuestion(index,{ sourcePage:e.target.value ? Number(e.target.value) : null })}/></Field>}
      </div>)}
      <Button onClick={() => { setPaper({ ...paper, questions: [...paper.questions,{ id:crypto.randomUUID(),text:"",topic:"",maxMarks:1,rubric:"",sourcePage:null,needsVisual:false }] }); setReviewed(false); }}><Plus size={15}/>Add question</Button>
    </section></div><aside><section className={css.panel}><h3>Review the formatted paper</h3><p className={css.hint}>Save the draft, then build its PDF preview. Check every page, the original illustrations, and the private marking rubric before marking this version ready.</p>
      <div className={css.actions}>{pdfId && <Button onClick={() => setPreview(pdfId)}>Open formatted PDF</Button>}{sourceId && <Button variant="quiet" onClick={() => setPreview(sourceId)}>Original source</Button>}</div>
      {preview ? <iframe title="Test paper preview" className={css.pdfPreview} src={fileUrl(preview)}/> : <div className={css.empty}><FileText/><p>Your formatted preview will appear here.</p></div>}
      <label className={css.check}><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)}/>I checked all pages, questions, illustrations and marking criteria.</label>
      <Button variant="primary" disabled={busy || !reviewed || !sameDraft || !pdfId || latest?.approved} onClick={() => run("save-paper",true)}><Check size={15}/>Mark version ready</Button>
    </section><section className={css.panel}><h3>Version history</h3><div className={css.versionList}>{data.versions.length ? data.versions.map(v => <div key={v.id}><strong>Version {v.revision} · {v.approved ? "Reviewed" : "Draft"}</strong><p>{formatDate(v.createdAt)} · {v.paper.questions.length} questions</p>{v.sourceFileId && <a href={fileUrl(v.sourceFileId)} target="_blank" rel="noreferrer">Original source ↗</a>}</div>) : <p>No saved versions yet.</p>}</div></section></aside></div>
  </>;
}

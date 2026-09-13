"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, FileText, Sparkles } from "lucide-react";
import type { AssessmentDetail, Overview, PaperDetail } from "@/lib/progress-tests/workspace/data";
import { isOriginalPaper } from "@/lib/progress-tests/workspace/model";
import { API, Button, UploadField, command, fileUrl, formatDate, readApi, useSavedDraft, type Serialized } from "./shared";
import { PdfViewer } from "./pdf-viewer";
import { JobProgress } from "./job-progress";
import css from "./workspace.module.css";

type Capabilities = Serialized<Overview>["capabilities"];
type PaperData = Serialized<PaperDetail>;
export function PaperPreparation({ initial, capabilities, onSaved, onReady, onPreview, onError }: { initial: PaperData; capabilities: Capabilities; onSaved: () => Promise<void>; onReady?: (versionId: string) => void; onPreview?: (fileId: string) => void; onError: (message: string) => void }) {
  const [data, setData] = useState(initial);
  useEffect(() => { setData(initial); }, [initial]);
  const original = data.versions.find(v => isOriginalPaper(v.paper));
  const sourceVersion = original ?? data.versions[0];
  const [sourceId, setSourceId] = useSavedDraft<string | null>(sourceVersion?.sourceFileId ?? null);
  const [keyId, setKeyId] = useSavedDraft<string | null>(sourceVersion?.keyFileId ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false), [rubricReviewed, setRubricReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false);
  const [chosenPreview, setChosenPreview] = useState<string | null>(null);
  const selected = data.versions.find(v => v.id === selectedId) ?? sourceVersion;
  const formatted = data.versions.find(v => !isOriginalPaper(v.paper) && (original ? v.sourceVersionId === original.id : v.sourceFileId === sourceId && v.keyFileId === keyId));
  const artifacts = data.artifacts.filter(a => a.versionId === selected?.id);
  const paperPdf = artifacts.find(a => a.kind === "paper")?.fileId;
  const keyPdf = artifacts.find(a => a.kind === "key")?.fileId;
  const preview = chosenPreview ?? paperPdf;
  const job = data.jobs.find(j => j.kind === "format-paper");
  const conversion = data.jobs.find(j => j.kind === "convert-paper" && j.input.sourceFileId === sourceId);
  const formatting = !!job && ["queued", "running"].includes(job.status);
  const pendingUpload = !!sourceId && (sourceVersion?.sourceFileId !== sourceId || sourceVersion?.keyFileId !== keyId);
  const content = selected && !isOriginalPaper(selected.paper) ? selected.paper : null;
  const reload = useCallback(async () => { const next = await readApi<PaperData>(`${API}/papers/${initial.id}`); setData(next); return next; }, [initial.id]);
  const selectPreview = (id: string) => { setChosenPreview(id); onPreview?.(id); };
  const selectVersion = (id: string) => {
    setSelectedId(id); setReviewed(false); setRubricReviewed(false); setChosenPreview(null);
    const file = data.artifacts.find(a => a.versionId === id && a.kind === "paper");
    if (file) onPreview?.(file.fileId);
  };
  const finished = async () => { try { const next = await reload(); await onSaved(); const current = next.versions.find(v => v.id === selected?.id); const file = next.artifacts.find(a => a.versionId === current?.id && a.kind === "paper"); if (file && conversion && !paperPdf) onPreview?.(file.fileId); } catch (e) { onError(e instanceof Error ? e.message : "Unable to refresh your PDF."); } };
  const attach = async (sourceFileId: string, keyFileId: string | null) => {
    setSourceId(sourceFileId); setKeyId(keyFileId); setBusy(true); setReviewed(false); setChosenPreview(null); onError("");
    try {
      const result = await command({ action: "attach-original", id: data.id, expectedRevision: data.revision, sourceFileId, keyFileId });
      setSelectedId(result.versionId!);
      const next = await reload(); await onSaved();
      const file = next.artifacts.find(a => a.versionId === result.versionId && a.kind === "paper");
      if (file) onPreview?.(file.fileId);
    } catch (e) { onError(e instanceof Error ? e.message : "Unable to save your original. Retry saving the upload."); }
    finally { setBusy(false); }
  };
  return <div className={css.paperPreparation}>
    <p className={css.hint}>Use your own paper as uploaded. PDF pages stay exactly as you supplied them. DOCX files are converted visually to PDF for your review.</p>
    <UploadField ownerKey={data.ownerKey} assessmentId={data.assessmentId ?? undefined} purpose="paper" onBusy={setUploading} disabled={!capabilities.uploads || busy} onUploaded={files => { void attach(files[0].id, keyId); }}/>
    {sourceId && <a className={css.fileLink} href={`${fileUrl(sourceId)}?download=1`}>Download original upload</a>}
    <UploadField ownerKey={data.ownerKey} assessmentId={data.assessmentId ?? undefined} purpose="key" onBusy={setUploading} disabled={!capabilities.uploads || busy || !sourceId} onUploaded={files => { if (sourceId) void attach(sourceId, files[0].id); }}/>
    {keyId && <div className={css.actions}><a href={`${fileUrl(keyId)}?download=1`}>Download private marking key</a><Button variant="quiet" disabled={busy || uploading} onClick={() => { if (sourceId) void attach(sourceId, null); }}>Remove key</Button></div>}
    <p className={css.hint}>A marking key is optional. It stays private and is not needed to use your original paper.</p>
    {pendingUpload && <Button disabled={busy || uploading} onClick={() => { if (sourceId) void attach(sourceId, keyId); }}>Save uploaded paper</Button>}
    {conversion && <JobProgress key={conversion.id} id={conversion.id} onFinished={() => { void finished(); }} onRetry={() => { void reload(); }}/ >}
    {sourceVersion && <div className={css.actions}>
      <Button variant={!content ? "primary" : "quiet"} onClick={() => selectVersion(sourceVersion.id)}>{original ? "Use my uploaded paper" : "Previously reviewed paper"}</Button>
      {formatted && original && <Button onClick={() => selectVersion(formatted.id)}>Review BeGifted draft</Button>}
    </div>}
    <div className={css.notice}><div><strong>Format with BeGifted — Beta</strong><p>Optional formatting of your existing questions. Check all marks, diagrams and working space before adopting the result. Your original remains available throughout.</p>
      <Button disabled={busy || uploading || formatting || !sourceId || pendingUpload || !capabilities.ai || !capabilities.formatting} onClick={async () => {
        setBusy(true); onError("");
        try {
          let revision = data.revision;
          if (!original) {
            const attached = await command({ action: "attach-original", id: data.id, expectedRevision: revision, sourceFileId: sourceId!, keyFileId: keyId });
            revision = attached.revision!;
            setSelectedId(attached.versionId!);
          }
          await command({ action: "format-paper", id: data.id, expectedRevision: revision, sourceFileId: sourceId!, keyFileId: keyId }); await reload(); await onSaved();
        }
        catch (e) { onError(e instanceof Error ? e.message : "Unable to start formatting."); }
        finally { setBusy(false); }
      }}><Sparkles size={16}/>{formatting ? "Formatting in progress…" : "Format with BeGifted — Beta"}</Button>
      {!capabilities.formatting && <p>Formatting is paused. You can use your original paper.</p>}
      {!capabilities.ai && <p>AI formatting is unavailable. You can use your original paper.</p>}
      {!keyId && <p className={css.hint}>Formatting also drafts a private marking scheme for separate tutor review.</p>}
    </div></div>
    {job && <JobProgress key={job.id} id={job.id} onFinished={() => { void finished(); }} onRetry={() => { void reload(); }}/ >}
    {content?.warnings.length ? <div className={css.error}><strong>Check this draft before using it</strong><ul>{content.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul><p>You can use your original, or replace the source and format again.</p></div> : null}
    {selected && <p className={css.hint}>{isOriginalPaper(selected.paper) ? "Your original paper" : "BeGifted formatted paper"} · version {selected.revision} · {selected.approved ? "Ready to use" : "Awaiting your review"}</p>}
    {paperPdf && <div className={css.actions}><Button onClick={() => selectPreview(paperPdf)}>Preview selected paper</Button><a href={`${fileUrl(paperPdf)}?download=1`}>Download selected PDF</a>{keyPdf && <Button onClick={() => selectPreview(keyPdf)}>Private marking scheme</Button>}</div>}
    {preview && !onPreview && <PdfViewer fileId={preview} title={content ? "BeGifted draft preview" : "Original paper preview"}/>}
    {preview && onPreview && <Button variant="quiet" onClick={() => selectPreview(preview)}>Open selected document in preview</Button>}
    {paperPdf && selected && <>
      <label className={css.check}><input type="checkbox" checked={reviewed || selected.approved} disabled={busy || selected.approved} onChange={e => setReviewed(e.target.checked)}/>I reviewed every page, question, mark allocation, diagram and working area of this paper.</label>
      {!selected.approved ? <Button variant="primary" disabled={busy || uploading || pendingUpload || !reviewed || !!content?.warnings.length} onClick={async () => {
        setBusy(true); onError("");
        try { await command({ action: "approve-paper", id: data.id, expectedRevision: data.revision, versionId: selected.id, confirmed: true }); await reload(); await onSaved(); onReady?.(selected.id); }
        catch (e) { onError(e instanceof Error ? e.message : "Unable to mark this paper ready."); }
        finally { setBusy(false); }
      }}><Check size={16}/>{content ? "Adopt formatted paper and mark ready" : "Mark original ready"}</Button> : onReady ? <Button variant="primary" disabled={busy || pendingUpload} onClick={() => onReady(selected.id)}>Use this ready paper</Button> : <p className={css.hint}>This version is ready for an assessment.</p>}
    </>}
    {content && keyPdf && selected?.approved && <div className={css.notice}><div><strong>Private rubric · separate approval for AI grading</strong>{content.gradingWarnings?.map((w, i) => <p key={i}>{w}</p>)}<p>Manual marked-PDF grading is available without rubric approval.</p>
      <label className={css.check}><input type="checkbox" checked={rubricReviewed || selected.rubricApproved} disabled={selected.rubricApproved || busy} onChange={e => setRubricReviewed(e.target.checked)}/>I checked every private marking criterion and possible mark.</label>
      <Button disabled={busy || !rubricReviewed || selected.rubricApproved || !!content.gradingWarnings?.length || content.questions.some(q => q.maxMarks <= 0 || !q.rubric.trim())} onClick={async () => {
        setBusy(true); onError("");
        try { await command({ action: "approve-rubric", id: data.id, expectedRevision: data.revision, versionId: selected.id, confirmed: true }); await reload(); await onSaved(); }
        catch (e) { onError(e instanceof Error ? e.message : "Unable to approve the rubric."); }
        finally { setBusy(false); }
      }}>{selected.rubricApproved ? "Rubric approved" : "Approve rubric for AI grading"}</Button>
    </div></div>}
    {data.versions.length > 0 && <details className={css.versionList}><summary>Paper history · {data.versions.length} version(s)</summary>{data.versions.map(v => <div key={v.id}><strong>Version {v.revision} · {isOriginalPaper(v.paper) ? "Original" : "Formatted"} · {v.approved ? "Ready" : "Draft"}</strong><p>{formatDate(v.createdAt)}</p><Button variant="quiet" onClick={() => selectVersion(v.id)}>Review this version</Button>{v.sourceFileId && <a href={`${fileUrl(v.sourceFileId)}?download=1`}>Original upload</a>}</div>)}</details>}
  </div>;
}
export function PaperEditor({ data, overview, onBack, onSaved, onError }: { data: PaperData; overview: Serialized<Overview>; onBack: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  return <><div className={css.detailHeader}><div><Button variant="quiet" onClick={onBack}><ArrowLeft size={15}/>Test library</Button><h2>{data.title}</h2><p>Upload, review and reuse your paper. BeGifted formatting is optional.</p></div><FileText size={28}/></div><section className={css.panel}><PaperPreparation initial={data} capabilities={overview.capabilities} onSaved={onSaved} onError={onError}/></section></>;
}
export function AssessmentPaperPreparation({ assessment, capabilities, onSaved, onReady, onPreview, onError }: { assessment: Serialized<AssessmentDetail>; capabilities: Capabilities; onSaved: () => Promise<void>; onReady: (versionId: string) => void; onPreview: (fileId: string) => void; onError: (message: string) => void }) {
  const [paper, setPaper] = useState<PaperData | null>(null), [busy, setBusy] = useState(false);
  const paperId = assessment.preparingPapers[0]?.id;
  useEffect(() => { let stopped = false; if (paperId) void readApi<PaperData>(`${API}/papers/${paperId}`).then(p => { if (!stopped) setPaper(p); }).catch(e => { if (!stopped) onError(e.message); }); return () => { stopped = true; }; }, [paperId, onError]);
  const load = async () => { if (paper) setPaper(await readApi<PaperData>(`${API}/papers/${paper.id}`)); await onSaved(); };
  if (paper) return <PaperPreparation initial={paper} capabilities={capabilities} onSaved={load} onReady={onReady} onPreview={onPreview} onError={onError}/>;
  return <Button disabled={busy || !capabilities.uploads} onClick={async () => {
    setBusy(true); onError("");
    try { const created = await command({ action: "create-paper", title: `${assessment.series.courseName} — Progress test ${assessment.cycle}`.slice(0, 300), assessmentId: assessment.id }); setPaper(await readApi<PaperData>(`${API}/papers/${created.id}`)); await onSaved(); }
    catch (e) { onError(e instanceof Error ? e.message : "Unable to prepare a paper."); }
    finally { setBusy(false); }
  }}><FileText size={16}/>{busy ? "Opening uploads…" : "Upload a paper here"}</Button>;
}

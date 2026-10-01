"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { AtomLessonEvidence } from "@/lib/feedback-autowriter/atom/types";
import type { StoredJudgeVerdict } from "@/lib/feedback-autowriter/judge";
import { when } from "./format";

type Student = { id: string; name: string };
type Link = { wiseStudentId: string; atomStudentId: string; wiseName: string; atomName: string; revision: number; active: boolean; approvedBy: string; approvedAt: string };
type Overview = {
  links: Link[]; catalog: Student[]; candidates: Student[];
  sync: { id: string; status: string; startedAt: string; errorCode: string | null; snapshots: number; activities: number } | null;
  rollout: { comparisonHash: string | null; approvedBy: string | null; approvedAt: string | null; cloudProofRunId: string | null; unattendedConfirmedBy: string | null; receipt: { comparisons?: { id: string; tutor: string; subject: string; evidence: string; before: Record<string,string>; result: { fields: Record<string,string>; atomEvidence?: AtomLessonEvidence } }[] } } | null;
  enabled: { collection: boolean; format: boolean; enrichment: boolean };
  monitoring: { cohort: string; verified: number; reviewed: number; unresolved: number }[];
};
const inputClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
async function getJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "The server could not complete this request.");
  return json as T;
}

/** Load on demand, so a missing migration cannot hide the existing review workspace. */
export function AtomReviewTools({ canControl }: { canControl: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [wiseId, setWiseId] = useState("");
  const [atomId, setAtomId] = useState("");
  const [note, setNote] = useState("");
  const [proofRun, setProofRun] = useState("");
  const [unattended, setUnattended] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  async function load(query = search) {
    setBusy(true); setError(null);
    try { setData(await getJson<Overview>("/api/feedback-autowriter/atom?q=" + encodeURIComponent(query))); }
    catch (e) { setError(e instanceof Error ? e.message : "Atom review could not load."); }
    finally { setBusy(false); }
  }
  async function rolloutAction(body: Record<string, unknown>) {
    setBusy(true); setError(null); setSaved(null);
    try {
      await getJson("/api/feedback-autowriter/atom/rollout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setSaved("Review confirmation saved. The deployment switches remain separate."); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Confirmation could not be saved."); }
    finally { setBusy(false); }
  }
  async function save(link?: Link) {
    if (!data) return;
    const prior = link ?? data.links.find(item => item.wiseStudentId === wiseId);
    setBusy(true); setError(null); setSaved(null);
    try {
      await getJson("/api/feedback-autowriter/atom", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wiseStudentId: link?.wiseStudentId ?? wiseId, atomStudentId: link?.atomStudentId ?? atomId,
          expectedRevision: prior?.revision ?? 0, active: !link, note: link ? "Revoked by owner in Review" : note }) });
      setSaved(link ? "Student link revoked." : "Student link approved. New drafts will use this identity.");
      setWiseId(""); setAtomId(""); setNote("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Student link could not be saved."); }
    finally { setBusy(false); }
  }
  return <details className="rounded-lg border bg-card p-4" onToggle={event => { if (event.currentTarget.open && !data && !busy) void load(); }}>
    <summary className="cursor-pointer text-sm font-semibold">ISEB format, Atom student links and monitoring</summary>
    <div className="mt-4 space-y-4">
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {saved ? <p role="status" className="text-sm text-green-700">{saved}</p> : null}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>{busy ? "Loading…" : "Refresh Atom review"}</Button>
      {data ? <>
        <p className="text-sm">Collection: {data.enabled.collection ? "on" : "off"} · Numbered ISEB format: {data.enabled.format ? "on" : "off"} · Atom statistics: {data.enabled.enrichment ? "on" : "off"}</p>
        <p className="text-xs text-muted-foreground">{data.sync ? `Latest collection: ${data.sync.status} · ${when(data.sync.startedAt)} · ${data.sync.snapshots ?? 0} students · ${data.sync.activities ?? 0} activities${data.sync.errorCode ? ` · ${data.sync.errorCode.replaceAll("_", " ")}` : ""}` : "No Atom collection recorded."} All times Bangkok.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {["mimi_v2", "other_iseb"].map(cohort => {
            const progress = data.monitoring.find(item => item.cohort === cohort);
            return <div key={cohort} className="rounded-md border p-3 text-sm"><strong>{cohort === "mimi_v2" ? "Mimi v2" : "Other ISEB tutors"}</strong><p>{progress?.reviewed ?? 0}/10 reviewed · {progress?.verified ?? 0}/10 verified posts</p><p className="text-xs text-muted-foreground">{progress?.unresolved ?? 0} uncertain posting outcomes</p></div>;
          })}
        </div>
        <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">20-draft rollout review</summary>
          <div className="mt-3 space-y-3 text-sm">
            <p>{data.rollout?.approvedAt ? `Comparisons approved by ${data.rollout.approvedBy} · ${when(data.rollout.approvedAt)}` : "Comparison approval pending."}</p>
            {(data.rollout?.receipt.comparisons ?? []).map(comparison => <details key={comparison.id} className="border-t pt-2"><summary className="cursor-pointer">{comparison.tutor} · {comparison.subject} · {comparison.evidence}{comparison.result.atomEvidence?.lessonStart ? ` · ${when(comparison.result.atomEvidence.lessonStart)}` : ""}</summary><div className="my-3 grid gap-4 md:grid-cols-2">{[{ name: "Previous feedback", fields: comparison.before }, { name: "New draft", fields: comparison.result.fields }].map(side => <section key={side.name}><h4 className="mb-2 font-semibold">{side.name}</h4>{["topics","performance","improvement","homework"].map(field => <div key={field}><strong className="capitalize">{field}</strong><p className="mb-2 whitespace-pre-wrap text-xs">{side.fields[field] || "—"}</p></div>)}</section>)}</div></details>)}
            {!data.rollout?.receipt.comparisons?.length ? <p className="text-muted-foreground">No comparison bundle saved yet.</p> : null}
            {canControl && data.rollout?.comparisonHash && !data.rollout.approvedAt ? <Button disabled={busy} onClick={() => void rolloutAction({ action: "approve_comparisons", comparisonHash: data.rollout!.comparisonHash })}>Approve these 20 drafts</Button> : null}
            <p>{data.rollout?.cloudProofRunId ? `Unattended cloud run confirmed by ${data.rollout.unattendedConfirmedBy}.` : "Unattended cloud retrieval still needs confirmation."}</p>
            {canControl && data.rollout && !data.rollout.cloudProofRunId ? <div className="space-y-2">
              <label className="block text-xs">Scheduled cloud run ID<input className={inputClass} value={proofRun} onChange={event => setProofRun(event.target.value)} /></label>
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={unattended} onChange={event => setUnattended(event.target.checked)} />I confirm this scheduled run retrieved completed Atom activities while Codex was closed and my local computer was off.</label>
              <Button variant="outline" disabled={busy || !proofRun || !unattended} onClick={() => void rolloutAction({ action: "confirm_unattended_run", runId: proofRun, codexAndComputerWereOff: true })}>Record cloud verification</Button>
            </div> : null}
          </div>
        </details>
        <p className="text-xs text-muted-foreground">Names help find candidates. Approve only after checking the two student identities. Duplicate names do not establish a match.</p>
        {canControl ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
          <div className="flex gap-2"><label className="flex-1 text-xs">Find Wise student<input className={inputClass} value={search} onChange={event => setSearch(event.target.value)} placeholder="Name (at least 2 letters)" /></label><Button className="self-end" type="button" variant="outline" disabled={busy || search.trim().length < 2} onClick={() => { setWiseId(""); void load(); }}>Find</Button></div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs">Wise identity<select className={inputClass} required value={wiseId} onChange={event => setWiseId(event.target.value)}><option value="">Choose a Wise student</option>{data.candidates.map(student => <option key={student.id} value={student.id}>{student.name} · {student.id}</option>)}</select></label>
            <label className="text-xs">Atom identity<select className={inputClass} required value={atomId} onChange={event => setAtomId(event.target.value)}><option value="">Choose an Atom student</option>{data.catalog.map(student => <option key={student.id} value={student.id}>{student.name} · {student.id}</option>)}</select></label>
          </div>
          <label className="block text-xs">How you confirmed the identity<input className={inputClass} required maxLength={1000} value={note} onChange={event => setNote(event.target.value)} placeholder="For example, verified the profile with the tutor" /></label>
          <Button type="submit" disabled={busy || !wiseId || !atomId || !note.trim()}>Approve this exact student link</Button>
        </form> : null}
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><caption className="mb-2 text-left font-semibold">Student links</caption><thead><tr><th className="p-2">Wise</th><th className="p-2">Atom</th><th className="p-2">Approval</th>{canControl ? <th className="p-2">Action</th> : null}</tr></thead><tbody>{data.links.map(link => <tr key={link.wiseStudentId} className="border-t"><td className="p-2">{link.wiseName}<small className="block text-muted-foreground">{link.wiseStudentId}</small></td><td className="p-2">{link.atomName}<small className="block text-muted-foreground">{link.atomStudentId}</small></td><td className="p-2">{link.active ? "Approved" : "Revoked"} · revision {link.revision}<small className="block">{link.approvedBy} · {when(link.approvedAt)}</small></td>{canControl ? <td className="p-2">{link.active ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void save(link)}>Revoke</Button> : null}</td> : null}</tr>)}</tbody></table>{data.links.length === 0 ? <p className="text-xs text-muted-foreground">No approved student links yet.</p> : null}</div>
      </> : null}
    </div>
  </details>;
}

type EvidenceResponse = {
  evidence: { lessonRecord: string; evidenceKind: string; atom: AtomLessonEvidence | null } | null;
  factualVerdicts: StoredJudgeVerdict | null; unavailableReason: string | null;
  reviews: { id: string; status: string; createdAt: string; result: { reason?: string; formatProblems?: string[]; verdict?: { problems: string[] } } }[];
};
export function AtomEvidencePanel({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<EvidenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setError(null);
    try { setData(await getJson<EvidenceResponse>("/api/feedback-autowriter/atom?sessionId=" + encodeURIComponent(sessionId))); }
    catch (e) { setError(e instanceof Error ? e.message : "Evidence could not load."); }
    finally { setBusy(false); }
  }
  const atom = data?.evidence?.atom;
  return <details className="rounded-md border p-3" onToggle={event => { if (event.currentTarget.open && !data && !busy) void load(); }}>
    <summary className="cursor-pointer text-sm font-medium">Lesson evidence, Atom statistics and factual checks</summary>
    <div className="mt-3 space-y-3 text-xs">
      {busy ? <p>Loading evidence…</p> : null}
      {error ? <p role="alert" className="text-red-700">{error} <button className="underline" onClick={() => void load()}>Retry</button></p> : null}
      {data?.unavailableReason ? <p>{data.unavailableReason}</p> : null}
      {atom ? <>
        <p>Atom: {atom.status} · Lesson {when(atom.lessonStart)} – {when(atom.lessonEnd)} (Bangkok)</p>
        {atom.snapshot ? <p className="text-muted-foreground">Collected {when(atom.snapshot.collectedAt)} · Student link revision {atom.mapping?.revision}</p> : null}
        {atom.contradictions.map(reason => <p key={reason} className="text-red-700">Human review required: {reason.replaceAll("_", " ")}</p>)}
        {atom.activities.map(activity => <section key={activity.id} className="space-y-1 rounded border p-3">
          <a className="font-semibold text-primary underline" href={activity.sourceUrl} target="_blank" rel="noreferrer">{activity.name}</a>
          <p>{activity.portion === "matched_portion" ? "Matched portion only" : "Whole activity"} · {activity.match === "lesson_window" ? "Within the lesson" : "Explicit lesson reference"}</p>
          <p>{activity.correctAnswers} correct / {activity.attemptedQuestions} attempted · {activity.totalQuestions} total questions in the activity</p>
          <p>Answer time: {activity.seconds === null ? "unavailable" : `${activity.seconds} seconds`} · Assistance: {activity.assistance.replaceAll("_", " ")}</p>
          <p>{when(activity.firstAnswerAt)} – {when(activity.lastAnswerAt)} (Bangkok)</p>
          {activity.sas !== null ? <p>SAS: {activity.sas}</p> : null}
          {activity.modelledTopicEstimates.map(topic => <p key={topic.topic}>Modelled estimate — {topic.topic}: {topic.percent}%</p>)}
        </section>)}
        {atom.omissions.length ? <div><strong>Statistics omitted</strong><ul className="mt-1 list-disc pl-4">{atom.omissions.map((omission, i) => <li key={i}>{omission.reason.replaceAll("_", " ")}{omission.activityId ? ` · ${omission.activityId}` : ""}</li>)}</ul></div> : null}
      </> : null}
      {data ? <div className="grid gap-2 sm:grid-cols-2">{(["medium", "high"] as const).map(level => {
        const verdict = data.factualVerdicts?.levels?.[level];
        return <section key={level} className="rounded border p-2"><strong>Factual check · {level}</strong><p>{verdict ? verdict.faithful && !verdict.unsupported.length && !verdict.misattributed.length && !verdict.homeworkNotSet.length ? "Passed" : "Flagged" : "Unavailable"}</p>{verdict ? <ul className="list-disc pl-4">{[...verdict.unsupported, ...verdict.misattributed, ...verdict.homeworkNotSet].map((reason, i) => <li key={i}>{reason}</li>)}</ul> : null}</section>;
      })}</div> : null}
      {data?.reviews.map(review => <section key={review.id}><strong>Style review: {review.status}</strong> · {when(review.createdAt)}<ul className="list-disc pl-4">{[...(review.result.formatProblems ?? []), ...(review.result.verdict?.problems ?? []), ...(review.result.reason ? [review.result.reason] : [])].map((reason, i) => <li key={i}>{reason}</li>)}</ul></section>)}
      {data?.evidence ? <details><summary className="cursor-pointer">Retained {data.evidence.evidenceKind}</summary><p className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap">{data.evidence.lessonRecord}</p></details> : null}
    </div>
  </details>;
}

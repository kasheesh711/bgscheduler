/** Unposted rollout comparisons. Only SELECTs, Wise GETs and API model calls; no feedback submission capability is invoked. */
import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import { getDb } from "@/lib/db";
import { loadAtomLessonEvidence } from "@/lib/feedback-autowriter/atom/data";
import { createWiseFeedbackOps } from "@/lib/feedback-autowriter/run";
import { runWritingPipeline, type PipelineResult } from "@/lib/feedback-autowriter/pipeline";
import { ISEB_FORMAT_GUIDE, isIsebClass } from "@/lib/feedback-autowriter/format";
import { MIMI_STYLE_GUIDE_V2 } from "@/lib/feedback-autowriter/style";
import { buildAtomLessonEvidence, atomSubject, evidenceHash } from "@/lib/feedback-autowriter/atom/evidence";
import { validateAtomStatisticClaims } from "@/lib/feedback-autowriter/atom/statistics";
import { parseAutowriterSessionDetail, extractAiSummary, studentParticipants, detailTeacherId, scheduledWindow, evaluateSessionGates } from "@/lib/feedback-autowriter/session";
import { chooseStudentDisplayName, describeClass } from "@/lib/feedback-autowriter/prompt";
import { AUTOWRITER_TEACHER_ALLOWLIST, rosterTutor } from "@/lib/feedback-autowriter/roster";
import { assignSpeakerRoles, renderTranscript } from "@/lib/feedback-autowriter/transcript";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
loadEnvConfig(option("env-dir") ?? process.cwd());
const out = path.resolve(option("out") ?? ".feedback-autowriter/iseb-v2-comparisons");
const oldDir = option("mimi-v1-dir");
const transcriptDir = option("transcript-dir");
const withAtom = process.argv.includes("--with-atom");
const quota: Record<string, number> = { Mimi: 10, Kevin: 4, Gift: 3, Ek: 2, Peat: 1 };
const esc = (v: string) => v.replace(/[&<>"']/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const save = (file: string, data: unknown) => fs.writeFileSync(path.join(out, file), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
interface Source { id: string; tutor: string; at: string; fields: FeedbackFieldAnswers }
interface Comparison { id: string; tutor: string; subject: string; evidence: string; before: FeedbackFieldAnswers; sourceHash: string; result: PipelineResult; calls: unknown[] }
const comparisons: Comparison[] = [];
function render() {
  const records: Comparison[] = fs.readdirSync(out).filter(file => /^[a-f0-9]{24}\.json$/u.test(file)).map(file => JSON.parse(fs.readFileSync(path.join(out,file),"utf8")));
  records.sort((a,b) => Object.keys(quota).indexOf(a.tutor)-Object.keys(quota).indexOf(b.tutor) || a.id.localeCompare(b.id));
  const passed = records.filter(row => row.result.kind === "draft");
  save("summary.json", { generatedAt: new Date().toISOString(), expected: quota, passed: Object.fromEntries(Object.keys(quota).map(tutor => [tutor, passed.filter(r => r.tutor === tutor).length])), format: { id: "iseb", version: 1 }, mimi: { id: "mimi", version: 2 }, posted: 0, comparisonHash: evidenceHash(records) });
  const fields = (v: FeedbackFieldAnswers) => Object.entries(v).map(([name,text]) => `<h4>${esc(name)}</h4><p>${esc(text || "—")}</p>`).join("");
  const body = records.map(row => `<article><h2>${esc(row.tutor)} · ${esc(row.subject)}</h2><p class="meta">${esc(row.result.kind === "draft" ? row.result.atomEvidence?.lessonStart ?? "Date unavailable" : "Held attempt")} · ${esc(row.evidence)} · ${esc(row.id)} · ${esc(row.result.kind)} · ${esc(row.result.kind === "draft" ? `Atom: ${row.result.atomEvidence?.status ?? "unavailable"}; ${row.result.atomEvidence?.omissions.map(item => item.reason).join(", ") ?? ""}` : "Held for review")}</p><div class="grid"><section><h3>Previous feedback / preserved Mimi v1 draft</h3>${fields(row.before)}</section><section><h3>ISEB v1 format${row.tutor === "Mimi" ? " · Mimi voice v2" : ""}</h3>${row.result.kind === "draft" ? fields(row.result.fields) : `<pre>${esc(JSON.stringify(row.result,null,2))}</pre>`}</section></div></article>`).join("");
  fs.writeFileSync(path.join(out,"comparison.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ISEB feedback comparisons</title><style>body{font:16px/1.65 system-ui;background:#f5f4ee;color:#233743;max-width:1250px;margin:auto;padding:28px}h1,h2,h3,h4{line-height:1.25}h4{text-transform:capitalize;margin-bottom:8px}p{white-space:pre-wrap;margin-top:0}.meta{font-size:13px;color:#536875}article{background:white;padding:24px;margin:24px 0;border:1px solid #dce3e4;border-radius:14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:32px}section{min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:750px){.grid{grid-template-columns:1fr}body{padding:12px}}@media print{article{break-inside:avoid}}</style><h1>ISEB feedback: unposted comparisons</h1><p>${passed.length}/20 accepted drafts. Both factual judges must pass. V1 artifacts are preserved. Atom statistics require approved identity links and matched activity evidence. Content activation remains subject to owner approval and cloud verification.</p>${body}</html>`, { mode: 0o600 });
}
function archived(id: string, tutor: string, teacherName: string): string | null {
  if (!transcriptDir) return null;
  const parse = (kind: string) => {
    const file = path.join(transcriptDir,`${tutor}-${id}.${kind}.txt`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file,"utf8").split("\n").flatMap(line => { const m=/^\[(\d+)s\] (.+?): (.*)$/u.exec(line); return m ? [{startMs:Number(m[1])*1000,speaker:m[2],text:m[3]}] : []; });
  };
  const raw=parse("soniox"), zoom=parse("zoom");
  if (!raw?.length || !zoom?.length) return null;
  const segments=raw.map((line,i)=>({...line,speaker:line.speaker.replace(/^Speaker /u,""),endMs:Math.max(line.startMs+100,raw[i+1]?.startMs??line.startMs+1000)}));
  const zoomCues=zoom.map((line,i)=>({startMs:line.startMs,endMs:Math.max(line.startMs+100,zoom[i+1]?.startMs??line.startMs+1000),speakerName:line.speaker,text:line.text}));
  const roles=assignSpeakerRoles({segments,zoomCues,teacherName});
  return roles.method === "unclear" ? null : renderTranscript(segments,roles.roles);
}
async function main() {
  if (process.argv.includes("--render-only")) { render(); return; }
  if (withAtom && (!option("out") || out === path.resolve(".feedback-autowriter/iseb-v2-comparisons"))) throw new Error("Use --out with a separate directory for enriched comparisons; preserve the lesson-only bundle.");
  if (withAtom && fs.existsSync(out) && fs.readdirSync(out).some(file => /^[a-f0-9]{24}\.json$/u.test(file))) throw new Error("Use a fresh --out directory so enriched comparisons recheck current student links and snapshots.");
  if (!process.env.DATABASE_URL || !process.env.OPENROUTER_API_KEY) throw new Error("Source database and model credentials required");
  fs.mkdirSync(out,{recursive:true,mode:0o700});
  const db=new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
  let sources: Source[];
  try {
    await db.query("BEGIN READ ONLY");
    const result=await db.query(`SELECT s.wise_session_id id,s.canonical_tutor_key tutor,s.scheduled_end_at at,
      jsonb_build_object('topics',v.topics,'performance',v.performance,'improvement',v.improvement,'homework',v.homework) fields
      FROM post_class_sessions s JOIN post_class_feedback_versions v ON v.id=s.latest_feedback_version_id
      WHERE s.canonical_tutor_key=ANY($1::text[]) AND s.scheduled_end_at<now()
      AND (s.source_metadata->>'subject' ~* '(ISEB|11[+]|13[+])' OR s.class_name ~* '(ISEB|11[+]|13[+])')
      ORDER BY s.scheduled_end_at DESC LIMIT 500`,[Object.keys(quota)]);
    sources=result.rows;
    await db.query("ROLLBACK");
  } finally { await db.end(); }
  const v1=new Map<string,FeedbackFieldAnswers>();
  if (oldDir) for(const file of fs.readdirSync(oldDir).filter(f=>/^[a-f0-9]{24}\.json$/u.test(f))) {
    const row=JSON.parse(fs.readFileSync(path.join(oldDir,file),"utf8"));
    if(row.generated?.kind==="draft") v1.set(file.slice(0,-5),row.generated.fields);
  }
  sources.sort((a,b)=>Number(v1.has(b.id))-Number(v1.has(a.id)));
  const getDetail=createWiseFeedbackOps().getSessionDetailById;
  for(const source of sources) {
    if (option("only-tutors") && !option("only-tutors")!.split(",").includes(source.tutor)) continue;
    if(comparisons.filter(r=>r.tutor===source.tutor&&r.result.kind==="draft").length>=quota[source.tutor]) continue;
    const checkpoint=path.join(out,`${source.id}.json`);
    if(fs.existsSync(checkpoint)) {
      const saved:Comparison=JSON.parse(fs.readFileSync(checkpoint,"utf8"));
      if(saved.result.kind==="held" || (saved.result.kind==="draft" && !validateAtomStatisticClaims(saved.result.fields,saved.result.atomEvidence??null).length)) {
        comparisons.push(saved); render(); continue;
      }
      fs.renameSync(checkpoint,path.join(out,`${source.id}.${saved.result.kind === "infra" ? "retry" : "unmatched-statistics"}.json`));
    }
    let detail;
    try { detail=parseAutowriterSessionDetail(await getDetail(source.id)); } catch { console.log(`Skipped ${source.tutor} ${source.id.slice(-6)}: Wise lesson detail unavailable`); continue; }
    const tutor=rosterTutor(detailTeacherId(detail)); const student=studentParticipants(detail)[0];
    const classDetails=describeClass({programme:detail.classSubject,title:detail.title});
    if(!tutor||!student?.name||!isIsebClass(tutor.canonicalKey,classDetails)) continue;
    const window=scheduledWindow(detail);
    const gate=evaluateSessionGates({...detail,feedbackSubmissions:[]},{now:new Date(window.end.getTime()+61*60_000),allowlist:AUTOWRITER_TEACHER_ALLOWLIST,requireSummary:false});
    if(!gate.ok) { console.log(`Skipped ${tutor.canonicalKey} ${source.id.slice(-6)}: ${JSON.stringify(gate)}`); continue; }
    const transcript=archived(source.id,tutor.canonicalKey,tutor.displayName);
    const text=transcript??extractAiSummary(detail)?.text;
    if(!text||text.length<200) { console.log(`Skipped ${tutor.canonicalKey} ${source.id.slice(-6)}: insufficient lesson evidence`); continue; }
    const evidence=transcript?"transcript" as const:"summary" as const;
    const atom=withAtom ? await loadAtomLessonEvidence(getDb(),{detail,studentId:student.wiseUserId,lessonRecord:text,preview:true})
      : buildAtomLessonEvidence({lesson:{sessionId:detail._id,studentId:student.wiseUserId??"",teacherId:detailTeacherId(detail)!,subject:atomSubject(detail.title??""),start:detail.scheduledStartTime,end:detail.scheduledEndTime},link:null,snapshot:null,now:new Date(),otherLessons:null,lessonRecord:text,unavailableReason:"student_unmapped"});
    const input={wiseSessionId:source.id,canonicalTutorKey:tutor.canonicalKey,atomEvidence:atom,studentFullName:student.name,studentAliases:student.joinedAsGuest?[student.joinedAsGuest]:[],studentDisplayName:chooseStudentDisplayName(student.name),classDetails,scheduledMinutes:window.minutes,summary:{text,meetingUUIDs:[]},evidence,speakerLabels:"inferred" as const};
    save(`${source.id}.source.json`,{...input,sourceHash:evidenceHash(input)});
    const calls:unknown[]=[];const started=Date.now();
    console.log(`Generating ${tutor.canonicalKey} ${evidence} ${source.id.slice(-6)}`);
    const result=await runWritingPipeline({apiKey:process.env.OPENROUTER_API_KEY,session:input,styleGuide:tutor.canonicalKey==="Mimi"?MIMI_STYLE_GUIDE_V2:null,formatGuide:ISEB_FORMAT_GUIDE,tutorNames:tutor.tutorNames,priorFeedback:sources.filter(s=>s.tutor===source.tutor&&s.id!==source.id).slice(0,10).map(s=>({key:s.id,fields:s.fields,studentNames:[]})),record:async record=>{const call={...record.call} as Record<string,unknown>;delete call.content;calls.push({...record,call});},remainingMs:()=>740000-(Date.now()-started)});
    const row:Comparison={id:source.id,tutor:tutor.canonicalKey,subject:detail.title??detail.classSubject??"ISEB",evidence,before:v1.get(source.id)??source.fields,sourceHash:evidenceHash(input),result,calls};
    comparisons.push(row);save(`${source.id}.json`,row);render();
    console.log(`${tutor.canonicalKey}: ${result.kind}`);
    if (result.kind === "infra" && result.rateLimited) break;
  }
  render();
}
main().catch(e=>{console.error(e instanceof Error ? e.message.replace(/postgres(?:ql)?:\/\/\S+/gu,"[database]") : "Comparison failed");process.exitCode=1});

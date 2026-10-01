/** Offline review only: SELECTs and Wise GETs, model calls in memory. No submission or control APIs. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import { runWritingPipeline, type CallRecord, type PipelineResult } from "@/lib/feedback-autowriter/pipeline";
import { activeStyleGuide, MIMI_STYLE_GUIDE, styleInstructions } from "@/lib/feedback-autowriter/style";
import mimiExamples from "@/lib/feedback-autowriter/style-examples/mimi-v1.json";
import { createWiseFeedbackOps } from "@/lib/feedback-autowriter/run";
import { chooseStudentDisplayName, describeClass, PROMPT_VERSION, redactForModel } from "@/lib/feedback-autowriter/prompt";
import { parseAutowriterSessionDetail, extractAiSummary, studentParticipants, detailTeacherId, scheduledWindow, evaluateSessionGates } from "@/lib/feedback-autowriter/session";
import { rosterAccountIds, rosterTutor, AUTOWRITER_TEACHER_ALLOWLIST } from "@/lib/feedback-autowriter/roster";
import { assignSpeakerRoles, renderTranscript } from "@/lib/feedback-autowriter/transcript";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";

const option = (key: string) => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
loadEnvConfig(option("env-dir") ?? process.cwd());
const outDir = path.resolve(option("out") ?? ".feedback-autowriter/mimi-style-review");
const transcriptDir = option("transcript-dir");
const transcriptIds = transcriptDir ? fs.readdirSync(transcriptDir).flatMap(name => /^Mimi-([a-f0-9]+)\.soniox\.txt$/u.exec(name)?.[1] ?? []).sort() : [];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
interface Source {
  wise_session_id: string; wise_teacher_user_id: string; scheduled_end_at: Date;
  topics: string; performance: string; improvement: string; homework: string;
  latest_human_actor: string; latest_human_event: string; latest_human_at: Date; names: string[];
}
interface ReviewCase {
  sessionId: string; subject: string; evidence: "summary" | "transcript";
  sourceSha256: string; historical: FeedbackFieldAnswers; generated: PipelineResult;
  guide: { id: string; version: number }; calls: unknown[];
}
interface SourceManifest {
  profileId: string; version: number;
  examples: Array<{ sha256: string; source: { wiseSessionId: string; versionId: string; latestHumanEventId: string; contentHash: string } }>;
}
function cachedTranscript(id: string, teacherName: string): string | null {
  if (!transcriptDir) return null;
  const soniox = path.join(transcriptDir, `Mimi-${id}.soniox.txt`);
  const zoom = path.join(transcriptDir, `Mimi-${id}.zoom.txt`);
  if (!fs.existsSync(soniox) || !fs.existsSync(zoom)) return null;
  const parse = (filename: string) => fs.readFileSync(filename, "utf8").split("\n").flatMap(line => {
    const match = /^\[(\d+)s\] (.+?): (.*)$/u.exec(line);
    return match ? [{ startMs: Number(match[1]) * 1000, speaker: match[2], text: match[3] }] : [];
  });
  const raw = parse(soniox);
  const segments = raw.map((line, index) => ({ ...line, speaker: line.speaker.replace(/^Speaker /u, ""), endMs: Math.max(line.startMs + 100, raw[index + 1]?.startMs ?? line.startMs + 1000) }));
  const cues = parse(zoom);
  const zoomCues = cues.map((line, index) => ({ startMs: line.startMs, endMs: Math.max(line.startMs + 100, cues[index + 1]?.startMs ?? line.startMs + 1000), speakerName: line.speaker, text: line.text }));
  const roles = assignSpeakerRoles({ segments, zoomCues, teacherName, alsoTeacher: ["Thanit (Mimi) Montrikittiphant", "Thanit (Mimi) Montrikittiphant Online"] });
  if (roles.method === "unclear") return null;
  const rendered = renderTranscript(segments, roles.roles);
  return [...rendered].length >= 800 ? rendered : null;
}
const escape = (value: string) => value.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
/** Human comments sometimes open with initials rather than a stored Wise nickname. Report-only redaction. */
function redactHistoricalInitials(fields: FeedbackFieldAnswers): FeedbackFieldAnswers {
  const initials = /^([\p{Lu}]{2,4})(?=\s(?:shared|demonstrated|submitted|completed|had|has|was|is|showed)\b)/u.exec(fields.performance)?.[1];
  if (!initials) return fields;
  const pattern = new RegExp(`(?<!\\p{L})${initials}(?!\\p{L})`, "gu");
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.replace(pattern, "[STUDENT_1]")])) as FeedbackFieldAnswers;
}
function report(cases: ReviewCase[]) {
  const pass = cases.filter(row => row.generated.kind === "draft").length;
  const ordered = [...cases.filter(row => row.generated.kind === "draft"), ...cases.filter(row => row.generated.kind !== "draft")];
  const blocks = ordered.map((row, index) => {
    const historical = redactHistoricalInitials(row.historical);
    const result = row.generated;
    const fields = result.kind === "draft" ? result.fields : null;
    const status = result.kind === "draft" ? "Factual and format checks passed · awaiting your review" : `Held: ${result.kind === "held" ? result.reasons.join("; ") : result.kind === "infra" ? result.error : "unknown"}`;
    const subject = row.subject.split(" · ").filter(part => !part.startsWith("Terms:")).map(part => part.replace(/^(?:Programme|Class subject): /u, "")).join(" · ");
    return `${index === pass && pass > 0 ? "<h2>Additional held attempts</h2><p>These replay attempts produced no accepted draft. A live run would hold the class for human feedback.</p>" : ""}<section><h2>${fields ? index + 1 : `Held ${index - pass + 1}`}. ${escape(subject)} · ${row.evidence}</h2><p class="status ${fields ? "" : "held"}">${escape(status)}</p><p class="meta">Session …${row.sessionId.slice(-6)} · Mimi guide v1 · ${row.evidence === "transcript" ? "Archived Soniox transcript; speaker labels inferred from saved Zoom alignment" : "Wise AI meeting summary"}</p><div class="columns"><h3>Previous human feedback</h3><h3>New review draft</h3>${(["topics", "performance", "improvement", "homework"] as const).map(field => `<article><h4>${field} <small>· ${[...historical[field]].length} characters</small></h4><span class="mobile-label">Previous human feedback</span><p>${escape(historical[field] || "No homework recorded")}</p></article><article><h4>${field} <small>· ${[...(fields?.[field] ?? "")].length} characters</small></h4><span class="mobile-label">New review draft</span><p>${escape(fields?.[field] ?? "No accepted draft") || "No homework assigned in the evidence"}</p></article>`).join("")}</div></section>`;
  }).join("");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mimi feedback format review</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f6f8fc;color:#192c40;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{font-size:32px}h2{font-size:23px}h3,h4{margin:0 0 10px}section{background:white;border:1px solid #d9e2ed;border-radius:12px;margin:24px 0;padding:24px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}article{border-top:1px solid #e3e9ef;padding:16px 0}article p{white-space:pre-wrap;margin:0}.status{font-weight:650;color:#236044}.held{color:#87410a}.meta,small{color:#52667c;font-size:14px}small{font-weight:400}.mobile-label{display:none}@media(max-width:650px){body{padding:12px}.columns{display:block}.columns>h3{display:none}.mobile-label{display:block;color:#52667c;font-size:14px;margin-bottom:8px}section{padding:16px}}@media print{section{break-inside:avoid}body{padding:0;background:white}}</style><main><h1>Mimi’s feedback format and voice</h1><p>${pass} drafts passed the factual judges and format checks, from ${cases.length} review attempts. <strong>Local review only. No feedback was posted. Production activation requires your approval.</strong></p><p>Compare numbering, concise lists, performance paragraphs, warmth and level of detail. Historical feedback is a style reference; the new draft uses the lesson record available to the autowriter, which may omit details Mimi recorded herself.</p><p class="meta">Historical sources have a pre-autowriter feedback event by a Mimi account. Wise activity confirms authorship at session level; it does not bind the exact saved content version to that event.</p>${blocks}</main></html>`;
  fs.writeFileSync(path.join(outDir, "comparison.html"), html, { mode: 0o600 });
}
async function main() {
  if (!process.env.OPENROUTER_API_KEY || !process.env.DATABASE_URL) throw new Error("Database and model credentials are required");
  // This repository is public. Wise identifiers belong in the private operator receipt, never in the guide.
  const manifestPath = option("source-manifest") ?? path.join(outDir, "source-provenance.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SourceManifest;
  if (manifest.profileId !== MIMI_STYLE_GUIDE.id || manifest.version !== MIMI_STYLE_GUIDE.version ||
    manifest.examples.length !== mimiExamples.examples.length || manifest.examples.some((row, index) => row.sha256 !== mimiExamples.examples[index].sha256)) {
    throw new Error("Private source manifest does not match the frozen guide");
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  let sources: Source[];
  try {
    await db.connect();
    await db.query("BEGIN READ ONLY");
    const rollout = await db.query<{ first_post: Date | null }>(`SELECT min(post_started_at) first_post
      FROM feedback_autowriter_posts WHERE wise_teacher_user_id=ANY($1::text[])
        AND kind='first_shot' AND outcome NOT IN ('not_sent','rejected')`, [rosterAccountIds("Mimi")]);
    const rolloutAt = rollout.rows[0]?.first_post;
    if (!rolloutAt) throw new Error("Cannot establish Mimi's first autowriter post for historical selection");
    save("historical-cutoff.json", { before: rolloutAt, source: "Earliest recorded Mimi first-shot post attempt, excluding not-sent/rejected" });
    const result = await db.query<Source>(`SELECT s.wise_session_id,s.wise_teacher_user_id,s.scheduled_end_at,
      v.topics,v.performance,v.improvement,v.homework,h.actor_wise_user_id latest_human_actor,
      h.event_id latest_human_event,h.event_timestamp latest_human_at,
      (SELECT jsonb_agg(p.student_name) FROM post_class_session_participants p WHERE p.session_id=s.id) names
      FROM post_class_sessions s JOIN post_class_feedback_versions v ON v.id=s.latest_feedback_version_id
      JOIN LATERAL (SELECT e.actor_wise_user_id,e.event_id,l.event_timestamp
        FROM post_class_feedback_event_links l JOIN wise_activity_events e ON e.id=l.wise_activity_event_id
        WHERE l.session_id=s.id AND l.auto_submitted IS DISTINCT FROM true
        ORDER BY l.event_timestamp DESC LIMIT 1) h ON true
      WHERE s.canonical_tutor_key='Mimi' AND v.provenance <> 'auto'
        AND s.scheduled_end_at < '2026-09-29T00:00:00+07:00'
        AND h.event_timestamp < $3::timestamptz
        AND s.scheduled_end_at >= '2026-09-01T00:00:00+07:00'
        AND length(v.topics || v.performance)>100 AND h.actor_wise_user_id=ANY($1::text[])
      ORDER BY (s.wise_session_id=ANY($2::text[])) DESC,s.scheduled_end_at DESC LIMIT 65`, [rosterAccountIds("Mimi"), transcriptIds, rolloutAt]);
    // Frozen version/event pairs remain usable if a tutor later edits the current feedback.
    // Never label that later edit as a pre-autowriter source just to include an archived transcript.
    const frozen = await db.query<Source>(`SELECT s.wise_session_id,s.wise_teacher_user_id,s.scheduled_end_at,
      v.topics,v.performance,v.improvement,v.homework,e.actor_wise_user_id latest_human_actor,
      e.event_id latest_human_event,l.event_timestamp latest_human_at,
      (SELECT jsonb_agg(p.student_name) FROM post_class_session_participants p WHERE p.session_id=s.id) names
      FROM unnest($1::uuid[], $2::text[], $5::text[]) frozen(version_id,event_id,content_hash)
      JOIN post_class_feedback_versions v ON v.id=frozen.version_id
      JOIN post_class_sessions s ON s.id=v.session_id
      JOIN post_class_feedback_event_links l ON l.session_id=s.id
      JOIN wise_activity_events e ON e.id=l.wise_activity_event_id AND e.event_id=frozen.event_id
      WHERE s.canonical_tutor_key='Mimi' AND v.provenance <> 'auto' AND v.content_hash=frozen.content_hash
        AND l.auto_submitted IS DISTINCT FROM true AND e.actor_wise_user_id=ANY($3::text[])
        AND s.scheduled_end_at < '2026-09-29T00:00:00+07:00'
        AND l.event_timestamp < $4::timestamptz`,
    [manifest.examples.map(row => row.source.versionId), manifest.examples.map(row => row.source.latestHumanEventId), rosterAccountIds("Mimi"), rolloutAt, manifest.examples.map(row => row.source.contentHash)]);
    if (frozen.rows.length !== manifest.examples.length) throw new Error("Frozen historical source evidence changed or is unavailable");
    sources = [...new Map([...result.rows, ...frozen.rows].map(row => [row.wise_session_id, row])).values()]
      .sort((left, right) => Number(transcriptIds.includes(right.wise_session_id)) - Number(transcriptIds.includes(left.wise_session_id)) || right.scheduled_end_at.getTime() - left.scheduled_end_at.getTime());
    await db.query("ROLLBACK");
  } finally { await db.end(); }
  save("historical-sources.json", sources.map(source => ({ sessionId: source.wise_session_id,
    actorWiseUserId: source.latest_human_actor, eventId: source.latest_human_event, eventAt: source.latest_human_at,
    classEnd: source.scheduled_end_at, contentSha256: digest([source.topics, source.performance, source.improvement, source.homework]),
    verification: "Pre-autowriter Mimi event; session-level authorship evidence only",
  })));
  const prior: PriorFeedbackComparison[] = sources.map(row => ({ key: row.wise_session_id, fields: { topics: row.topics, performance: row.performance, improvement: row.improvement, homework: row.homework }, studentNames: row.names }));
  const ops = createWiseFeedbackOps();
  const cases: ReviewCase[] = [];
  for (const source of sources) {
    if (cases.filter(row => row.generated.kind === "draft").length >= 10) break;
    const checkpoint = path.join(outDir, `${source.wise_session_id}.json`);
    if (fs.existsSync(checkpoint)) {
      const kept: ReviewCase = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
      if (kept.guide.id !== MIMI_STYLE_GUIDE.id || kept.guide.version !== MIMI_STYLE_GUIDE.version) throw new Error("Stale replay checkpoint: choose a new output directory");
      if (kept.generated.kind === "draft" && (kept.generated.styleGuide?.id !== MIMI_STYLE_GUIDE.id || kept.generated.styleGuide.version !== MIMI_STYLE_GUIDE.version)) throw new Error("Stored replay draft guide does not match");
      if (kept.generated.kind !== "infra" || !process.argv.includes("--retry-failed")) {
        const frozenIndex = manifest.examples.findIndex(example => example.source.wiseSessionId === source.wise_session_id);
        kept.historical = frozenIndex < 0 ? redactHistoricalInitials(kept.historical) : mimiExamples.examples[frozenIndex].fields;
        save(`${source.wise_session_id}.json`, kept); cases.push(kept); report(cases); continue;
      }
      save(`${source.wise_session_id}.infra-${Date.now()}.json`, kept);
    }
    let detail;
    try { detail = parseAutowriterSessionDetail(await ops.getSessionDetailById(source.wise_session_id)); }
    catch { console.log(`skip ${source.wise_session_id.slice(-6)}: detail unavailable`); continue; }
    const tutor = rosterTutor(detailTeacherId(detail));
    const gates = evaluateSessionGates({ ...detail, feedbackSubmissions: [] }, { now: new Date(scheduledWindow(detail).end.getTime() + 61 * 60_000), allowlist: AUTOWRITER_TEACHER_ALLOWLIST, requireSummary: false });
    if (!gates.ok) continue;
    const students = studentParticipants(detail);
    if (tutor?.canonicalKey !== "Mimi" || students.length !== 1 || !students[0]?.name) continue;
    const student = students[0];
    const summary = extractAiSummary(detail);
    const transcript = cachedTranscript(source.wise_session_id, tutor.displayName);
    const evidence = transcript ? "transcript" as const : "summary" as const;
    const text = transcript ?? summary?.text;
    if (!text || [...text].length < 200) continue;
    const names = { studentFullName: student.name, studentAliases: student.joinedAsGuest ? [student.joinedAsGuest] : [], tutorNames: tutor.tutorNames };
    const recordCalls: unknown[] = [];
    console.log(`draft ${cases.filter(row => row.generated.kind === "draft").length + 1}/10 …${source.wise_session_id.slice(-6)} ${evidence}`);
    const started = Date.now();
    const generated = await runWritingPipeline({
      apiKey: process.env.OPENROUTER_API_KEY, styleGuide: MIMI_STYLE_GUIDE,
      session: { wiseSessionId: source.wise_session_id, canonicalTutorKey: "Mimi", ...names, studentDisplayName: chooseStudentDisplayName(student.name), classDetails: describeClass({ programme: detail.classSubject, title: detail.title }), scheduledMinutes: scheduledWindow(detail).minutes, summary: { text, meetingUUIDs: [] }, evidence, speakerLabels: "inferred" },
      tutorNames: tutor.tutorNames, priorFeedback: prior,
      record: async (call: CallRecord) => { const metadata = { ...call.call } as Record<string, unknown>; delete metadata.content; recordCalls.push({ role: call.role, arm: call.arm, result: call.result, call: metadata }); },
      remainingMs: () => 1_400_000 - (Date.now() - started),
    });
    // Save only anonymous text; lesson records and participant names stay in memory.
    if (generated.kind === "draft") {
      for (const field of ["topics", "performance", "improvement", "homework"] as const) generated.fields[field] = redactForModel(generated.fields[field], names);
    }
    const historical = redactHistoricalInitials(Object.fromEntries((["topics", "performance", "improvement", "homework"] as const).map(field => [field,
      (source.names ?? []).reduce((text, studentFullName) => redactForModel(text, { ...names, studentFullName }),
        redactForModel(source[field], { ...names, studentAliases: [...names.studentAliases, ...(source.names ?? [])] })),
    ])) as FeedbackFieldAnswers);
    const row: ReviewCase = { sessionId: source.wise_session_id, subject: describeClass({ programme: detail.classSubject, title: detail.title }).join(" · ") || "Lesson", evidence, sourceSha256: digest(text), historical, generated, guide: { id: "mimi", version: MIMI_STYLE_GUIDE.version }, calls: recordCalls };
    cases.push(row); save(`${source.wise_session_id}.json`, row); report(cases);
    console.log(`${generated.kind} …${source.wise_session_id.slice(-6)}`);
  }
  const accepted = cases.filter(row => row.generated.kind === "draft");
  const evidenceCoveragePassed = (["summary", "transcript"] as const).every(evidence =>
    !cases.some(row => row.evidence === evidence) || accepted.some(row => row.evidence === evidence));
  save("summary.json", { total: accepted.length, attempted: cases.length, passed: accepted.length,
    guide: { id: MIMI_STYLE_GUIDE.id, version: MIMI_STYLE_GUIDE.version, instructionsSha256: digest(styleInstructions(MIMI_STYLE_GUIDE)) },
    promptVersion: PROMPT_VERSION, byEvidence: accepted.reduce((all, row) => ({ ...all, [row.evidence]: (all[row.evidence] ?? 0) + 1 }), {} as Record<string, number>),
    cases: cases.map(row => ({ sessionId: row.sessionId, evidence: row.evidence, result: row.generated.kind })),
    evidenceCoveragePassed, awaitingOwnerApproval: true, posted: 0, guideEnabled: Boolean(activeStyleGuide("Mimi")) });
  if (accepted.length !== 10 || !evidenceCoveragePassed) process.exitCode = 1;
  console.log(`Saved ${cases.length} comparisons to ${outDir}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

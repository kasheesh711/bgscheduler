import { AUTOWRITER_MIN_TRANSCRIPT_CHARACTERS } from "./config";
import { SONIOX_TERMS, describeClass, parseStudentName, type SpeakerLabels } from "./prompt";
import { recordingTooShort, type AutowriterSessionDetail } from "./session";
import type { SonioxClient, SonioxToken } from "./soniox";

/**
 * Turning a Soniox transcript into speaker turns the writer can use. Soniox
 * labels speakers "1", "2", …; who is the tutor comes from Zoom's own transcript
 * (Wise `rawTranscript`, whose cues carry display names) by time overlap, with
 * a clear talk-share split as the fallback (tutors did 74–93% of the talking in
 * the pilot). Anything else is "unclear" and the class goes to a person.
 * `sonioxJobInput` and `buildTranscriptEvidence` are shared by the second pass
 * (job.ts) and the read-only replay (replay.ts), so both see the same evidence.
 */

export interface Segment {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface ZoomCue {
  speakerName: string;
  startMs: number;
  endMs: number;
}

export type SpeakerRole = "tutor" | "student" | "other";

export interface RoleAssignment {
  roles: Map<string, SpeakerRole>;
  /**
   * zoom_alignment: labels confirmed by Zoom's named cues. talk_share: inferred
   * from a clear split (two main speakers, one with ≥ 60%). unclear: neither —
   * the class is not written from this transcript.
   */
  method: "zoom_alignment" | "talk_share" | "unclear";
  /** Share of all transcript characters spoken by each role, in percent. */
  shares: Record<SpeakerRole, number>;
}

export function segmentsFromTokens(tokens: readonly SonioxToken[]): Segment[] {
  const out: Segment[] = [];
  for (const token of tokens) {
    const speaker = token.speaker ?? "?";
    const endMs = token.end_ms ?? token.start_ms;
    const last = out.at(-1);
    if (last && last.speaker === speaker) {
      last.text += token.text;
      last.endMs = Math.max(last.endMs, endMs);
    } else {
      out.push({ speaker, startMs: token.start_ms, endMs, text: token.text.replace(/^\s+/u, "") });
    }
  }
  return out.filter((segment) => segment.text.trim() !== "");
}

function vttTimeMs(value: string): number | null {
  const match = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/u.exec(value.trim());
  if (!match) return null;
  const [, hours = "0", minutes, seconds, fraction] = match;
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));
}

/** Zoom WEBVTT: cues of "Speaker Name: text" with start --> end times. */
export function parseZoomVtt(vtt: string): ZoomCue[] {
  const cues: ZoomCue[] = [];
  for (const block of vtt.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u).filter((line) => line.trim() !== "");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [from, to] = lines[timingIndex].split("-->");
    const startMs = vttTimeMs(from);
    const endMs = vttTimeMs(to ?? "");
    const body = lines.slice(timingIndex + 1).join(" ");
    const speakerName = /^([^:]{1,80}):\s/u.exec(body)?.[1]?.trim();
    if (startMs === null || endMs === null || !speakerName) continue;
    cues.push({ speakerName, startMs, endMs });
  }
  return cues;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

/** Exact share (0–1) of all transcript characters spoken by each role. */
function roleRatios(segments: readonly Segment[], roles: Map<string, SpeakerRole>): Record<SpeakerRole, number> {
  const chars: Record<SpeakerRole, number> = { tutor: 0, student: 0, other: 0 };
  for (const segment of segments) chars[roles.get(segment.speaker) ?? "other"] += segment.text.length;
  const total = chars.tutor + chars.student + chars.other || 1;
  return { tutor: chars.tutor / total, student: chars.student / total, other: chars.other / total };
}

function percent(ratios: Record<SpeakerRole, number>): Record<SpeakerRole, number> {
  return {
    tutor: Math.round(ratios.tutor * 100),
    student: Math.round(ratios.student * 100),
    other: Math.round(ratios.other * 100),
  };
}

/** Zoom-aligned roles are only trusted when the tutor has at least this share of the talk … */
const ALIGNED_MIN_TUTOR_SHARE = 0.5;
/** … and the student at least this share. */
const ALIGNED_MIN_STUDENT_SHARE = 0.05;
/**
 * A student may out-talk the tutor (a chatty student, a student reading answers aloud). That alignment is still
 * trusted when Zoom's cues name nobody but the tutor and that student, every substantive Soniox speaker sits
 * cleanly on one side, and the tutor still carries at least this share.
 */
const NAMED_MIN_TUTOR_SHARE = 0.2;
/** A Soniox speaker is "clean" when at least this share of its cue overlap is on one side … */
const ALIGNED_MIN_PURITY = 0.8;
/** … and clean speakers must carry at least this share of the text (many tiny speakers cannot skip the check). */
const ALIGNED_MIN_CLEAN_TEXT = 0.9;
/** A speaker with less than this share of the text is noise (a cough, a stray turn), not a participant. */
const SUBSTANTIVE_SHARE = 0.05;
/** Talk share alone only names the tutor when one of two main speakers clearly dominates. */
const CLEAR_TUTOR_SHARE = 0.6;

function byTalkShare(segments: readonly Segment[]): { roles: Map<string, SpeakerRole>; clear: boolean } {
  const chars = new Map<string, number>();
  for (const segment of segments) chars.set(segment.speaker, (chars.get(segment.speaker) ?? 0) + segment.text.length);
  const total = [...chars.values()].reduce((sum, value) => sum + value, 0) || 1;
  const ranked = [...chars.entries()].toSorted((a, b) => b[1] - a[1]);
  const substantive = ranked.filter(([, value]) => value / total >= SUBSTANTIVE_SHARE);
  const clear = substantive.length === 2 && substantive[0][1] / total >= CLEAR_TUTOR_SHARE;
  const roles = new Map(ranked.map(([speaker], index): [string, SpeakerRole] =>
    [speaker, index === 0 ? "tutor" : index === 1 ? "student" : "other"]));
  return { roles, clear };
}

/** Zoom's cues name the tutor (any of their names) and the student, and nobody else. */
function onlyTutorAndStudentNamed(cues: readonly ZoomCue[], teacherNames: ReadonlySet<string>, studentNames: readonly string[] | undefined): boolean {
  const students = new Set((studentNames ?? []).filter((name) => name.trim() !== "").map(normalizeName));
  // A name on both lists would be the student here and the tutor in the overlap vote: trust neither.
  if (students.size === 0 || [...students].some((name) => teacherNames.has(name))) return false;
  let studentNamed = false;
  for (const cue of cues) {
    const name = normalizeName(cue.speakerName);
    if (students.has(name)) studentNamed = true;
    else if (!teacherNames.has(name)) return false;
  }
  return studentNamed;
}

/**
 * Every substantive Soniox speaker (≥ 5% of the text) overlaps one side's cues at least 80% of the time, and the
 * clean speakers carry at least 90% of the text. A speaker that straddles both is diarization merging the two
 * people, and no per-speaker label can be right.
 */
function cleanlySplit(segments: readonly Segment[], teacherOverlap: ReadonlyMap<string, number>, otherOverlap: ReadonlyMap<string, number>): boolean {
  const chars = new Map<string, number>();
  for (const segment of segments) chars.set(segment.speaker, (chars.get(segment.speaker) ?? 0) + segment.text.length);
  const total = [...chars.values()].reduce((sum, value) => sum + value, 0) || 1;
  let cleanText = 0;
  for (const [speaker, value] of chars) {
    const tutor = teacherOverlap.get(speaker) ?? 0;
    const other = otherOverlap.get(speaker) ?? 0;
    const clean = tutor + other > 0 && Math.max(tutor, other) / (tutor + other) >= ALIGNED_MIN_PURITY;
    if (clean) cleanText += value;
    else if (value / total >= SUBSTANTIVE_SHARE) return false;
  }
  return cleanText / total >= ALIGNED_MIN_CLEAN_TEXT;
}

/**
 * Tutor = every Soniox speaker whose talk overlaps Zoom cues of the teacher's
 * display name more than anyone else's; student = those overlapping the other
 * participant's cues. Trusted only when the result looks like a one-to-one
 * lesson (tutor ≥ 50% of the talk, student ≥ 5%) — or, when Zoom names only the
 * tutor and the student and every substantive speaker is cleanly on one side,
 * tutor ≥ 20% and student ≥ 5% — else unclear. Falls back to
 * talk share when Zoom has no cues under the teacher's name or only one side
 * aligned, and calls it unclear when the split contradicts Zoom's cues.
 */
export function assignSpeakerRoles(input: {
  segments: readonly Segment[];
  zoomCues: readonly ZoomCue[];
  teacherName: string | null;
  /**
   * Other names the same tutor may appear under in Zoom's cues (their other Wise
   * account, a second device joined as a guest under their own name): their
   * lines are the tutor's, never the student's.
   */
  alsoTeacher?: readonly string[];
  /**
   * The student's Wise name and any guest name they joined under. Only when Zoom's cues name nobody else may a
   * student who out-talks the tutor be trusted; without it the tutor must carry half the talk.
   */
  studentNames?: readonly string[];
}): RoleAssignment {
  const { segments } = input;
  const teacher = input.teacherName ? normalizeName(input.teacherName) : null;
  const teacherNames = new Set([...(teacher ? [teacher] : []), ...(input.alsoTeacher ?? []).map(normalizeName)]);
  let zoomTutors = new Set<string>();
  let zoomStudents = new Set<string>();
  // Without a cue under the teacher's name, Zoom says nothing about who is who.
  if (teacher && input.zoomCues.some((cue) => teacherNames.has(normalizeName(cue.speakerName)))) {
    const teacherOverlap = new Map<string, number>();
    const otherOverlap = new Map<string, number>();
    for (const segment of segments) {
      for (const cue of input.zoomCues) {
        const overlap = Math.min(segment.endMs, cue.endMs) - Math.max(segment.startMs, cue.startMs);
        if (overlap <= 0) continue;
        const target = teacherNames.has(normalizeName(cue.speakerName)) ? teacherOverlap : otherOverlap;
        target.set(segment.speaker, (target.get(segment.speaker) ?? 0) + overlap);
      }
    }
    const speakers = [...new Set(segments.map((segment) => segment.speaker))];
    // Diarization can split one person (e.g. their Thai and English turns): every
    // speaker that mostly overlaps the teacher's cues is the tutor.
    const tutorLike = new Set(speakers.filter((speaker) => (teacherOverlap.get(speaker) ?? 0) > (otherOverlap.get(speaker) ?? 0)));
    const studentLike = new Set(speakers.filter((speaker) => (otherOverlap.get(speaker) ?? 0) > (teacherOverlap.get(speaker) ?? 0)));
    zoomTutors = tutorLike;
    zoomStudents = studentLike;
    if (tutorLike.size >= 1 && studentLike.size >= 1) {
      const roles = new Map<string, SpeakerRole>(speakers.map((speaker): [string, SpeakerRole] =>
        [speaker, tutorLike.has(speaker) ? "tutor" : studentLike.has(speaker) ? "student" : "other"]));
      const ratios = roleRatios(segments, roles);
      // A plausible one-to-one lesson: the tutor carries a real share and the student is actually heard.
      // Anything else (a rejoin under another name, noise aligned as "student") is not trusted.
      const plausible = ratios.student >= ALIGNED_MIN_STUDENT_SHARE && (ratios.tutor >= ALIGNED_MIN_TUTOR_SHARE
        || (ratios.tutor >= NAMED_MIN_TUTOR_SHARE && onlyTutorAndStudentNamed(input.zoomCues, teacherNames, input.studentNames)
          && cleanlySplit(segments, teacherOverlap, otherOverlap)));
      return { roles, method: plausible ? "zoom_alignment" : "unclear", shares: percent(ratios) };
    }
  }
  const { roles, clear } = byTalkShare(segments);
  // Zoom's cues, where they place a speaker, must agree with the talk-share split.
  const contradicts = [...roles].some(([speaker, role]) =>
    (role === "tutor" && zoomStudents.has(speaker)) || (role === "student" && zoomTutors.has(speaker)));
  return { roles, method: clear && !contradicts ? "talk_share" : "unclear", shares: percent(roleRatios(segments, roles)) };
}

function clock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

const ROLE_LABEL: Record<SpeakerRole, string> = { tutor: "TUTOR", student: "STUDENT", other: "OTHER" };

/**
 * "[mm:ss] TUTOR: …" lines; names are redacted later with the summary redactor.
 * A transcript over `maxChars` keeps its start and its end (where homework is
 * usually set) and drops the middle.
 */
export function renderTranscript(segments: readonly Segment[], roles: Map<string, SpeakerRole>, maxChars = 120_000): string {
  const lines = segments.map((segment) =>
    `[${clock(segment.startMs)}] ${ROLE_LABEL[roles.get(segment.speaker) ?? "other"]}: ${segment.text.trim()}`);
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= maxChars) return lines.join("\n");
  const take = (from: string[], budget: number) => {
    const kept: string[] = [];
    let used = 0;
    for (const line of from) {
      if (used + line.length + 1 > budget) break;
      kept.push(line);
      used += line.length + 1;
    }
    return kept;
  };
  const head = take(lines, Math.floor(maxChars * 0.7));
  const tail = take([...lines].reverse(), Math.floor(maxChars * 0.3) - 40).reverse();
  return [...head, "[… middle of the lesson omitted …]", ...tail].join("\n");
}

/** Share of Thai letters among Thai + Latin letters (0–1); 0 for empty text. */
export function thaiShare(text: string): number {
  let thai = 0;
  let latin = 0;
  for (const char of text) {
    if (char >= "฀" && char <= "๿") thai += 1;
    else if (/[A-Za-z]/u.test(char)) latin += 1;
  }
  return thai + latin === 0 ? 0 : thai / (thai + latin);
}

/**
 * The Soniox job for a class's recording: our terms plus the tutor's and the
 * student's names as vocabulary, and the class details as context. The Wise
 * session id is the client reference (the orphan reaper recognises it).
 */
export function sonioxJobInput(input: {
  wiseSessionId: string;
  audioUrl: string;
  detail: Pick<AutowriterSessionDetail, "classSubject" | "title">;
  tutorNames: readonly string[];
  studentName: string;
}): Parameters<SonioxClient["create"]>[0] {
  const classLines = describeClass({ programme: input.detail.classSubject, title: input.detail.title });
  const student = parseStudentName(input.studentName);
  return {
    audioUrl: input.audioUrl,
    terms: [...SONIOX_TERMS, ...input.tutorNames, student.firstName, student.nickname ?? ""]
      .filter((term) => term.trim() !== ""),
    general: [{ key: "domain", value: "one-to-one online tutoring lesson between a tutor and a student" },
      ...classLines.map((line) => ({ key: "class", value: line }))],
    clientReferenceId: input.wiseSessionId,
  };
}

/** What a finished Soniox transcript gives the writer, and whether it can be written from at all. */
export interface TranscriptEvidence {
  /** `[mm:ss] TUTOR/STUDENT: …` lines, names not redacted yet (the pipeline redacts them). */
  rendered: string;
  speakers: RoleAssignment;
  /** The models are told the labels are reliable only when Zoom confirmed them. */
  speakerLabels: SpeakerLabels;
  /** Stored with the draft, hold or fallback as `metadata.transcript`. */
  meta: {
    audioMinutes: number;
    speakerMethod: RoleAssignment["method"];
    shares: Record<SpeakerRole, number>;
    thaiShare: number;
  };
  /**
   * Too little to write from: Soniox heard much less audio than the class (a recording that stopped early would
   * be written up as the whole lesson), or the rendered transcript is under the minimum. Checked in this order.
   */
  tooShort: "recording_too_short" | "transcript_too_short" | null;
}

/**
 * Speaker turns, roles (Zoom's named cues when there are any, a clear talk share otherwise), the rendered
 * transcript and its coverage checks. Pure: fetching Zoom's WEBVTT and deciding whether to wait for it stay with
 * the caller. `speakers.method === "unclear"` is for the caller to act on, after any wait for Zoom.
 */
export function buildTranscriptEvidence(input: {
  transcript: { text: string; tokens: readonly SonioxToken[] };
  /** Soniox's own audio length; null when it gave none. */
  audioDurationMs: number | null;
  scheduledMinutes: number;
  zoomCues: readonly ZoomCue[];
  teacherName: string | null;
  alsoTeacher: readonly string[];
  /** The student's Wise name and any guest name they joined under (see `assignSpeakerRoles`). */
  studentNames?: readonly string[];
}): TranscriptEvidence {
  const segments = segmentsFromTokens(input.transcript.tokens);
  const speakers = assignSpeakerRoles({
    segments, zoomCues: input.zoomCues, teacherName: input.teacherName, alsoTeacher: input.alsoTeacher,
    studentNames: input.studentNames,
  });
  const rendered = renderTranscript(segments, speakers.roles);
  const audioDurationMs = input.audioDurationMs ?? 0;
  const tooShort = input.audioDurationMs !== null && recordingTooShort(input.audioDurationMs / 1000, input.scheduledMinutes)
    ? "recording_too_short" as const
    : rendered.length < AUTOWRITER_MIN_TRANSCRIPT_CHARACTERS ? "transcript_too_short" as const : null;
  return {
    rendered,
    speakers,
    speakerLabels: speakers.method === "zoom_alignment" ? "verified" : "inferred",
    meta: {
      audioMinutes: Math.round(audioDurationMs / 600) / 100,
      speakerMethod: speakers.method,
      shares: speakers.shares,
      thaiShare: Math.round(thaiShare(input.transcript.text) * 100) / 100,
    },
    tooShort,
  };
}

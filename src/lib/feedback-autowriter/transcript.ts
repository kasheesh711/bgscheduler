import {
  AUTOWRITER_MIN_TRANSCRIPT_CHARACTERS,
  AUTOWRITER_ZOOM_ENGLISH_MAX_THAI_SHARE,
  AUTOWRITER_ZOOM_ENGLISH_MIN_CAPTION_COVERAGE,
} from "./config";
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
   * zoom_alignment: labels confirmed by Zoom's named cues. zoom_timing: Soniox heard one voice, so each phrase is
   * labelled by whose Zoom cue it falls in (`labelByZoomTiming`). talk_share: inferred from a clear split (two main
   * speakers, one with ≥ 60%). unclear: none of these — the class is not written from this transcript.
   */
  method: "zoom_alignment" | "zoom_timing" | "talk_share" | "unclear";
  /** Share of all transcript characters spoken by each role, in percent (zoom_timing: of the labelled text). */
  shares: Record<SpeakerRole, number>;
  /** zoom_timing only: the share of the transcript's text a Zoom cue labelled, in percent (the rest is left out). */
  labelled?: number;
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

/** Every timed Zoom WEBVTT cue with what was said; `speakerName` is null for a cue Zoom gave no "Speaker Name: ". */
function parseZoomLines(vtt: string): Array<{ speakerName: string | null; startMs: number; endMs: number; text: string }> {
  const cues: Array<{ speakerName: string | null; startMs: number; endMs: number; text: string }> = [];
  for (const block of vtt.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u).filter((line) => line.trim() !== "");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [from, to] = lines[timingIndex].split("-->");
    const startMs = vttTimeMs(from);
    const endMs = vttTimeMs(to ?? "");
    const body = lines.slice(timingIndex + 1).join(" ");
    if (startMs === null || endMs === null) continue;
    const named = /^([^:]{1,80}):\s/u.exec(body);
    const speakerName = named?.[1]?.trim() || null;
    cues.push({ speakerName, startMs, endMs, text: (named && speakerName ? body.slice(named[0].length) : body).trim() });
  }
  return cues;
}

/** Zoom WEBVTT: cues of "Speaker Name: text" with start --> end times. */
export function parseZoomVtt(vtt: string): ZoomCue[] {
  return parseZoomLines(vtt).flatMap(({ speakerName, startMs, endMs }) => speakerName ? [{ speakerName, startMs, endMs }] : []);
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
 * cleanly on one side and clean speakers carry ≥ 90% of the text, and the tutor still carries at least this share.
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
 * tutor and the student, every substantive speaker is cleanly on one side and
 * clean speakers carry ≥ 90% of the text, tutor ≥ 20% and student ≥ 5% — else unclear. Falls back to
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

// ---------------------------------------------------------------------------
// Zoom timing: who spoke when, phrase by phrase, when Soniox hears one voice
// ---------------------------------------------------------------------------

/** A phrase ends at a Soniox speaker change, a pause of this long, or the end of a sentence. */
const TIMING_PAUSE_MS = 400;
/**
 * A phrase takes the role of the cues covering at least this share of its overlapped time; otherwise it is left out.
 * (Also requiring named cues over 30% of the phrase itself cost 2 of 10 rescued classes for no gain in precision on
 * Thai lessons, 12 Oct 2026: not done.)
 */
const TIMING_MAJORITY = 0.6;
/** Left-out speech of at least this long shows as a marker line, so neither model reads the gap as silence. */
const TIMING_GAP_MARK_MS = 3_000;
/** The speaker of a marker line (`renderTranscript` prints it without a role). */
const LEFT_OUT = "left_out";
/** Zoom must label at least this share of the transcript's text … */
const TIMING_MIN_COVERAGE = 0.85;
/** … the student must have been heard by Zoom (cues under their name) … */
const TIMING_MIN_STUDENT_CUES = 10;
/** … and, with only Zoom vouching for the labels, the tutor must carry half the labelled talk (as on the Zoom route). */
const TIMING_MIN_TUTOR_SHARE = 0.5;

function phrasesFromTokens(tokens: readonly SonioxToken[]): Segment[] {
  const out: Segment[] = [];
  for (const token of tokens) {
    const speaker = token.speaker ?? "?";
    const endMs = token.end_ms ?? token.start_ms;
    const last = out.at(-1);
    if (last && last.speaker === speaker && token.start_ms - last.endMs < TIMING_PAUSE_MS && !/[.?!]\s*$/u.test(last.text)) {
      last.text += token.text;
      last.endMs = Math.max(last.endMs, endMs);
    } else {
      out.push({ speaker, startMs: token.start_ms, endMs, text: token.text.replace(/^\s+/u, "") });
    }
  }
  return out.filter((segment) => segment.text.trim() !== "");
}

/**
 * Soniox sometimes hears the tutor and the student as one voice (most of the 35 "unclear" classes in October 2026:
 * one Soniox speaker with 96–100% of the text), and no per-speaker label can then be right. Zoom times each
 * participant's own microphone, so its named cues say who spoke when even where its words are poor. Each phrase
 * takes the role of the cues it overlaps (≥ 60% of the overlapped time); a phrase no cue overlaps, or overlapped by
 * both people about evenly, is left out, never guessed, and a left-out stretch of ≥ 3 s shows as a marker line.
 * The labels stay "inferred" for the writer and the judges. Measured on 9–12 Oct classes against the per-speaker
 * alignment of 16 aligned classes (itself imperfect on Thai lessons): of the STUDENT-labelled text, 10.7% (Thai-heavy)
 * and 5.5% (English-heavy) was the tutor's by that yardstick, worst class 15.7%; 10 of 11 unclear classes labelled.
 * Only when Zoom names nobody but the tutor and the student, the student is heard (≥ 10 cues), Zoom's captions run
 * to ≥ 90% of the transcript, Zoom labels ≥ 85% of the text and the tutor carries ≥ 50% of it; null otherwise (the
 * class stays unclear).
 */
export function labelByZoomTiming(input: {
  tokens: readonly SonioxToken[];
  zoomCues: readonly ZoomCue[];
  teacherName: string | null;
  alsoTeacher?: readonly string[];
  studentNames?: readonly string[];
}): { segments: Segment[]; speakers: RoleAssignment } | null {
  const teacherNames = new Set([...(input.teacherName ? [input.teacherName] : []), ...(input.alsoTeacher ?? [])].map(normalizeName));
  // Every cue is the tutor's or the student's (checked first), so a cue not under the tutor's names is the student's.
  if (teacherNames.size === 0 || !onlyTutorAndStudentNamed(input.zoomCues, teacherNames, input.studentNames)) return null;
  const cues = input.zoomCues
    .map((cue) => ({ ...cue, role: teacherNames.has(normalizeName(cue.speakerName)) ? "tutor" as const : "student" as const }))
    .toSorted((a, b) => a.startMs - b.startMs);
  if (cues.filter((cue) => cue.role === "student").length < TIMING_MIN_STUDENT_CUES) return null;
  // Captions that stop early would leave the lesson's end (where homework is set) out without a trace.
  const lastSpeech = input.tokens.reduce((max, token) => Math.max(max, token.end_ms ?? token.start_ms), 0);
  const lastCaption = cues.reduce((max, cue) => Math.max(max, cue.endMs), 0);
  if (lastCaption < lastSpeech * AUTOWRITER_ZOOM_ENGLISH_MIN_CAPTION_COVERAGE) return null;

  const roleOf = (phrase: Segment): "tutor" | "student" | null => {
    const start = phrase.startMs;
    const end = Math.max(phrase.endMs, phrase.startMs + 1);
    const time = { tutor: 0, student: 0 };
    for (const cue of cues) {
      if (cue.startMs >= end) break;
      const overlap = Math.min(end, cue.endMs) - Math.max(start, cue.startMs);
      if (overlap > 0) time[cue.role] += overlap;
    }
    const covered = time.tutor + time.student;
    if (covered === 0) return null;
    const role = time.tutor >= time.student ? "tutor" : "student";
    return time[role] / covered >= TIMING_MAJORITY ? role : null;
  };

  const phrases = phrasesFromTokens(input.tokens);
  const total = phrases.reduce((sum, phrase) => sum + phrase.text.length, 0) || 1;
  const segments: Segment[] = [];
  // Counted on the phrases themselves: joining them into turns adds spaces.
  let labelledChars = 0;
  let leftOut: { startMs: number; endMs: number } | null = null;
  const markLeftOut = () => {
    if (leftOut && leftOut.endMs - leftOut.startMs >= TIMING_GAP_MARK_MS) {
      const seconds = Math.round((leftOut.endMs - leftOut.startMs) / 1000);
      segments.push({ speaker: LEFT_OUT, startMs: leftOut.startMs, endMs: leftOut.endMs, text: `[… ${seconds} s not attributable to either speaker, left out …]` });
    }
    leftOut = null;
  };
  for (const phrase of phrases) {
    const role = roleOf(phrase);
    if (!role) {
      leftOut = leftOut ? { startMs: leftOut.startMs, endMs: Math.max(leftOut.endMs, phrase.endMs) } : { startMs: phrase.startMs, endMs: phrase.endMs };
      continue;
    }
    markLeftOut();
    labelledChars += phrase.text.length;
    const last = segments.at(-1);
    if (last && last.speaker === role) {
      last.text += ` ${phrase.text.trim()}`;
      last.endMs = Math.max(last.endMs, phrase.endMs);
    } else {
      segments.push({ ...phrase, speaker: role, text: phrase.text.trim() });
    }
  }
  markLeftOut();
  const roles = new Map<string, SpeakerRole>([["tutor", "tutor"], ["student", "student"]]);
  // Shares of the labelled text only: the markers are no one's.
  const ratios = roleRatios(segments.filter((segment) => segment.speaker !== LEFT_OUT), roles);
  if (labelledChars / total < TIMING_MIN_COVERAGE || ratios.tutor < TIMING_MIN_TUTOR_SHARE || ratios.student <= 0) return null;
  return { segments, speakers: { roles, method: "zoom_timing", shares: percent(ratios), labelled: Math.round((labelledChars / total) * 100) } };
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
  const lines = segments.map((segment) => segment.speaker === LEFT_OUT
    ? `[${clock(segment.startMs)}] ${segment.text}`
    : `[${clock(segment.startMs)}] ${ROLE_LABEL[roles.get(segment.speaker) ?? "other"]}: ${segment.text.trim()}`);
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

/** What a finished transcript (Soniox's, or Zoom's own captions) gives the writer, and whether it can be written from at all. */
export interface TranscriptEvidence {
  /** `[mm:ss] TUTOR/STUDENT: …` lines, names not redacted yet (the pipeline redacts them). */
  rendered: string;
  speakers: RoleAssignment;
  /** The models are told the labels are reliable only when Zoom confirmed them. */
  speakerLabels: SpeakerLabels;
  /** Stored with the draft, hold or fallback as `metadata.transcript`. */
  meta: {
    /** Who transcribed the lesson: Soniox (the recording), or Zoom's name-labelled captions (English lessons). */
    source: "soniox" | "zoom";
    audioMinutes: number;
    speakerMethod: RoleAssignment["method"];
    shares: Record<SpeakerRole, number>;
    /** zoom_timing only: percent of the transcript's text Zoom's cues labelled (the rest is left out). */
    labelled?: number;
    thaiShare: number;
  };
  /**
   * Too little to write from: the transcriber heard much less audio than the class (a recording that stopped early
   * would be written up as the whole lesson), or the rendered transcript is under the minimum. Checked in this order.
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
  return evidenceFromSegments({
    ...input, source: "soniox", segments: segmentsFromTokens(input.transcript.tokens), text: input.transcript.text,
    tokens: input.transcript.tokens,
  });
}

function evidenceFromSegments(input: {
  source: TranscriptEvidence["meta"]["source"];
  segments: readonly Segment[];
  text: string;
  audioDurationMs: number | null;
  scheduledMinutes: number;
  zoomCues: readonly ZoomCue[];
  teacherName: string | null;
  alsoTeacher: readonly string[];
  studentNames?: readonly string[];
  /** Soniox's tokens: when its speakers are unclear, Zoom's timing may still label the phrases (`labelByZoomTiming`). */
  tokens?: readonly SonioxToken[];
}): TranscriptEvidence {
  let segments = input.segments;
  let speakers = assignSpeakerRoles({
    segments, zoomCues: input.zoomCues, teacherName: input.teacherName, alsoTeacher: input.alsoTeacher,
    studentNames: input.studentNames,
  });
  if (speakers.method === "unclear" && input.tokens) {
    const timed = labelByZoomTiming({
      tokens: input.tokens, zoomCues: input.zoomCues, teacherName: input.teacherName, alsoTeacher: input.alsoTeacher,
      studentNames: input.studentNames,
    });
    if (timed) ({ segments, speakers } = timed);
  }
  const rendered = renderTranscript(segments, speakers.roles);
  const audioDurationMs = input.audioDurationMs ?? 0;
  const tooShort = input.audioDurationMs !== null && recordingTooShort(input.audioDurationMs / 1000, input.scheduledMinutes)
    ? "recording_too_short" as const
    : rendered.length < AUTOWRITER_MIN_TRANSCRIPT_CHARACTERS ? "transcript_too_short" as const : null;
  return {
    rendered,
    speakers,
    // Only a per-speaker alignment is "verified"; phrase-by-phrase timing stays "inferred" (see `labelByZoomTiming`).
    speakerLabels: speakers.method === "zoom_alignment" ? "verified" : "inferred",
    meta: {
      source: input.source,
      audioMinutes: Math.round(audioDurationMs / 600) / 100,
      speakerMethod: speakers.method,
      shares: speakers.shares,
      ...(speakers.labelled !== undefined ? { labelled: speakers.labelled } : {}),
      thaiShare: Math.round(thaiShare(input.text) * 100) / 100,
    },
    tooShort,
  };
}

/**
 * Owner decision, 13 Oct 2026: a class Wise shows under the attendance bar (often a student on another device or link,
 * so their Wise account reads 0%) is written only when its transcript shows the student clearly speaking. Both:
 * - per-speaker labels Zoom confirmed (`zoom_alignment`: a second named person's cues cover the STUDENT voice, which
 *   carries ≥ 5% of the talk). Talk share and phrase timing are inferred, never enough here;
 * - the STUDENT lines hold at least `AUTOWRITER_MIN_TRANSCRIPT_CHARACTERS` (800) characters: the floor a whole
 *   transcript needs to be written from, met by the student alone. All 17 aligned classes in the 12 Oct zoom-timing
 *   set clear it (lowest 1,169, median ~4,200); a tutor talking to an empty room cannot.
 */
export function studentClearlyHeard(evidence: Pick<TranscriptEvidence, "rendered" | "speakers">): boolean {
  if (evidence.speakers.method !== "zoom_alignment") return false;
  const prefix = /^\[[^\]]*\] STUDENT: /u;
  const characters = evidence.rendered.split("\n").filter((line) => prefix.test(line))
    .reduce((sum, line) => sum + [...line.replace(prefix, "")].length, 0);
  return characters >= AUTOWRITER_MIN_TRANSCRIPT_CHARACTERS;
}

// ---------------------------------------------------------------------------
// English lessons from Zoom's captions (FEEDBACK_AUTOWRITER_ZOOM_ENGLISH)
// ---------------------------------------------------------------------------

/**
 * Why an English-lesson candidate still goes to Soniox. Zoom captions a lesson in one language (86 cached classes
 * with captions: their Thai share is 0.00 or ≥ 0.99, never between), so the captions only say which language
 * dominated; a Thai minority in an English-captioned lesson is invisible in them and is caught by the class's own
 * recent Soniox transcripts instead (`class_thai`, `no_class_history`).
 */
export type ZoomEnglishDecline =
  | "summary_thai" | "no_class_history" | "class_thai"
  | "zoom_thai" | "speakers_unclear" | "unnamed_speaker" | "zoom_captions_partial" | "recording_too_short" | "transcript_too_short";

/**
 * Before Zoom's captions are read (nothing to wait for when this already says no): Wise's summary is not Thai, and
 * the class (`wise_class_id`, the same tutor and student) has a recent Soniox transcript and all of them are
 * English. A missing summary does not count against the class: it is built from the same captions.
 */
export function zoomEnglishPrecheck(input: { summaryText: string | null; classThaiShares: readonly number[] }): ZoomEnglishDecline | null {
  if (input.summaryText && thaiShare(input.summaryText) >= AUTOWRITER_ZOOM_ENGLISH_MAX_THAI_SHARE) return "summary_thai";
  if (input.classThaiShares.length === 0) return "no_class_history";
  if (input.classThaiShares.some((share) => !(share < AUTOWRITER_ZOOM_ENGLISH_MAX_THAI_SHARE))) return "class_thai";
  return null;
}

/**
 * Zoom's captions as the lesson's transcript: English (`AUTOWRITER_ZOOM_ENGLISH_MAX_THAI_SHARE`), every cue under
 * the tutor's or the student's name — the same names as the Soniox alignment (`alsoTeacher` = the tutor's other names
 * and `selfNames`, `studentNames` = the student's Wise name and guest stand-in); a cue without a name is a speaker
 * nobody can place, and a name on both lists is nobody's — Zoom's labels trusted by the alignment rules
 * (`assignSpeakerRoles`) and, stricter than the Soniox route, the tutor carrying ≥ 50% of the talk: Soniox's
 * route may trust a student who out-talks the tutor because Soniox's own speakers are checked against Zoom's cues,
 * and here Zoom's cues are the speakers, so there is nothing independent to check. Then the coverage checks on what
 * was captioned: the last caption ends at ≥ 90% of Wise's recording (when Wise gives its length) and at ≥ 70% of
 * the class, and the minimum transcript length. Anything else goes to Soniox, never to the summary.
 */
export function zoomEnglishEvidence(input: {
  vtt: string;
  /** Wise's length of the one recording part; null when Wise gave none. */
  recordingSeconds: number | null;
  scheduledMinutes: number;
  teacherName: string | null;
  alsoTeacher: readonly string[];
  studentNames: readonly string[];
}): { ok: true; evidence: TranscriptEvidence } | { ok: false; reason: ZoomEnglishDecline; thaiShare: number } {
  const lines = parseZoomLines(input.vtt);
  const text = lines.map((line) => line.text).join(" ");
  const share = Math.round(thaiShare(text) * 100) / 100;
  if (thaiShare(text) >= AUTOWRITER_ZOOM_ENGLISH_MAX_THAI_SHARE) return { ok: false, reason: "zoom_thai", thaiShare: share };
  const names = (list: readonly (string | null)[]) => new Set(list.filter((name): name is string => Boolean(name?.trim())).map(normalizeName));
  const tutorNames = names([input.teacherName, ...input.alsoTeacher]);
  const studentNames = names(input.studentNames);
  // A name on both lists would be the student in one count and the tutor in the other: trust neither.
  if ([...studentNames].some((name) => tutorNames.has(name))) return { ok: false, reason: "speakers_unclear", thaiShare: share };
  const cues = parseZoomVtt(input.vtt);
  if (cues.length < lines.length || cues.some((cue) => !tutorNames.has(normalizeName(cue.speakerName)) && !studentNames.has(normalizeName(cue.speakerName)))) {
    return { ok: false, reason: "unnamed_speaker", thaiShare: share };
  }
  const segments: Segment[] = [];
  for (const line of lines as Array<{ speakerName: string; startMs: number; endMs: number; text: string }>) {
    const last = segments.at(-1);
    if (last && last.speaker === line.speakerName) {
      last.text += ` ${line.text}`;
      last.endMs = Math.max(last.endMs, line.endMs);
    } else {
      segments.push({ speaker: line.speakerName, startMs: line.startMs, endMs: line.endMs, text: line.text });
    }
  }
  // What was captioned: a recording is at least as long, and captions that stop early would be half the lesson.
  const captionedMs = Math.max(0, ...cues.map((cue) => cue.endMs));
  if ((input.recordingSeconds ?? 0) > 0 && captionedMs < input.recordingSeconds! * 1000 * AUTOWRITER_ZOOM_ENGLISH_MIN_CAPTION_COVERAGE) {
    return { ok: false, reason: "zoom_captions_partial", thaiShare: share };
  }
  const kept = segments.filter((segment) => segment.text.trim() !== "");
  const evidence = evidenceFromSegments({
    source: "zoom",
    segments: kept,
    text,
    audioDurationMs: captionedMs,
    scheduledMinutes: input.scheduledMinutes,
    zoomCues: cues,
    teacherName: input.teacherName,
    alsoTeacher: input.alsoTeacher,
    studentNames: input.studentNames,
  });
  if (evidence.speakers.method !== "zoom_alignment" || roleRatios(kept, evidence.speakers.roles).tutor < ALIGNED_MIN_TUTOR_SHARE) {
    return { ok: false, reason: "speakers_unclear", thaiShare: share };
  }
  if (evidence.tooShort) return { ok: false, reason: evidence.tooShort, thaiShare: share };
  return { ok: true, evidence };
}

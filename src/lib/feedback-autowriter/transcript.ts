import type { SonioxToken } from "./soniox";

/**
 * Turning a Soniox transcript into speaker turns the writer can use. Soniox
 * labels speakers "1", "2", …; who is the tutor comes from Zoom's own transcript
 * (Wise `rawTranscript`, whose cues carry display names) by time overlap, with
 * talk share as the fallback (tutors did 74–93% of the talking in the pilot).
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

function roleShares(segments: readonly Segment[], roles: Map<string, SpeakerRole>): Record<SpeakerRole, number> {
  const chars: Record<SpeakerRole, number> = { tutor: 0, student: 0, other: 0 };
  for (const segment of segments) chars[roles.get(segment.speaker) ?? "other"] += segment.text.length;
  const total = chars.tutor + chars.student + chars.other || 1;
  return {
    tutor: Math.round((chars.tutor / total) * 100),
    student: Math.round((chars.student / total) * 100),
    other: Math.round((chars.other / total) * 100),
  };
}

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

/**
 * Tutor = the Soniox speaker whose talk overlaps most with Zoom cues of the
 * teacher's display name; the other main speaker is the student. Falls back to
 * talk share when there are no usable cues or the alignment is not one-to-one.
 */
export function assignSpeakerRoles(input: {
  segments: readonly Segment[];
  zoomCues: readonly ZoomCue[];
  teacherName: string | null;
}): RoleAssignment {
  const { segments } = input;
  const teacher = input.teacherName ? normalizeName(input.teacherName) : null;
  if (teacher && input.zoomCues.length > 0) {
    const teacherOverlap = new Map<string, number>();
    const otherOverlap = new Map<string, number>();
    for (const segment of segments) {
      for (const cue of input.zoomCues) {
        const overlap = Math.min(segment.endMs, cue.endMs) - Math.max(segment.startMs, cue.startMs);
        if (overlap <= 0) continue;
        const target = normalizeName(cue.speakerName) === teacher ? teacherOverlap : otherOverlap;
        target.set(segment.speaker, (target.get(segment.speaker) ?? 0) + overlap);
      }
    }
    const speakers = [...new Set(segments.map((segment) => segment.speaker))];
    // Diarization can split one person (e.g. their Thai and English turns): every
    // speaker that mostly overlaps the teacher's cues is the tutor.
    const tutorLike = new Set(speakers.filter((speaker) => (teacherOverlap.get(speaker) ?? 0) > (otherOverlap.get(speaker) ?? 0)));
    const studentLike = new Set(speakers.filter((speaker) => (otherOverlap.get(speaker) ?? 0) > (teacherOverlap.get(speaker) ?? 0)));
    if (tutorLike.size >= 1 && studentLike.size >= 1) {
      const roles = new Map<string, SpeakerRole>(speakers.map((speaker): [string, SpeakerRole] =>
        [speaker, tutorLike.has(speaker) ? "tutor" : studentLike.has(speaker) ? "student" : "other"]));
      return { roles, method: "zoom_alignment", shares: roleShares(segments, roles) };
    }
  }
  const { roles, clear } = byTalkShare(segments);
  return { roles, method: clear ? "talk_share" : "unclear", shares: roleShares(segments, roles) };
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

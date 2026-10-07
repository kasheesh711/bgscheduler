import { describe, expect, it } from "vitest";
import { SONIOX_TERMS, describeClass } from "../prompt";
import {
  assignSpeakerRoles,
  buildTranscriptEvidence,
  parseZoomVtt,
  renderTranscript,
  segmentsFromTokens,
  sonioxJobInput,
  thaiShare,
  type Segment,
} from "../transcript";
import { SESSION_ID, STUDENT_NAME } from "./fixtures";

const tokens = [
  { text: "Let's", start_ms: 0, end_ms: 400, speaker: "1" },
  { text: " start", start_ms: 400, end_ms: 800, speaker: "1" },
  { text: "Okay", start_ms: 900, end_ms: 1_200, speaker: "2" },
  { text: " ครับ", start_ms: 1_200, end_ms: 1_500, speaker: "2" },
  { text: "Question one", start_ms: 1_600, end_ms: 3_000, speaker: "1" },
];

const VTT = `WEBVTT

1
00:00:00.000 --> 00:00:00.800
Apivit (Ek) Sirithana Online: Let's start

2
00:00:00.900 --> 00:00:01.500
Anucha (Nont.Bo) Boonmee: Okay

3
00:01.600 --> 00:03.000
Apivit (Ek) Sirithana Online: Question one
`;

describe("transcript segments", () => {
  it("merges consecutive tokens of one speaker into a turn", () => {
    expect(segmentsFromTokens(tokens)).toEqual([
      { speaker: "1", startMs: 0, endMs: 800, text: "Let's start" },
      { speaker: "2", startMs: 900, endMs: 1_500, text: "Okay ครับ" },
      { speaker: "1", startMs: 1_600, endMs: 3_000, text: "Question one" },
    ]);
  });

  it("parses Zoom WEBVTT cues with and without hours", () => {
    expect(parseZoomVtt(VTT)).toEqual([
      { speakerName: "Apivit (Ek) Sirithana Online", startMs: 0, endMs: 800 },
      { speakerName: "Anucha (Nont.Bo) Boonmee", startMs: 900, endMs: 1_500 },
      { speakerName: "Apivit (Ek) Sirithana Online", startMs: 1_600, endMs: 3_000 },
    ]);
  });
});

describe("assignSpeakerRoles", () => {
  it("names the tutor from Zoom's cues by time overlap", () => {
    // 55 / 45: too close for talk share alone, but Zoom's cues say who is who.
    const segments: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 800, text: "t".repeat(55) },
      { speaker: "2", startMs: 900, endMs: 1_500, text: "s".repeat(45) },
    ];
    expect(assignSpeakerRoles({ segments, zoomCues: [], teacherName: null }).method).toBe("unclear");
    const result = assignSpeakerRoles({ segments, zoomCues: parseZoomVtt(VTT), teacherName: "Apivit (Ek) Sirithana Online" });
    expect(result.method).toBe("zoom_alignment");
    expect(result.roles.get("1")).toBe("tutor");
    expect(result.roles.get("2")).toBe("student");
    expect(result.shares).toEqual({ tutor: 55, student: 45, other: 0 });
  });

  it("counts Zoom lines under the tutor's other names (a second device) as the tutor's", () => {
    const vtt = `${VTT}
4
00:00:04.000 --> 00:00:06.000
Ek: Can you hear me on the tablet?
`;
    const segments: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 800, text: "t".repeat(60) },
      { speaker: "2", startMs: 900, endMs: 1_500, text: "s".repeat(25) },
      // The tutor's tablet, picked up as a third voice.
      { speaker: "3", startMs: 4_000, endMs: 6_000, text: "e".repeat(15) },
    ];
    const cues = parseZoomVtt(vtt);
    const without = assignSpeakerRoles({ segments, zoomCues: cues, teacherName: "Apivit (Ek) Sirithana Online" });
    expect(without.roles.get("3")).toBe("student");
    const withNames = assignSpeakerRoles({ segments, zoomCues: cues, teacherName: "Apivit (Ek) Sirithana Online", alsoTeacher: ["Ek", "Apivit Sirithana"] });
    expect(withNames.method).toBe("zoom_alignment");
    expect([...withNames.roles.entries()]).toEqual([["1", "tutor"], ["2", "student"], ["3", "tutor"]]);
  });

  it("does not trust an alignment that does not look like a one-to-one lesson", () => {
    // The "tutor" barely speaks: a mislabelled rejoin, or cues out of step with the audio.
    const quietTutor: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 800, text: "Let's start" },
      { speaker: "2", startMs: 900, endMs: 1_500, text: "Okay, I tried all of them and got most right I think" },
    ];
    expect(assignSpeakerRoles({ segments: quietTutor, zoomCues: parseZoomVtt(VTT), teacherName: "Apivit (Ek) Sirithana Online" }).method)
      .toBe("unclear");
    // The "student" is a cough.
    const silentStudent: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 800, text: "t".repeat(400) },
      { speaker: "2", startMs: 900, endMs: 1_500, text: "hm" },
    ];
    expect(assignSpeakerRoles({ segments: silentStudent, zoomCues: parseZoomVtt(VTT), teacherName: "Apivit (Ek) Sirithana Online" }).method)
      .toBe("unclear");
  });

  it("compares exact shares at the 50% / 5% limits, not rounded percentages", () => {
    const cues = parseZoomVtt(VTT);
    const aligned = (tutorChars: number, studentChars: number) => assignSpeakerRoles({
      segments: [
        { speaker: "1", startMs: 0, endMs: 800, text: "t".repeat(tutorChars) },
        { speaker: "2", startMs: 900, endMs: 1_500, text: "s".repeat(studentChars) },
      ],
      zoomCues: cues,
      teacherName: "Apivit (Ek) Sirithana Online",
    }).method;
    expect(aligned(50, 50)).toBe("zoom_alignment"); // tutor exactly 50%
    expect(aligned(99, 101)).toBe("unclear"); // 49.5% would round to 50
    expect(aligned(95, 5)).toBe("zoom_alignment"); // student exactly 5%
    expect(aligned(191, 9)).toBe("unclear"); // 4.5% would round to 5
  });

  it("trusts a student who out-talks the tutor only when Zoom names just the two of them and the split is clean", () => {
    const TEACHER = "Apivit (Ek) Sirithana Online";
    const STUDENT = "Anucha (Nont.Bo) Boonmee";
    const cues = parseZoomVtt(VTT);
    // The student reads answers aloud: 70% of the talk, each Soniox speaker on one side of Zoom's cues.
    const chatty: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 800, text: "t".repeat(30) },
      { speaker: "2", startMs: 900, endMs: 1_500, text: "s".repeat(70) },
    ];
    expect(assignSpeakerRoles({ segments: chatty, zoomCues: cues, teacherName: TEACHER }).method).toBe("unclear");
    const named = assignSpeakerRoles({ segments: chatty, zoomCues: cues, teacherName: TEACHER, studentNames: [STUDENT] });
    expect(named.method).toBe("zoom_alignment");
    expect(named.roles.get("1")).toBe("tutor");
    expect(named.shares).toEqual({ tutor: 30, student: 70, other: 0 });
    // The tutor must still carry 20%.
    const quiet: Segment[] = [chatty[0], { ...chatty[1], text: "s".repeat(121) }];
    expect(assignSpeakerRoles({ segments: quiet, zoomCues: cues, teacherName: TEACHER, studentNames: [STUDENT] }).method).toBe("unclear");
    // A third name in Zoom's cues (a rejoin under another name, a parent) keeps the strict rule.
    const third = [...cues, { speakerName: "Ek iPad", startMs: 3_100, endMs: 3_200 }];
    expect(assignSpeakerRoles({ segments: chatty, zoomCues: third, teacherName: TEACHER, studentNames: [STUDENT] }).method).toBe("unclear");
    // Zoom never names the student: nothing confirms who the other speaker is.
    const teacherOnly = cues.filter((cue) => cue.speakerName === TEACHER);
    expect(assignSpeakerRoles({ segments: chatty, zoomCues: [...teacherOnly, { speakerName: "Someone", startMs: 900, endMs: 1_500 }], teacherName: TEACHER, studentNames: [STUDENT] }).method)
      .toBe("unclear");
    // A guest name the student joined under counts as the student's.
    const guestCues = cues.map((cue) => cue.speakerName === STUDENT ? { ...cue, speakerName: "Nont iPhone" } : cue);
    expect(assignSpeakerRoles({ segments: chatty, zoomCues: guestCues, teacherName: TEACHER, studentNames: [STUDENT, "Nont iPhone"] }).method)
      .toBe("zoom_alignment");
  });

  it("does not let many small straddling speakers skip the purity check", () => {
    const TEACHER = "Apivit (Ek) Sirithana Online";
    const STUDENT = "Anucha (Nont.Bo) Boonmee";
    const cues = [
      { speakerName: TEACHER, startMs: 0, endMs: 1_000 },
      { speakerName: STUDENT, startMs: 1_000, endMs: 10_000 },
    ];
    // Speaker "t" is the tutor; 4 small speakers (4.5% each, 18% together) straddle both sides.
    const small = [0, 1, 2, 3].map((i): Segment => ({ speaker: `m${i}`, startMs: 400, endMs: 1_400, text: "x".repeat(45) }));
    const segments: Segment[] = [
      { speaker: "t", startMs: 0, endMs: 900, text: "t".repeat(250) },
      { speaker: "s", startMs: 2_000, endMs: 9_000, text: "s".repeat(570) },
      ...small,
    ];
    expect(assignSpeakerRoles({ segments, zoomCues: cues, teacherName: TEACHER, studentNames: [STUDENT] }).method).toBe("unclear");
    // A name on both lists is never trusted on the relaxed path.
    const chatty: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 800, text: "t".repeat(30) },
      { speaker: "2", startMs: 900, endMs: 1_500, text: "s".repeat(70) },
    ];
    expect(assignSpeakerRoles({ segments: chatty, zoomCues: parseZoomVtt(VTT), teacherName: TEACHER, studentNames: [STUDENT, TEACHER] }).method)
      .toBe("unclear");
  });

  it("passes the student's names through buildTranscriptEvidence", () => {
    const transcript = {
      text: "",
      tokens: [
        { text: "t".repeat(30), start_ms: 0, end_ms: 800, speaker: "1" },
        { text: "s".repeat(70), start_ms: 900, end_ms: 1_500, speaker: "2" },
      ],
    };
    const base = { transcript, audioDurationMs: null, scheduledMinutes: 60, zoomCues: parseZoomVtt(VTT), teacherName: "Apivit (Ek) Sirithana Online", alsoTeacher: [] };
    expect(buildTranscriptEvidence(base).speakers.method).toBe("unclear");
    expect(buildTranscriptEvidence({ ...base, studentNames: ["Anucha (Nont.Bo) Boonmee"] }).speakers.method).toBe("zoom_alignment");
  });

  it("does not trust a Soniox speaker that straddles both people (diarization merged them)", () => {
    const TEACHER = "Apivit (Ek) Sirithana Online";
    const STUDENT = "Anucha (Nont.Bo) Boonmee";
    const cues = [
      { speakerName: TEACHER, startMs: 0, endMs: 1_000 },
      { speakerName: STUDENT, startMs: 1_000, endMs: 3_000 },
      { speakerName: TEACHER, startMs: 3_000, endMs: 4_000 },
    ];
    const run = (firstStartMs: number) => assignSpeakerRoles({
      segments: [
        { speaker: "1", startMs: firstStartMs, endMs: 3_000, text: "s".repeat(60) },
        { speaker: "2", startMs: 3_000, endMs: 4_000, text: "t".repeat(40) },
      ],
      zoomCues: cues, teacherName: TEACHER, studentNames: [STUDENT],
    }).method;
    expect(run(0)).toBe("unclear"); // speaker 1 also covers the tutor's first cue: only 2/3 of it is the student's
    expect(run(1_000)).toBe("zoom_alignment"); // speaker 1 on the student's cue alone
  });

  it("calls a talk-share split that contradicts Zoom's cues unclear", () => {
    const teacherOnly = parseZoomVtt(VTT).filter((cue) => cue.speakerName.startsWith("Apivit"));
    // Zoom places speaker 1 on the teacher's lines, but speaker 2 talks most.
    const contradicting: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 800, text: "t".repeat(30) },
      { speaker: "2", startMs: 5_000, endMs: 9_000, text: "s".repeat(100) },
    ];
    expect(assignSpeakerRoles({ segments: contradicting, zoomCues: teacherOnly, teacherName: "Apivit (Ek) Sirithana Online" }).method)
      .toBe("unclear");
    const agreeing: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 800, text: "t".repeat(100) },
      { speaker: "2", startMs: 5_000, endMs: 9_000, text: "s".repeat(30) },
    ];
    const result = assignSpeakerRoles({ segments: agreeing, zoomCues: teacherOnly, teacherName: "Apivit (Ek) Sirithana Online" });
    expect(result.method).toBe("talk_share");
    expect(result.roles.get("1")).toBe("tutor");
  });

  it("labels every speaker that overlaps the teacher's cues as the tutor (diarization split)", () => {
    const segments: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 800, text: "Let's start" },
      { speaker: "2", startMs: 900, endMs: 1_500, text: "Okay" },
      { speaker: "3", startMs: 1_600, endMs: 3_000, text: "Question one, the common denominator is twelve" },
    ];
    const result = assignSpeakerRoles({ segments, zoomCues: parseZoomVtt(VTT), teacherName: "Apivit (Ek) Sirithana Online" });
    expect(result.method).toBe("zoom_alignment");
    expect([...result.roles.entries()]).toEqual([["1", "tutor"], ["2", "student"], ["3", "tutor"]]);
  });

  it("calls the split unclear when talk share cannot name the tutor", () => {
    const even: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 1, text: "a".repeat(50) },
      { speaker: "2", startMs: 2, endMs: 3, text: "b".repeat(45) },
    ];
    expect(assignSpeakerRoles({ segments: even, zoomCues: [], teacherName: null }).method).toBe("unclear");
    const three: Segment[] = [...even, { speaker: "3", startMs: 4, endMs: 5, text: "c".repeat(30) }];
    expect(assignSpeakerRoles({ segments: three, zoomCues: [], teacherName: null }).method).toBe("unclear");
  });

  it("falls back to talk share without cues or when the alignment is not one-to-one", () => {
    const segments = segmentsFromTokens(tokens);
    const noCues = assignSpeakerRoles({ segments, zoomCues: [], teacherName: "Apivit (Ek) Sirithana Online" });
    expect(noCues).toMatchObject({ method: "talk_share" }); // 23 vs 9 characters: a clear split
    expect(noCues.roles.get("1")).toBe("tutor");
    const unknownTeacher = assignSpeakerRoles({ segments, zoomCues: parseZoomVtt(VTT), teacherName: "Someone Else" });
    expect(unknownTeacher.method).toBe("talk_share");
    // A one-character stray speaker is noise, not a third participant.
    const extra = assignSpeakerRoles({ segments: [...segments, { speaker: "3", startMs: 5_000, endMs: 5_100, text: "h" }], zoomCues: [], teacherName: null });
    expect(extra.method).toBe("talk_share");
    expect(extra.roles.get("3")).toBe("other");
  });
});

describe("renderTranscript", () => {
  it("labels turns TUTOR / STUDENT with mm:ss and truncates long transcripts", () => {
    const segments = segmentsFromTokens(tokens);
    const roles = new Map([["1", "tutor" as const], ["2", "student" as const]]);
    expect(renderTranscript(segments, roles)).toBe("[00:00] TUTOR: Let's start\n[00:00] STUDENT: Okay ครับ\n[00:01] TUTOR: Question one");
    const long = Array.from({ length: 50 }, (_, index): Segment => ({ speaker: index % 2 ? "2" : "1", startMs: index * 60_000, endMs: index * 60_000 + 1, text: `turn ${index}` }));
    const cut = renderTranscript(long, roles, 400);
    expect(cut).toContain("[00:00] TUTOR: turn 0");
    expect(cut).toContain("[… middle of the lesson omitted …]");
    expect(cut).toContain("[49:00] STUDENT: turn 49"); // homework is usually set at the end
    expect(cut.length).toBeLessThanOrEqual(400);
  });
});

describe("thaiShare", () => {
  it("measures Thai against Thai + Latin letters", () => {
    expect(thaiShare("สวัสดีครับ")).toBe(1);
    expect(thaiShare("Hello")).toBe(0);
    expect(thaiShare("ab สว")).toBe(0.5);
    expect(thaiShare("123 !")).toBe(0);
  });
});

/** A long, clearly one-to-one lesson (the tutor explains, the student answers): enough to write from. */
function lessonTokens(minutes = 12) {
  const out: Array<{ text: string; start_ms: number; end_ms: number; speaker: string }> = [];
  for (let i = 0; i < minutes; i += 1) {
    const at = i * 60_000;
    out.push({ text: " Today we add fractions with unlike denominators and simplify the answer, step by step.", start_ms: at, end_ms: at + 25_000, speaker: "1" });
    out.push({ text: " I got three quarters because I found the common denominator first.", start_ms: at + 31_000, end_ms: at + 55_000, speaker: "2" });
  }
  return out;
}

const LESSON_VTT = `WEBVTT

1
00:00:00.000 --> 00:00:25.000
Kevin (Kev) Y. Hsieh Online: Today we add fractions

2
00:00:31.000 --> 00:00:55.000
${STUDENT_NAME}: I got three quarters
`;

describe("buildTranscriptEvidence (shared by the second pass and the replay)", () => {
  const base = {
    scheduledMinutes: 60,
    teacherName: "Kevin (Kev) Y. Hsieh Online",
    alsoTeacher: ["Kevin Hsieh", "Kev"],
  };
  const transcript = (tokens = lessonTokens()) => ({ text: tokens.map((token) => token.text).join(""), tokens });

  it("renders TUTOR/STUDENT turns with Zoom-confirmed labels and the stored metadata", () => {
    const evidence = buildTranscriptEvidence({ ...base, transcript: transcript(), audioDurationMs: 3_600_000, zoomCues: parseZoomVtt(LESSON_VTT) });
    expect(evidence.tooShort).toBeNull();
    expect(evidence.speakerLabels).toBe("verified");
    expect(evidence.speakers.method).toBe("zoom_alignment");
    expect(evidence.rendered).toContain("[00:00] TUTOR: Today we add fractions");
    expect(evidence.rendered).toContain("[00:31] STUDENT: I got three quarters");
    expect(evidence.meta).toEqual({ audioMinutes: 60, speakerMethod: "zoom_alignment", shares: { tutor: 57, student: 43, other: 0 }, thaiShare: 0 });
  });

  it("says the labels are inferred when only the talk share names the tutor, and leaves an unclear split to the caller", () => {
    const tutorLed = lessonTokens().map((token) => token.speaker === "2" ? { ...token, text: " Three quarters." } : token);
    const inferred = buildTranscriptEvidence({ ...base, transcript: transcript(tutorLed), audioDurationMs: 3_600_000, zoomCues: [] });
    expect(inferred).toMatchObject({ speakerLabels: "inferred", tooShort: null, meta: { speakerMethod: "talk_share" } });
    const even = lessonTokens().map((token, index) => ({ ...token, speaker: String((index % 3) + 1) }));
    const unclear = buildTranscriptEvidence({ ...base, transcript: transcript(even), audioDurationMs: 3_600_000, zoomCues: [] });
    expect(unclear).toMatchObject({ speakerLabels: "inferred", tooShort: null, speakers: { method: "unclear" } });
  });

  it("flags a recording much shorter than the class before a short transcript, and trusts no length it was not given", () => {
    const short = buildTranscriptEvidence({ ...base, transcript: transcript(lessonTokens(1)), audioDurationMs: 20 * 60_000, zoomCues: [] });
    expect(short.tooShort).toBe("recording_too_short");
    expect(short.meta.audioMinutes).toBe(20);
    const thin = buildTranscriptEvidence({ ...base, transcript: transcript(lessonTokens(1)), audioDurationMs: 3_600_000, zoomCues: [] });
    expect(thin.tooShort).toBe("transcript_too_short");
    const unknownLength = buildTranscriptEvidence({ ...base, transcript: transcript(), audioDurationMs: null, zoomCues: [] });
    expect(unknownLength.tooShort).toBeNull();
    expect(unknownLength.meta.audioMinutes).toBe(0);
  });

  it("measures how Thai the transcript is", () => {
    const thai = lessonTokens().map((token) => token.speaker === "2" ? { ...token, text: " ได้สามส่วนสี่ครับ เพราะหาตัวส่วนร่วมก่อน" } : token);
    expect(buildTranscriptEvidence({ ...base, transcript: transcript(thai), audioDurationMs: 3_600_000, zoomCues: [] }).meta.thaiShare)
      .toBeGreaterThan(0.2);
  });
});

describe("sonioxJobInput (shared by the second pass and the replay)", () => {
  it("sends the recording with our terms, the tutor's and the student's names, and the class details", () => {
    const input = sonioxJobInput({
      wiseSessionId: SESSION_ID,
      audioUrl: "https://files.wiseapp.live/rec.mp4",
      detail: { classSubject: "11+/13+", title: "Live Session - NVR" },
      tutorNames: ["Kevin Hsieh", "Kev"],
      studentName: STUDENT_NAME,
    });
    expect(input).toEqual({
      audioUrl: "https://files.wiseapp.live/rec.mp4",
      terms: [...SONIOX_TERMS, "Kevin Hsieh", "Kev", "Somchai", "Tom"],
      general: [
        { key: "domain", value: "one-to-one online tutoring lesson between a tutor and a student" },
        ...describeClass({ programme: "11+/13+", title: "Live Session - NVR" }).map((line) => ({ key: "class", value: line })),
      ],
      clientReferenceId: SESSION_ID,
    });
  });

  it("leaves out a nickname the student's Wise name does not have", () => {
    const input = sonioxJobInput({
      wiseSessionId: SESSION_ID, audioUrl: "https://files.wiseapp.live/rec.mp4",
      detail: { classSubject: null, title: null }, tutorNames: ["Kevin Hsieh"], studentName: "Somchai Jaidee",
    });
    expect(input.terms).toEqual([...SONIOX_TERMS, "Kevin Hsieh", "Somchai"]);
    expect(input.general).toEqual([{ key: "domain", value: "one-to-one online tutoring lesson between a tutor and a student" }]);
  });
});

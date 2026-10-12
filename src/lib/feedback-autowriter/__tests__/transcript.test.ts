import { describe, expect, it } from "vitest";
import { SONIOX_TERMS, describeClass } from "../prompt";
import {
  assignSpeakerRoles,
  buildTranscriptEvidence,
  labelByZoomTiming,
  parseZoomVtt,
  renderTranscript,
  segmentsFromTokens,
  sonioxJobInput,
  thaiShare,
  zoomEnglishEvidence,
  zoomEnglishPrecheck,
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
    expect(evidence.meta).toEqual({ source: "soniox", audioMinutes: 60, speakerMethod: "zoom_alignment", shares: { tutor: 57, student: 43, other: 0 }, thaiShare: 0 });
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

describe("English lessons from Zoom's captions", () => {
  const TUTOR = "Apivit (Ek) Sirithana Online";
  const STUDENT = "Anucha (Nont.Bo) Boonmee";
  const at = (ms: number) => new Date(ms).toISOString().slice(11, 23);
  /** Zoom's captions of a lesson: the tutor, then the student, every minute for `minutes` minutes. */
  const captions = (options: { minutes?: number; tutor?: string; student?: string; tutorLine?: string; studentLine?: string; extra?: string } = {}) => {
    const cues: string[] = [];
    for (let minute = 0; minute < (options.minutes ?? 50); minute += 1) {
      const start = minute * 60_000;
      cues.push(`${at(start)} --> ${at(start + 25_000)}\n${options.tutor ?? TUTOR}: ${options.tutorLine ?? "Today we add fractions with unlike denominators and simplify."}`);
      cues.push(`${at(start + 31_000)} --> ${at(start + 55_000)}\n${options.student ?? STUDENT}: ${options.studentLine ?? "I got three quarters with the common denominator."}`);
    }
    if (options.extra) cues.push(`${at(3_000_000)} --> ${at(3_010_000)}\n${options.extra}: Hello, can you hear us?`);
    return `WEBVTT\n\n${cues.join("\n\n")}\n`;
  };
  const base = { recordingSeconds: null, scheduledMinutes: 60, teacherName: TUTOR, alsoTeacher: [] as string[], studentNames: [STUDENT] };

  it("checks the summary and the class's recent Soniox transcripts before the captions are read", () => {
    expect(zoomEnglishPrecheck({ summaryText: "Fractions practice.", classThaiShares: [0, 0.02] })).toBeNull();
    // No summary is not a reason: Wise builds it from the same captions.
    expect(zoomEnglishPrecheck({ summaryText: null, classThaiShares: [0] })).toBeNull();
    expect(zoomEnglishPrecheck({ summaryText: "ทบทวนเรื่องเศษส่วน fractions", classThaiShares: [0] })).toBe("summary_thai");
    // A first lesson (or one not sent to Soniox for 30 days) goes to Soniox, which measures its language.
    expect(zoomEnglishPrecheck({ summaryText: "Fractions practice.", classThaiShares: [] })).toBe("no_class_history");
    // One lesson of the class with some Thai in it is enough to keep Soniox.
    expect(zoomEnglishPrecheck({ summaryText: "Fractions practice.", classThaiShares: [0, 0.03] })).toBe("class_thai");
    expect(zoomEnglishPrecheck({ summaryText: "Fractions practice.", classThaiShares: [Number.NaN] })).toBe("class_thai");
  });

  it("writes from English captions naming only the tutor and the student, labels confirmed by name", () => {
    const result = zoomEnglishEvidence({ ...base, vtt: captions() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.speakers.method).toBe("zoom_alignment");
    expect(result.evidence.speakerLabels).toBe("verified");
    expect(result.evidence.tooShort).toBeNull();
    expect(result.evidence.meta).toMatchObject({ source: "zoom", speakerMethod: "zoom_alignment", audioMinutes: 49.92, thaiShare: 0 });
    expect(result.evidence.rendered).toContain("[00:00] TUTOR: Today we add fractions with unlike denominators and simplify.");
    expect(result.evidence.rendered).toContain("[00:31] STUDENT: I got three quarters with the common denominator.");
    expect(result.evidence.rendered).not.toContain(TUTOR);
  });

  it("keeps Soniox for Thai captions, an unknown name, unclear speakers and short evidence", () => {
    const thai = zoomEnglishEvidence({ ...base, vtt: captions({ tutorLine: "วันนี้เราจะบวกเศษส่วน fractions" }) });
    expect(thai).toMatchObject({ ok: false, reason: "zoom_thai" });
    // A parent's device, a second student: not the tutor's or the student's name.
    expect(zoomEnglishEvidence({ ...base, vtt: captions({ extra: "Mom iPad" }) })).toMatchObject({ ok: false, reason: "unnamed_speaker" });
    // A caption Zoom could not put a name to: nobody can say who spoke it.
    const nameless = `${captions()}\n${at(3_000_000)} --> ${at(3_010_000)}\nCan you hear us?\n`;
    expect(zoomEnglishEvidence({ ...base, vtt: nameless })).toMatchObject({ ok: false, reason: "unnamed_speaker" });
    // … and its words still count toward the language.
    const namelessThai = `${captions({ minutes: 1 })}\n${at(70_000)} --> ${at(3_000_000)}\n${"สวัสดีครับ ".repeat(40)}\n`;
    expect(zoomEnglishEvidence({ ...base, vtt: namelessThai })).toMatchObject({ ok: false, reason: "zoom_thai" });
    // Wise gives no teacher name: the tutor's cues cannot be told from anyone's.
    expect(zoomEnglishEvidence({ ...base, teacherName: null, vtt: captions() })).toMatchObject({ ok: false, reason: "unnamed_speaker" });
    // The student is never heard.
    expect(zoomEnglishEvidence({ ...base, vtt: captions({ student: TUTOR }) })).toMatchObject({ ok: false, reason: "speakers_unclear" });
    // The student out-talks the tutor by far: the same rule as the Soniox alignment.
    expect(zoomEnglishEvidence({ ...base, vtt: captions({ tutorLine: "Good.", studentLine: "s".repeat(200) }) }))
      .toMatchObject({ ok: false, reason: "speakers_unclear" });
    // The student out-talks the tutor (40/60) with only the two named: Soniox's route may trust that, checking its own
    // speakers against Zoom's cues; from Zoom's cues alone there is nothing to check, so the tutor needs half.
    const chatty = captions({ tutorLine: "t".repeat(40), studentLine: "s".repeat(60) });
    expect(assignSpeakerRoles({
      segments: parseZoomVtt(chatty).map((cue, index) => ({ speaker: cue.speakerName, startMs: cue.startMs, endMs: cue.endMs, text: index % 2 ? "s".repeat(60) : "t".repeat(40) })),
      zoomCues: parseZoomVtt(chatty), teacherName: TUTOR, studentNames: [STUDENT],
    }).method).toBe("zoom_alignment");
    expect(zoomEnglishEvidence({ ...base, vtt: chatty })).toMatchObject({ ok: false, reason: "speakers_unclear" });
    expect(zoomEnglishEvidence({ ...base, vtt: captions({ tutorLine: "t".repeat(50), studentLine: "s".repeat(50) }) })).toMatchObject({ ok: true });
    // A name on both lists is nobody's.
    expect(zoomEnglishEvidence({ ...base, studentNames: [STUDENT, TUTOR], vtt: captions() })).toMatchObject({ ok: false, reason: "speakers_unclear" });
    expect(zoomEnglishEvidence({ ...base, vtt: "WEBVTT\n" })).toMatchObject({ ok: false, reason: "speakers_unclear" });
    const sparse = `WEBVTT\n\n${at(0)} --> ${at(5_000)}\n${TUTOR}: Hello there, ready?\n\n${at(3_000_000)} --> ${at(3_005_000)}\n${STUDENT}: Bye.\n`;
    expect(zoomEnglishEvidence({ ...base, vtt: sparse })).toMatchObject({ ok: false, reason: "transcript_too_short" });
  });

  it("needs captions running to 70% of the class and to 90% of Wise's recording", () => {
    expect(zoomEnglishEvidence({ ...base, vtt: captions({ minutes: 45 }) })).toMatchObject({ ok: true });
    expect(zoomEnglishEvidence({ ...base, vtt: captions({ minutes: 30 }) })).toMatchObject({ ok: false, reason: "recording_too_short" });
    // Captions to 49:55 of a 50-minute recording; of a 60-minute recording they stop early (83%).
    expect(zoomEnglishEvidence({ ...base, recordingSeconds: 3_000, vtt: captions() })).toMatchObject({ ok: true });
    expect(zoomEnglishEvidence({ ...base, recordingSeconds: 3_600, vtt: captions() })).toMatchObject({ ok: false, reason: "zoom_captions_partial" });
  });

  it("counts the tutor's other names and the student's guest name as theirs", () => {
    expect(zoomEnglishEvidence({ ...base, vtt: captions({ tutor: "Ek", student: "nont iphone" }) })).toMatchObject({ ok: false, reason: "unnamed_speaker" });
    expect(zoomEnglishEvidence({ ...base, alsoTeacher: ["Ek"], studentNames: [STUDENT, "nont iphone"], vtt: captions({ tutor: "Ek", student: "nont iphone" }) }))
      .toMatchObject({ ok: true });
  });
});

describe("Zoom timing: one Soniox voice, labelled phrase by phrase from Zoom's cues (12 Oct 2026)", () => {
  const TUTOR = "Kevin (Kev) Y. Hsieh Online";
  const STUDENT = STUDENT_NAME;
  /**
   * A 12-exchange lesson Soniox heard as ONE speaker ("1"): the tutor asks (4 s), the student answers (2 s), a 1 s
   * gap between turns. Zoom names each turn.
   */
  const lesson = (exchanges = 12) => {
    const tokens: Array<{ text: string; start_ms: number; end_ms: number; speaker: string }> = [];
    const cues: Array<{ speakerName: string; startMs: number; endMs: number }> = [];
    for (let i = 0; i < exchanges; i += 1) {
      const t = i * 8_000;
      tokens.push({ text: `Tutor question number ${i} about fractions and how to add them carefully today.`, start_ms: t, end_ms: t + 4_000, speaker: "1" });
      tokens.push({ text: `Answer ${i} is three quarters.`, start_ms: t + 5_000, end_ms: t + 7_000, speaker: "1" });
      cues.push({ speakerName: TUTOR, startMs: t, endMs: t + 4_000 }, { speakerName: STUDENT, startMs: t + 5_000, endMs: t + 7_000 });
    }
    return { tokens, cues };
  };
  const input = (tokens: ReturnType<typeof lesson>["tokens"], cues: ReturnType<typeof lesson>["cues"]) =>
    ({ tokens, zoomCues: cues, teacherName: TUTOR, alsoTeacher: ["Kevin Hsieh"], studentNames: [STUDENT] });

  it("labels each phrase by whose Zoom cue it falls in, where per-speaker alignment can only say unclear", () => {
    const { tokens, cues } = lesson();
    const evidence = buildTranscriptEvidence({
      transcript: { text: tokens.map((t) => t.text).join(""), tokens }, audioDurationMs: 96_000, scheduledMinutes: 1,
      zoomCues: cues, teacherName: TUTOR, alsoTeacher: ["Kevin Hsieh"], studentNames: [STUDENT],
    });
    expect(evidence.speakers.method).toBe("zoom_timing");
    // Only a per-speaker alignment is verified: the writer and the judges treat these labels with care.
    expect(evidence.speakerLabels).toBe("inferred");
    expect(evidence.meta).toMatchObject({ speakerMethod: "zoom_timing", labelled: 100 });
    expect(evidence.rendered).toContain("[00:00] TUTOR: Tutor question number 0");
    expect(evidence.rendered).toContain("[00:05] STUDENT: Answer 0 is three quarters.");
    expect(evidence.rendered).not.toContain("OTHER");
    // Without the student's names Zoom's second voice cannot be named: unclear, as before.
    const unnamed = buildTranscriptEvidence({
      transcript: { text: "", tokens }, audioDurationMs: 96_000, scheduledMinutes: 1, zoomCues: cues, teacherName: TUTOR, alsoTeacher: [],
    });
    expect(unnamed.speakers.method).toBe("unclear");
  });

  it("never guesses a phrase no cue overlaps: it is left out, and a stretch of 3 s or more shows as a marker", () => {
    const { tokens, cues } = lesson();
    // 300 ms after the student's cue ends (no overlap): left out, not handed to the nearest speaker.
    tokens.push({ text: "Yes.", start_ms: 7_300, end_ms: 7_400, speaker: "1" });
    tokens.push({ text: "Unheard words for a while.", start_ms: 200_000, end_ms: 205_000, speaker: "1" });
    const timed = labelByZoomTiming(input(tokens.toSorted((a, b) => a.start_ms - b.start_ms), cues.concat({ speakerName: TUTOR, startMs: 206_000, endMs: 207_000 })));
    expect(timed?.segments.some((s) => s.text.includes("Yes."))).toBe(false);
    expect(timed?.segments.some((s) => s.text.includes("Unheard"))).toBe(false);
    expect(timed?.segments.filter((s) => s.speaker === "left_out").map((s) => s.text)).toEqual(["[… 5 s not attributable to either speaker, left out …]"]);
    expect(renderTranscript(timed!.segments, timed!.speakers.roles)).toContain("[03:20] [… 5 s not attributable to either speaker, left out …]");
  });

  it("splits Thai speech without punctuation at pauses, so each turn takes its own speaker", () => {
    const tokens: Array<{ text: string; start_ms: number; end_ms: number; speaker: string }> = [];
    const cues: Array<{ speakerName: string; startMs: number; endMs: number }> = [];
    for (let i = 0; i < 12; i += 1) {
      const t = i * 8_000;
      // Several tokens per turn, no sentence punctuation; a 600 ms pause between turns.
      for (const [k, word] of ["ครู", "อธิบาย", "เรื่อง", "เศษส่วน", "นะครับ"].entries()) tokens.push({ text: word, start_ms: t + k * 700, end_ms: t + k * 700 + 600, speaker: "1" });
      for (const [k, word] of ["ผม", "ได้", "สามส่วนสี่"].entries()) tokens.push({ text: word, start_ms: t + 4_200 + k * 300, end_ms: t + 4_200 + k * 300 + 250, speaker: "1" });
      cues.push({ speakerName: TUTOR, startMs: t, endMs: t + 3_600 }, { speakerName: STUDENT, startMs: t + 4_200, endMs: t + 5_100 });
    }
    const timed = labelByZoomTiming(input(tokens, cues));
    expect(timed?.segments.slice(0, 2).map((s) => [s.speaker, s.text])).toEqual([["tutor", "ครูอธิบายเรื่องเศษส่วนนะครับ"], ["student", "ผมได้สามส่วนสี่"]]);
  });

  it("leaves a phrase out when the cues it overlaps disagree (no 60% majority)", () => {
    const tokens = [{ text: "Overlapping talk here.", start_ms: 0, end_ms: 2_000, speaker: "1" }];
    const cues = [{ speakerName: TUTOR, startMs: 0, endMs: 1_000 }, { speakerName: STUDENT, startMs: 1_000, endMs: 2_000 }];
    const many = lesson();
    const timed = labelByZoomTiming(input([...tokens, ...many.tokens.map((t) => ({ ...t, start_ms: t.start_ms + 10_000, end_ms: t.end_ms + 10_000 }))],
      [...cues, ...many.cues.map((c) => ({ ...c, startMs: c.startMs + 10_000, endMs: c.endMs + 10_000 }))]));
    expect(timed?.segments.some((s) => s.text.includes("Overlapping"))).toBe(false);
  });

  it("declines (stays unclear) when Zoom names a third person, the student is barely heard, captions stop early, coverage is low or the tutor is under half", () => {
    const { tokens, cues } = lesson();
    expect(labelByZoomTiming(input(tokens, [...cues, { speakerName: "Somebody Else", startMs: 100_000, endMs: 101_000 }]))).toBeNull();
    // Nine student cues: Zoom did not hear the student enough.
    const nine = lesson(9);
    expect(labelByZoomTiming(input(nine.tokens, nine.cues))).toBeNull();
    // Captions stop after 80% of the speech: the end of the lesson (homework) would vanish.
    const late = { text: "And for homework do page ten.", start_ms: 118_000, end_ms: 120_000, speaker: "1" };
    expect(labelByZoomTiming(input([...tokens, late], cues))).toBeNull();
    // Every third tutor question has no cue at all: 1 - 4×78/1296 ≈ 76% labelled, under 85%.
    const sparse = cues.filter((cue, index) => !(cue.speakerName === TUTOR && index % 6 === 0));
    expect(labelByZoomTiming(input(tokens, sparse))).toBeNull();
    // The same with every question captioned passes: the coverage check is what refused it.
    expect(labelByZoomTiming(input(tokens, cues))?.speakers.labelled).toBe(100);
    // The student talks more than the tutor: only Zoom vouches for the labels, so the tutor must carry half.
    const chatty = tokens.map((t, i) => i % 2 === 1 ? { ...t, text: t.text.repeat(4) } : t);
    expect(labelByZoomTiming(input(chatty, cues))).toBeNull();
  });

  it("never replaces a clean per-speaker alignment", () => {
    const { tokens, cues } = lesson();
    const twoVoices = tokens.map((t, i) => ({ ...t, speaker: i % 2 === 0 ? "1" : "2" }));
    const evidence = buildTranscriptEvidence({
      transcript: { text: "", tokens: twoVoices }, audioDurationMs: 96_000, scheduledMinutes: 1,
      zoomCues: cues, teacherName: TUTOR, alsoTeacher: [], studentNames: [STUDENT],
    });
    expect(evidence.speakers.method).toBe("zoom_alignment");
    expect(evidence.meta).not.toHaveProperty("labelled");
  });
});


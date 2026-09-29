import { describe, expect, it } from "vitest";
import {
  assignSpeakerRoles,
  parseZoomVtt,
  renderTranscript,
  segmentsFromTokens,
  thaiShare,
  type Segment,
} from "../transcript";

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
Silpakorn (Gino.Ti) Tiyachate: Okay

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
      { speakerName: "Silpakorn (Gino.Ti) Tiyachate", startMs: 900, endMs: 1_500 },
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

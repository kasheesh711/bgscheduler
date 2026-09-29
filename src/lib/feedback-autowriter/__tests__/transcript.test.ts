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
    // Speaker "2" talks more here, so talk share alone would get it wrong.
    const segments: Segment[] = [
      { speaker: "1", startMs: 0, endMs: 800, text: "Let's start" },
      { speaker: "2", startMs: 900, endMs: 1_500, text: "Okay, I tried all of them and got most right I think" },
    ];
    const result = assignSpeakerRoles({ segments, zoomCues: parseZoomVtt(VTT), teacherName: "Apivit (Ek) Sirithana Online" });
    expect(result.method).toBe("zoom_alignment");
    expect(result.roles.get("1")).toBe("tutor");
    expect(result.roles.get("2")).toBe("student");
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

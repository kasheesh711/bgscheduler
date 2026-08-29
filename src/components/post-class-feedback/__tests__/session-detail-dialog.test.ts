import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  FeedbackSessionDetailVersion,
  FeedbackSourceAnswer,
  FeedbackSubmissionEvent,
} from "@/types/post-class-feedback";
import { buildTimingEvidenceEntries, exactWiseAnswerText } from "../session-detail-dialog";

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("post-class feedback session detail", () => {
  it("preserves exact Wise text, including leading whitespace and newlines", () => {
    const answer: FeedbackSourceAnswer = {
      id: "answer-1",
      questionId: "question-1",
      questionText: "Topics covered",
      type: "text",
      text: "normalized fallback",
      rawAnswer: "  Fractions\nand ratios  ",
    };
    expect(exactWiseAnswerText(answer)).toBe("  Fractions\nand ratios  ");
  });

  it("renders lossless non-text Wise answers instead of inventing text", () => {
    const answer: FeedbackSourceAnswer = {
      id: null,
      questionId: "rating",
      questionText: "Rating",
      type: "rating",
      text: "",
      rawAnswer: { value: 4, scale: 5 },
    };
    expect(exactWiseAnswerText(answer)).toBe('{\n  "value": 4,\n  "scale": 5\n}');
  });

  it("loads authenticated detail on demand and keeps raw history out of the dashboard serializer", () => {
    const operations = source("src/components/post-class-feedback/operations-tab.tsx");
    const dialog = source("src/components/post-class-feedback/session-detail-dialog.tsx");
    const dashboard = source("src/lib/post-class-feedback/dashboard.ts");

    expect(operations).toContain("Select a row to load exact Wise evidence");
    expect(dialog).toContain("/api/post-class-feedback/sessions/${encodeURIComponent(session.id)}");
    expect(dialog).toContain('cache: "no-store"');
    expect(dialog).toContain("Exact Wise answers");
    expect(dialog).toContain("Assessment history");
    expect(dialog).toContain("Wise event associations");
    expect(dialog).toContain("Source issue history");
    expect(dashboard).not.toContain("versionsBySession");
    expect(dashboard).not.toContain("text: topics");
    expect(dialog).not.toMatch(/console\.(log|info|warn|error)/);
  });
});

describe("timing evidence timeline (INC-260829: Wise times only)", () => {
  const answer = { text: "", characters: 0, meaningful: false };

  function detailVersion(input: {
    id: string;
    submittedAt: string | null;
    observedAt: string;
    compliant?: boolean;
  }): FeedbackSessionDetailVersion {
    return {
      id: input.id,
      submissionId: input.id,
      contentHash: input.id,
      submittedAt: input.submittedAt,
      sourceTimestampTrustworthy: false,
      observedAt: input.observedAt,
      provenance: "unknown",
      actorName: null,
      required: { topics: answer, performance: answer, improvement: answer },
      homework: "",
      combinedCharacterCount: 347,
      profile: "teacher",
      sourceTimestampKind: input.submittedAt ? "created" : "unknown",
      actorWiseUserId: null,
      answers: [],
      substantive: true,
      compliant: input.compliant ?? false,
      fieldFailures: [],
    };
  }

  function submissionEvent(input: { id: string; eventTimestamp: string }): FeedbackSubmissionEvent {
    return {
      id: input.id,
      wiseEventId: input.id,
      eventTimestamp: input.eventTimestamp,
      actorWiseUserId: "tutor-1",
      actorName: "Ruke (Lukas) Ogan",
      actorRole: "TEACHER",
      autoSubmitted: null,
      isSessionTutor: true,
      countedAsProof: true,
      notCountedReason: null,
    };
  }

  it("anchors version rows on the Wise timestamp, never on when our sync saw them", () => {
    const { entries } = buildTimingEvidenceEntries(
      "2026-08-28T16:59:59.999Z",
      [submissionEvent({ id: "event-1", eventTimestamp: "2026-08-28T14:01:00.000Z" })],
      [detailVersion({
        id: "version-1",
        // Wise created time (26 Aug) predates the event; our sync only saw it
        // at 14:13 on the 28th — that instant must not appear on the timeline.
        submittedAt: "2026-08-26T07:00:00.000Z",
        observedAt: "2026-08-28T14:13:00.000Z",
      })],
    );

    expect(entries.map((entry) => entry.key))
      .toEqual(["version-version-1", "event-event-1", "deadline"]);
    expect(entries.find((entry) => entry.kind === "version")?.at)
      .toBe("2026-08-26T07:00:00.000Z");
    expect(entries.some((entry) => entry.at === "2026-08-28T14:13:00.000Z")).toBe(false);
  });

  it("keeps a version without any Wise timestamp off the chronology as an undated footnote", () => {
    const { entries, undatedVersions } = buildTimingEvidenceEntries(
      "2026-08-28T16:59:59.999Z",
      [submissionEvent({ id: "event-1", eventTimestamp: "2026-08-28T14:01:00.000Z" })],
      [detailVersion({ id: "version-1", submittedAt: null, observedAt: "2026-08-28T14:13:00.000Z" })],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["event", "deadline"]);
    expect(undatedVersions.map((version) => version.id)).toEqual(["version-1"]);
  });
});

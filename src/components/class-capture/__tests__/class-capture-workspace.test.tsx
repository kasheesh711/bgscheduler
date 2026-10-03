import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClassCaptureWorkspace } from "../class-capture-workspace";
import { canonicalMime, feedbackText, prepareLocalFile, validateLocalFile } from "../client-helpers";
import type { CaptureView } from "@/lib/class-capture/model";

const capture: CaptureView = {
  id: "synthetic-capture", session: { sessionId: "synthetic-session", classId: "synthetic-class", studentId: "synthetic-student", studentName: "Ari (fictional)", teacherKey: "synthetic-tutor", teacherName: "Mali (fictional)", title: "Year 6 Maths", startTime: "2026-10-01T08:00:00Z", endTime: "2026-10-01T09:00:00Z", wiseUrl: "https://wiseapp.live/synthetic-class" },
  topic: "Equivalent fractions", tutorNotes: "Tutor reports two independently completed written examples.", consent: { participants: true, guardian: "confirmed", processing: true }, assets: [],
  draft: { topicsCovered: "Equivalent fractions", demonstratedUnderstanding: "Tutor reports two written examples.", difficulties: "Not established by the supplied evidence.", homeworkNextSteps: "Practice the agreed fraction examples." }, reviewed: false, expiresAt: "2026-10-02T09:00:00Z", version: 0,
};
const initialData = { sessions: [capture.session], availability: { enabled: true, storage: true, transcription: true, drafting: true } };

describe("Class Capture consent and review", () => {
  it("shows only today's own classes with a static Bangkok label and no date picker", () => {
    const html = renderToStaticMarkup(<ClassCaptureWorkspace ownerEmail="synthetic@example.test" enabled initialData={initialData} />);
    expect(html).toContain("Your classes today");
    expect(html).toContain("Today · Bangkok");
    expect(html).not.toContain('type="date"');
    expect(html).toContain("Your own ongoing, upcoming and completed classes appear");
  });

  it("shows a clear pause and the existing feedback path when disabled", () => {
    const html = renderToStaticMarkup(<ClassCaptureWorkspace ownerEmail="synthetic@example.test" enabled={false} />);
    expect(html).toContain("Class capture is paused");
    expect(html).toContain('href="/post-class-feedback"');
    expect(html).not.toContain("Start class recording");
  });

  it("requires participant, guardian and processing confirmation before preparation", () => {
    const html = renderToStaticMarkup(<ClassCaptureWorkspace ownerEmail="synthetic@example.test" enabled initialData={initialData} />);
    expect(html).toContain("Permission comes first.");
    expect(html).toContain("Guardian permission");
    expect(html).toContain("private Vercel Blob storage, Soniox transcription and the OpenRouter drafting model");
    expect(html).toContain("All participants are adults; guardian permission is not required");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^]*?Prepare class capture/);
    expect(html).not.toContain("Start class recording");
  });

  it("clearly separates tutor evidence and drafts from submission", () => {
    const html = renderToStaticMarkup(<ClassCaptureWorkspace ownerEmail="synthetic@example.test" enabled initialData={initialData} initialCapture={capture} />);
    expect(html).toContain("separate from the transcript");
    expect(html).toContain("understanding cannot be inferred from audio");
    expect(html).toContain("Background recording is not supported");
    expect(html).toContain("Existing feedback deadlines and payroll policies still apply");
    expect(html).toContain("Final submission happens in Wise");
    expect(html).not.toContain('href="https://wiseapp.live/synthetic-class"');
  });

  it("provides a Wise handoff only for the saved reviewed draft", () => {
    const html = renderToStaticMarkup(<ClassCaptureWorkspace ownerEmail="synthetic@example.test" enabled initialData={initialData} initialCapture={{ ...capture, reviewed: true }} />);
    expect(html).toContain('href="https://wiseapp.live/synthetic-class"');
    expect(html).toContain("Reviewed · not submitted");
    expect(html).toContain("Copy reviewed feedback");
  });
});

describe("class capture file handling", () => {
  it("canonicalizes recording codecs and rejects mismatched or oversized media", () => {
    expect(canonicalMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(validateLocalFile(new Blob(["synthetic"], { type: "audio/webm;codecs=opus" }), "recording")).toBeNull();
    expect(validateLocalFile(new Blob(["synthetic"], { type: "image/jpeg" }), "recording")).toMatch(/audio/);
    expect(validateLocalFile(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)], { type: "image/png" }), "worksheet")).toMatch(/too large/);
    expect(validateLocalFile(new Blob([], { type: "audio/wav" }), "recording")).toMatch(/empty/);
  });

  it.each(["audio/x-m4a", "audio/m4a", "audio/mp4", "video/mp4", "", "application/octet-stream"])("imports iPhone M4A with type %s and retains bytes", async type => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]);
    const normalized = await prepareLocalFile(new File([bytes], "Lesson.M4A", { type }), "recording");
    expect(normalized.type).toBe("audio/mp4");
    expect(new Uint8Array(await normalized.arrayBuffer())).toEqual(bytes);
  });

  it("rejects renamed non-audio files and explicit unsupported types", async () => {
    await expect(prepareLocalFile(new File(["<html>not audio</html>"], "fake.m4a"), "recording")).rejects.toThrow(/media type/);
    await expect(prepareLocalFile(new File(["content"], "fake.m4a", { type: "text/html" }), "recording")).rejects.toThrow(/audio file/);
  });

  it("copies only the reviewed feedback fields with clear headings", () => {
    const text = feedbackText(capture.draft!);
    expect(text).toContain("Demonstrated understanding\nTutor reports two written examples.");
    expect(text).toContain("Homework & next steps");
    expect(text).not.toContain("synthetic-student");
  });
});

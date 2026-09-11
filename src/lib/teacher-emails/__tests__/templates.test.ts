import { describe, expect, it } from "vitest";
import { teacherEmailFixtures } from "../fixtures";
import { buildFeedbackReminderEmail, buildProgressTestEmail, buildTeachingScheduleEmail, feedbackReasonLabel, formatTeacherEmailDate } from "../templates";
import { teacherEmailLogoUrl } from "../brand";

const logoUrl = teacherEmailLogoUrl("https://schedule.example.com");

describe("teacher email content", () => {
  it("preserves all schedule facts once per class, including repeated rooms and exceptions", () => {
    const { content } = teacherEmailFixtures(logoUrl)[0];
    for (const value of ["09:00-10:00", "Maya Bennett", "Sam Rivera", "Remote / no room needed", "Cool (outside usual rooms) — room change"]) {
      expect(content.text.split(value)).toHaveLength(2);
      expect(content.html.split(value)).toHaveLength(2);
    }
    expect(content.text).toContain("Focus · Think Outside the Box");
    expect(content.html).toContain('href="https://bgscheduler.vercel.app/api/classrooms/floor-plan-map?');
    expect(content.html).not.toMatch(/<img[^>]+floor-plan/);
  });

  it("omits map instructions and links for remote-only schedules", () => {
    const { content } = teacherEmailFixtures(logoUrl).find(item => item.id === "schedule-remote")!;
    expect(content.html).not.toContain("View school map");
    expect(content.text).not.toContain("floor-plan-map");
    expect(content.text).toContain("Remote / no room needed");
  });

  it("escapes names, class content, and link query strings without truncating original text", () => {
    const name = '<img src=x onerror="alert(1)"> & Teacher';
    const content = buildTeachingScheduleEmail({
      logoUrl, tutorDisplayName: name, dateLabel: "12 Sep 2026", usualRooms: [],
      blocks: [{ time: "09:00-10:00", studentOrClass: "A < B & C", subject: 'Science "Lab"', mode: "Onsite", room: "Focus" }],
      mapUrl: "https://example.com/map?a=1&b=2",
    });
    expect(content.html).not.toContain(name);
    expect(content.html).toContain("A &lt; B &amp; C");
    expect(content.html).toContain("Science &quot;Lab&quot;");
    expect(content.html).toContain("map?a=1&amp;b=2");
    expect(content.text).toContain(name);
    expect(content.text).toContain('Science "Lab"');
  });

  it("does not turn an escaped executable URL into a clickable action", () => {
    expect(() => buildTeachingScheduleEmail({ logoUrl, tutorDisplayName: "Alex", dateLabel: "12 Sep", blocks: [], mapUrl: "javascript:alert(1)" })).toThrow("HTTP or HTTPS");
  });

  it("keeps the summary attributed and preserves its contents in both versions", () => {
    const { content } = teacherEmailFixtures(logoUrl).find(item => item.id === "progress-summary")!;
    for (const value of ["AI-generated summary", "Strengths", "Focus areas", "Recommendation", "6 of 8", "Identifies equivalent fractions accurately."]) {
      expect(content.text).toContain(value);
      expect(content.html).toContain(value);
    }
    expect(content.text).toContain("https://bgscheduler.vercel.app/progress-tests");
  });

  it("uses a truthful summary fallback and safe greeting without adding empty sections", () => {
    const { content } = teacherEmailFixtures(logoUrl).find(item => item.id === "progress-fallback")!;
    expect(content.text).toContain("Hi there,");
    expect(content.html).toContain("not enough recent feedback");
    expect(content.html).not.toContain(">Strengths<");
    expect(content.text).toContain("Subject: class");
  });

  it("formats current and legacy feedback reasons without changing the policy bar", () => {
    expect(feedbackReasonLabel("combined_characters:120/300")).toBe("Feedback has 120 of the 300 required combined characters.");
    expect(feedbackReasonLabel("all_fields_placeholder")).toContain("meaningful feedback");
    expect(feedbackReasonLabel("topics:empty+placeholder")).toBe("Topics covered: empty, placeholder");
    expect(feedbackReasonLabel("unknown_reason")).toBe("unknown reason");
  });

  it("retains exact deadlines, counts, missing-name fallback and prepared Wise URLs", () => {
    const { content } = teacherEmailFixtures(logoUrl).find(item => item.id === "feedback-deadline")!;
    for (const value of ["12 Sep 2026, 23:59 (Bangkok)", "Student name unavailable", "350", "meaningful feedback about the class", "Feedback text is intentionally not included"]) {
      expect(content.html).toContain(value);
      expect(content.text).toContain(value);
    }
    expect(content.text).toContain("https://web.wise.live");
    expect(content.html).not.toContain("combined_characters:");
  });

  it("accepts no feedback-answer field and escapes class/reason text", () => {
    const content = buildFeedbackReminderEmail({ logoUrl, tutorDisplayName: "Alex", items: [{ className: "<Class>", students: "A & B", sessionDate: "10 Sep", deadline: "12 Sep, 23:59", characters: 0, reasons: ["<unknown>"], wiseUrl: "https://web.wise.live" }] });
    expect(content.html).toContain("&lt;Class&gt;");
    expect(content.html).toContain("&lt;unknown&gt;");
    expect(content.text).toContain("<unknown>");
  });

  it("formats the Bangkok assignment date independently of the machine timezone", () => {
    expect(formatTeacherEmailDate("2026-09-12")).toBe("Sat, 12 Sept 2026");
  });

  it("strips line breaks from dynamic subjects while retaining names in the body", () => {
    const content = buildProgressTestEmail({ logoUrl, tutorDisplayName: null, studentName: "Maya\nBcc: other@example.com", subject: "Math", currentCount: 6, threshold: 8, dashboardUrl: "https://example.com/progress-tests", aiSummary: null });
    expect(content.subject).not.toMatch(/[\r\n]/);
  });
});

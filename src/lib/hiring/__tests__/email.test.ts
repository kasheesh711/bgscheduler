import { describe, expect, it } from "vitest";
import { hiringEmail, hiringEmailHtmlFromText, HIRING_LINE_URL, mockPrep } from "../email";
import { SUBJECTS } from "../model";
import { preScreenEmail, visitInviteEmail } from "../service";

describe("hiringEmail", () => {
  it("builds text and HTML from the same facts and escapes them", () => {
    const email = hiringEmail({
      subject: "S",
      preheader: "P",
      title: "Book <now>",
      name: "Ann & Bo",
      paragraphs: ["Hello."],
      details: [{ label: "Subject", value: "Physics" }],
      action: { label: "Book your visit", url: "https://bgscheduler.vercel.app/hiring/book/t" },
      after: ["Bring one topic."],
    });
    expect(email.text).toBe(
      `Dear Ann & Bo,\n\nHello.\n\nSubject: Physics\n\nBook your visit:\nhttps://bgscheduler.vercel.app/hiring/book/t\n\nBring one topic.\n\nQuestions? Reply to this email, or message us on LINE. ${HIRING_LINE_URL}\n\nBeGifted Education`,
    );
    expect(email.html).toContain("Dear Ann &amp; Bo,");
    expect(email.html).toContain("Book &lt;now&gt;");
    expect(email.html).toContain('href="https://bgscheduler.vercel.app/hiring/book/t"');
    expect(email.html).toContain(">Physics<");
    expect(email.html).toContain("/brand/email/v3/logo-horizontal.png");
    expect(email.html).toContain(HIRING_LINE_URL);
  });

  it("refuses a link that is not http(s)", () => {
    expect(() =>
      hiringEmail({ subject: "S", preheader: "P", title: "T", name: "A", paragraphs: [], action: { label: "x", url: "javascript:alert(1)" } }),
    ).toThrow();
  });

  it("wraps plain text in the same shell and moves the sign-off to the footer", () => {
    const html = hiringEmailHtmlFromText("Your result", "Dear Ann,\n\nLine one\nLine two\n\nBeGifted Education");
    expect(html).toContain("<p style=\"margin:0 0 12px;\">Line one</p><p style=\"margin:0 0 12px;\">Line two</p>");
    expect(html.match(/BeGifted Education/g)).toHaveLength(1);
    expect(html).toContain(">Your result</h1>");
  });
});

describe("candidate emails keep their facts", () => {
  it("pre-screen invitation and reminder", () => {
    const invite = preScreenEmail("Ann", "ann@example.com", false);
    const reminder = preScreenEmail("Ann", "ann@example.com", true);
    expect(invite.subject).toBe("BeGifted tutor pre-screening questionnaire");
    expect(reminder.subject).toBe("Reminder: BeGifted tutor pre-screening questionnaire");
    for (const e of [invite, reminder]) {
      expect(e.text).toContain("Use this email: ann@example.com");
      expect(e.text).toContain("About 5–7 minutes");
      expect(e.text).toMatch(/Open the questionnaire:\nhttps:\/\//);
    }
  });

  it("visit invitation and reminder", () => {
    const base = { name: "Ann", subject: "Physics", url: "https://bgscheduler.vercel.app/hiring/book/t", location: "Gaysorn Amarin Tower" };
    const invite = visitInviteEmail({ ...base, expireDays: 7 });
    const reminder = visitInviteEmail(base);
    expect(invite.subject).toBe("BeGifted onsite visit invitation");
    expect(invite.text).toContain("Link closes: 7 days after this email");
    expect(reminder.subject).toBe("Reminder: book your BeGifted onsite visit");
    expect(reminder.text).not.toContain("Link closes");
    for (const e of [invite, reminder]) {
      expect(e.text).toContain("Visit: 3 hours: a 2-hour exam, then a 1-hour mock teaching session");
      expect(e.text).toContain("Location: Gaysorn Amarin Tower");
      expect(e.text).toContain("Book your visit:\nhttps://bgscheduler.vercel.app/hiring/book/t");
      expect(e.text).toContain("prepare one lesson in Physics");
    }
  });

  it.each(SUBJECTS)("the visit invitation for %s names the subject and links its syllabus", (subject) => {
    const general = mockPrep("your subject").links;
    const { links } = mockPrep(subject);
    expect(links.length).toBeGreaterThan(general.length);
    const email = visitInviteEmail({ name: "Ann", subject, url: "https://bgscheduler.vercel.app/hiring/book/t", location: "L", expireDays: 7 });
    expect(email.text).toContain(`prepare one lesson in ${subject}`);
    for (const link of links) {
      expect(link.url).toMatch(/^https:\/\//);
      expect(email.text).toContain(`${link.title}:\n${link.url}`);
      expect(email.html).toContain(`href="${link.url}"`);
    }
  });
});

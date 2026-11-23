import { describe, expect, it } from "vitest";
import { hiringEmail, hiringEmailHtmlFromText, HIRING_LINE_URL, mockPrep } from "../email";
import { SUBJECTS } from "../model";
import { callInviteEmail, preScreenEmail, visitInviteEmail } from "../service";

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
  it("R1 invitation: congratulations, a 30-minute Google Meet, the booking link and the five steps", () => {
    const email = callInviteEmail({ name: "Ann", url: "https://bgscheduler.vercel.app/hiring/book/r1" });
    expect(email.subject).toBe("Congratulations! Book your R1: HR Interview with BeGifted");
    for (const part of [email.text, email.html]) {
      expect(part).toContain("Congratulations");
      expect(part).toContain("30 minutes, Google Meet video call");
      expect(part).toContain("Monday to Friday, 13:15–18:00 (Bangkok time)");
      expect(part).toContain("https://bgscheduler.vercel.app/hiring/book/r1");
      expect(part).toContain("How our process works");
      for (const step of ["R1: HR Interview", "Pre-screening questions and visit booking", "Onsite visit: the test", "R2: Final round mock teaching", "Offer"])
        expect(part).toContain(step);
      expect(part).toContain("offer letter by email");
      expect(part).toContain("contract-signing day");
    }
    expect(email.text).not.toMatch(/by phone|phone call/i);
  });

  it("puts BeGifted's own photo on candidate emails, the five step icons, and marks the reader's step", () => {
    const email = callInviteEmail({ name: "Ann", url: "https://bgscheduler.vercel.app/hiring/book/r1" });
    expect(email.html).toContain("/brand/email/hiring/v1/hero-r1.jpg");
    for (const icon of ["step-r1-interview", "step-form-booking", "step-exam", "step-mock-teaching", "step-offer"])
      expect(email.html).toContain(`/brand/email/hiring/v1/${icon}.png`);
    expect(email.html.match(/You are here/g)).toHaveLength(1);
    expect(email.text).toContain("1. R1: HR Interview (You are here)");
    // The photo has alt text and no credit line; an email without a hero has no photo.
    expect(email.html).toMatch(/hero-r1\.jpg" alt="[^"]+"/);
    expect(hiringEmail({ subject: "S", preheader: "P", title: "T", name: "HR team", paragraphs: [] }).html).not.toContain("/brand/email/hiring/");
  });

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
      expect(e.text).toContain("Visit: A 2-hour test. If you pass, a 1-hour mock teaching interview on the same day");
      expect(e.text).toContain("1. Arrive at your booked time\nPlease arrive 10 minutes early.");
      expect(e.text).toContain("3. We grade your test\nGrading takes 5 to 10 minutes.");
      expect(e.text).toContain("5. If you pass: mock teaching interview");
      expect(e.text).toContain("What to bring:\n• Photo ID (passport or ID card)\n• Pens\n• A calculator, if your subject uses one");
      expect(e.text).toContain("prepare one lesson in Physics");
      expect(e.html).toContain("Complete the test");
      expect(e.html).toContain("Photo ID (passport or ID card)");
      expect(e.text).toContain("Location: Gaysorn Amarin Tower");
      expect(e.text).toContain("Book your visit:\nhttps://bgscheduler.vercel.app/hiring/book/t");
      expect(e.text).not.toContain("We will contact you after we grade your paper.");
    }
  });

  it("a text that is not one subject gets the general links only", () => {
    const general = mockPrep("your subject").links;
    for (const text of ["Mathematics, Physics", "constructor", "__proto__"]) expect(mockPrep(text).links).toEqual(general);
  });

  it.each(SUBJECTS)("the mock preparation for %s names the subject and links its syllabus", (subject) => {
    const general = mockPrep("your subject").links;
    const { links, paragraphs } = mockPrep(subject);
    expect(links.length).toBeGreaterThan(general.length);
    const email = hiringEmail({ name: "Ann", subject, title: "Mock teaching", preheader: "Prepare for your mock", paragraphs, links });
    expect(email.text).toContain(`prepare one lesson in ${subject}`);
    for (const link of links) {
      expect(link.url).toMatch(/^https:\/\//);
      expect(email.text).toContain(`${link.title}:\n${link.url}`);
      expect(email.html).toContain(`href="${link.url}"`);
    }
  });
});

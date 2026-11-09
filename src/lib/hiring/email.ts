import { renderCompanyEmail, type CompanyBlock, type EmailAction, type EmailDetail } from "@/lib/company-emails/render";
import { teacherEmailLogoUrl } from "@/lib/teacher-emails/brand";
import { teacherEmailPublicBaseUrl } from "@/lib/teacher-emails/config";

export const HIRING_LINE_URL = "https://lin.ee/OjMHF41";
export const MOCK_PREP =
  "For the mock teaching session, prepare one IGCSE topic of your choice. The interviewer will also select a topic, which may be from another level. You may use teaching materials or tools.";
export const VISIT_LENGTH = "3 hours: a 2-hour exam, then a 1-hour mock teaching session";

/** One candidate email. The plain-text and HTML parts come from these same fields. */
export interface HiringEmail {
  subject: string;
  /** Hidden inbox preview line. */
  preheader: string;
  title: string;
  /** "ink" puts the title on the ink panel; use it for the visit messages. */
  tone?: "paper" | "ink";
  name: string;
  paragraphs: string[];
  details?: EmailDetail[];
  action?: EmailAction;
  /** Paragraphs after the button. */
  after?: string[];
}

const SIGN_OFF = "BeGifted Education";
const FOOTER = {
  note: "Questions? Reply to this email, or message us on LINE.",
  preferences: { label: "Message us on LINE", url: HIRING_LINE_URL },
};

function render(email: HiringEmail, blocks: CompanyBlock[]): string {
  return renderCompanyEmail({
    subject: email.subject,
    preheader: email.preheader,
    title: email.title,
    category: "Tutor hiring",
    tone: email.tone === "ink" ? "navy" : "white",
    logoUrl: teacherEmailLogoUrl(teacherEmailPublicBaseUrl()),
    blocks,
    footer: FOOTER,
  }).html;
}

/** The outbox payload part: subject, plain text and HTML, built from one set of facts. */
export function hiringEmail(email: HiringEmail): { subject: string; text: string; html: string } {
  const greeting = `Dear ${email.name},`;
  const blocks: CompanyBlock[] = [{ kind: "copy", paragraphs: [greeting, ...email.paragraphs] }];
  if (email.details?.length) blocks.push({ kind: "details", entries: email.details });
  if (email.action) blocks.push({ kind: "action", action: email.action });
  if (email.after?.length) blocks.push({ kind: "copy", paragraphs: email.after });
  const text = [
    greeting,
    ...email.paragraphs,
    email.details?.map((d) => `${d.label}: ${d.value}`).join("\n"),
    email.action && `${email.action.label}:\n${email.action.url}`,
    ...(email.after ?? []),
    `${FOOTER.note} ${HIRING_LINE_URL}`,
    SIGN_OFF,
  ].filter(Boolean).join("\n\n");
  return { subject: email.subject, text, html: render(email, blocks) };
}

/**
 * The same shell around plain text: a person's edited Hire or Reject email, and rows queued before the styled
 * builders. Paragraphs split on blank lines, and a closing "BeGifted Education" moves to the footer.
 */
export function hiringEmailHtmlFromText(subject: string, text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.at(-1) === SIGN_OFF) paragraphs.pop();
  const preheader = (paragraphs.find((p) => !/^Dear\b/.test(p)) ?? subject).replace(/\s+/g, " ").slice(0, 140);
  return render(
    { subject, preheader, title: subject, name: "", paragraphs: [] },
    [{ kind: "copy", paragraphs: paragraphs.flatMap((p) => p.split("\n")) }],
  );
}

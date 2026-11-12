import {
  renderCompanyEmail,
  type CompanyBlock,
  type EmailAction,
  type EmailDetail,
  type EmailResource,
} from "@/lib/company-emails/render";
import { teacherEmailLogoUrl } from "@/lib/teacher-emails/brand";
import { teacherEmailPublicBaseUrl } from "@/lib/teacher-emails/config";
import type { Subject } from "./model";

export const HIRING_LINE_URL = "https://lin.ee/OjMHF41";
export const VISIT_LENGTH = "3 hours: a 2-hour exam, then a 1-hour mock teaching session";

const CAMBRIDGE = "https://www.cambridgeinternational.org/programmes-and-qualifications/";
const syllabus = (title: string, slug: string): EmailResource => ({
  title,
  description: "The official syllabus for your subject.",
  url: `${CAMBRIDGE}${slug}/`,
});
const GENERAL_LINKS: EmailResource[] = [
  {
    title: "Cambridge IGCSE subjects",
    description: "All subjects at this level.",
    url: `${CAMBRIDGE}cambridge-upper-secondary/cambridge-igcse/subjects/`,
  },
  {
    title: "Cambridge International AS & A Level subjects",
    description: "All subjects at this level.",
    url: `${CAMBRIDGE}cambridge-advanced/cambridge-international-as-and-a-levels/subjects/`,
  },
  {
    title: "Pearson Edexcel International GCSE",
    description: "All subjects at this level.",
    url: "https://qualifications.pearson.com/en/qualifications/edexcel-international-gcses.html",
  },
  {
    title: "IB Diploma Programme",
    description: "The subject groups of the IB Diploma.",
    url: "https://www.ibo.org/programmes/diploma-programme/",
  },
];
// Every address returned its page on 12 November 2026, except ibo.org: it refuses automated reads, so that address comes
// from a search result. A new subject cannot compile without an entry here.
const SUBJECT_LINKS: Record<Subject, EmailResource[]> = {
  Mathematics: [syllabus("Cambridge IGCSE Mathematics (0580)", "cambridge-igcse-mathematics-0580")],
  Physics: [syllabus("Cambridge IGCSE Physics (0625)", "cambridge-igcse-physics-0625")],
  Chemistry: [syllabus("Cambridge IGCSE Chemistry (0620)", "cambridge-igcse-chemistry-0620")],
  Biology: [syllabus("Cambridge IGCSE Biology (0610)", "cambridge-igcse-biology-0610")],
  "Computer Science": [syllabus("Cambridge IGCSE Computer Science (0478)", "cambridge-igcse-computer-science-0478")],
  ICT: [
    syllabus(
      "Cambridge IGCSE Information and Communication Technology (0417)",
      "cambridge-igcse-information-and-communication-technology-0417",
    ),
  ],
  "EFL/ESL": [
    syllabus(
      "Cambridge IGCSE English as a Second Language (0510)",
      "cambridge-igcse-english-second-language-oral-endorsement-0510",
    ),
  ],
  "English Language": [
    syllabus("Cambridge IGCSE First Language English (0500)", "cambridge-igcse-english-first-language-0500"),
  ],
  "English Literature": [syllabus("Cambridge IGCSE Literature in English (0475)", "english-literature-0475")],
  IELTS: [
    {
      title: "IELTS Academic test",
      description: "The official test format.",
      url: "https://ielts.org/take-a-test/test-types/ielts-academic-test",
    },
    {
      title: "IELTS preparation resources",
      description: "Official practice material.",
      url: "https://ielts.org/take-a-test/preparation-resources",
    },
  ],
  Economics: [syllabus("Cambridge IGCSE Economics (0455)", "cambridge-igcse-economics-0455")],
  "Business Studies": [syllabus("Cambridge IGCSE Business Studies (0450)", "cambridge-igcse-business-studies-0450")],
  Psychology: [
    syllabus(
      "Cambridge International AS & A Level Psychology (9990)",
      "cambridge-international-as-and-a-level-psychology-9990",
    ),
  ],
  Geography: [syllabus("Cambridge IGCSE Geography (0460)", "cambridge-igcse-geography-0460")],
  History: [syllabus("Cambridge IGCSE History (0470)", "cambridge-igcse-history-0470")],
  Thai: [syllabus("Cambridge IGCSE Thai First Language (0518)", "cambridge-igcse-thai-first-language-0518")],
  French: [syllabus("Cambridge IGCSE French Foreign Language (0520)", "cambridge-igcse-french-foreign-language-0520")],
  "Art & Design Technology": [
    syllabus("Cambridge IGCSE Art & Design (0400)", "cambridge-igcse-art-and-design-0400"),
    syllabus("Cambridge IGCSE Design & Technology (0445)", "cambridge-igcse-design-and-technology-0445"),
  ],
};

/**
 * What to prepare for the mock teaching session, with syllabus links. A text that is not one subject (the old flow's
 * list, or the reminder's "your subject") gets the general links only.
 */
export function mockPrep(subject: string): { paragraphs: string[]; links: EmailResource[] } {
  return {
    paragraphs: [
      `For the mock teaching session, prepare one lesson in ${subject}. Choose one topic from an international school syllabus, such as IGCSE, A Level or IB. Plan it as a real one-to-one lesson. Include an objective, an explanation, worked examples and a check of understanding.`,
      "The interviewer will also select a topic. It may be from another level. You may bring teaching materials or tools.",
      "These links show the syllabuses that international schools use.",
    ],
    links: [...(SUBJECT_LINKS[subject as Subject] ?? []), ...GENERAL_LINKS],
  };
}

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
  /** A list of links after those paragraphs. */
  links?: EmailResource[];
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
  if (email.links?.length) blocks.push({ kind: "resources", entries: email.links });
  const text = [
    greeting,
    ...email.paragraphs,
    email.details?.map((d) => `${d.label}: ${d.value}`).join("\n"),
    email.action && `${email.action.label}:\n${email.action.url}`,
    ...(email.after ?? []),
    ...(email.links ?? []).map((link) => `${link.title}:\n${link.url}`),
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

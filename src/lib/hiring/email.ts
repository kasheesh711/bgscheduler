import {
  renderCompanyEmail,
  type CompanyBlock,
  type CompanySection,
  type EmailAction,
  type EmailDetail,
  type EmailResource,
} from "@/lib/company-emails/render";
import { hiringEmailAssetUrl, teacherEmailLogoUrl, type HIRING_EMAIL_ASSET_FILES } from "@/lib/teacher-emails/brand";
import { teacherEmailPublicBaseUrl } from "@/lib/teacher-emails/config";
import type { Subject } from "./model";

export const HIRING_LINE_URL = "https://lin.ee/OjMHF41";

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
    // An own-key check: a name such as "constructor" must not reach an inherited property.
    links: [...(Object.hasOwn(SUBJECT_LINKS, subject) ? SUBJECT_LINKS[subject as Subject] : []), ...GENERAL_LINKS],
  };
}

export const VISIT_LENGTH = "A 2-hour test (Monday to Sunday). If you pass, a 1-hour final-round mock teaching interview on a later day (Monday to Friday)";
/** A "two-day" visit (Kevin, 24 Nov 2026): the test first, then the final-round mock teaching on a later day. Both are booked together. */
export const TWO_DAY_STEPS: CompanySection[] = [
  { heading: "Day 1: the test", paragraphs: ["Please arrive 10 minutes early. The test is on paper and takes 2 hours. It is closed book: no notes and no phone."] },
  { heading: "We grade your test", paragraphs: ["We tell you the result before your mock teaching day."] },
  { heading: "Day 2, if you pass: final round mock teaching", paragraphs: ["A 1-hour mock teaching interview with the head of your subject. Prepare your lesson before the day. If you do not pass the test, we cancel this booking."] },
];
/** The visit day, in order (Kevin, 22 Nov 2026). The mock takes place only after a pass, on the same day. */
export const VISIT_STEPS: CompanySection[] = [
  { heading: "Arrive at your booked time", paragraphs: ["Please arrive 10 minutes early."] },
  { heading: "Complete the test", paragraphs: ["The test is on paper and takes 2 hours. It is closed book: no notes and no phone."] },
  { heading: "We grade your test", paragraphs: ["Grading takes 5 to 10 minutes. Please wait at the office."] },
  { heading: "We tell you the result", paragraphs: ["We tell you before you leave if you passed."] },
  { heading: "If you pass: mock teaching interview", paragraphs: ["The 1-hour mock teaching interview follows immediately, on the same day. Prepare your lesson before the visit."] },
];
export const VISIT_BRING = { heading: "What to bring", bullets: ["Photo ID (passport or ID card)", "Pens", "A calculator, if your subject uses one"] };

const asset = (file: (typeof HIRING_EMAIL_ASSET_FILES)[number]) => hiringEmailAssetUrl(file, teacherEmailPublicBaseUrl());

/** BeGifted's hiring process, in order (Kevin, 22 Nov 2026). The candidate emails show it so each person knows what comes next. */
export const HIRING_PROCESS: CompanySection[] = [
  { heading: "R1: HR Interview", paragraphs: ["A 30-minute Google Meet video call with our HR team."] },
  {
    heading: "Pre-screening questions and visit booking",
    paragraphs: ["If R1 goes well, we send you a short questionnaire and a link to book your onsite visit. Answer the questions first, then book your visit."],
  },
  { heading: "Onsite visit: the test", paragraphs: ["A 2-hour paper test at BeGifted."] },
  { heading: "R2: Final round mock teaching", paragraphs: ["If you pass the test, a 1-hour mock teaching interview follows on the same day."] },
  { heading: "Offer", paragraphs: ["We send the offer letter by email. Then you book your contract-signing day at BeGifted (onsite)."] },
];
const PROCESS_ICONS = ["step-r1-interview.png", "step-form-booking.png", "step-exam.png", "step-mock-teaching.png", "step-offer.png"] as const;
/** The five steps with their icons. `current` (1 to 5) marks the reader's step; earlier steps show as done. */
export const processSteps = (current?: number): CompanySection[] =>
  HIRING_PROCESS.map((step, i) => ({
    ...step,
    icon: asset(PROCESS_ICONS[i]),
    ...(current && i + 1 < current ? { state: "done" as const } : current === i + 1 ? { state: "current" as const } : {}),
  }));
/** The icon for a step in an email's own list, matched to the process step it belongs to. */
export const stepIcon = (step: 1 | 2 | 3 | 4 | 5) => asset(PROCESS_ICONS[step - 1]);

/** BeGifted's own photographs (website set, no credit line needed), one for each part of the process. */
const HEROES = {
  r1: { file: "hero-r1.jpg", alt: "A BeGifted tutoring room with a yellow table and a wide window view of Bangkok" },
  next: { file: "hero-next-steps.jpg", alt: "A BeGifted classroom with a blue table, orange chairs and a chalkboard wall of equations" },
  visit: { file: "hero-visit.jpg", alt: "The orange and grey corridor to the tutoring rooms at BeGifted" },
  offer: { file: "hero-offer.jpg", alt: "The wood-panelled BeGifted lounge with orange leather armchairs" },
} as const;
export type HiringHero = keyof typeof HEROES;

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
  /** A heading above the steps. */
  stepsHeading?: string;
  /** Numbered steps after the button. */
  steps?: CompanySection[];
  /** A photo under the logo, for candidate emails only. */
  hero?: HiringHero;
  /** Shows BeGifted's five steps at the end, with this step (1 to 5) marked "You are here". */
  process?: 1 | 2 | 3 | 4 | 5;
  /** A short bullet list after the steps. */
  list?: { heading: string; bullets: string[] };
  /** Paragraphs after those. */
  after?: string[];
  /** A list of links after those paragraphs. */
  links?: EmailResource[];
}

const SIGN_OFF = "BeGifted Education";
const PROCESS_HEADING = "How our process works";
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
    ...(email.hero ? { hero: { url: asset(HEROES[email.hero].file), alt: HEROES[email.hero].alt } } : {}),
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
  if (email.steps?.length) blocks.push({ kind: "steps", heading: email.stepsHeading, entries: email.steps });
  if (email.list) blocks.push({ kind: "copy", heading: email.list.heading, paragraphs: [], bullets: email.list.bullets });
  if (email.after?.length) blocks.push({ kind: "copy", paragraphs: email.after });
  if (email.links?.length) blocks.push({ kind: "resources", entries: email.links });
  const process = email.process ? processSteps(email.process) : null;
  if (process) blocks.push({ kind: "steps", heading: PROCESS_HEADING, entries: process });
  const text = [
    greeting,
    ...email.paragraphs,
    email.details?.map((d) => `${d.label}: ${d.value}`).join("\n"),
    email.action && `${email.action.label}:\n${email.action.url}`,
    email.steps?.length && email.stepsHeading,
    email.steps
      ?.map((step, i) =>
        [`${i + 1}. ${step.heading}`, ...(step.paragraphs ?? []), step.action && `${step.action.label}:\n${step.action.url}`].filter(Boolean).join("\n"),
      )
      .join("\n\n"),
    email.list && [`${email.list.heading}:`, ...email.list.bullets.map((b) => `• ${b}`)].join("\n"),
    ...(email.after ?? []),
    ...(email.links ?? []).map((link) => `${link.title}:\n${link.url}`),
    process && [PROCESS_HEADING, ...process.map((step, n) => [`${n + 1}. ${step.heading}${step.state === "current" ? " (You are here)" : step.state === "done" ? " (Done)" : ""}`, ...(step.paragraphs ?? [])].join("\n"))].join("\n\n"),
    `${FOOTER.note} ${HIRING_LINE_URL}`,
    SIGN_OFF,
  ].filter(Boolean).join("\n\n");
  return { subject: email.subject, text, html: render(email, blocks) };
}

/**
 * The same shell around plain text: a person's edited Hire or Reject email, and rows queued before the styled
 * builders. Paragraphs split on blank lines, and a closing "BeGifted Education" moves to the footer.
 */
export function hiringEmailHtmlFromText(subject: string, text: string, ...actions: EmailAction[]): string {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.at(-1) === SIGN_OFF) paragraphs.pop();
  const preheader = (paragraphs.find((p) => !/^Dear\b/.test(p)) ?? subject).replace(/\s+/g, " ").slice(0, 140);
  return render(
    { subject, preheader, title: subject, name: "", paragraphs: [] },
    [{ kind: "copy", paragraphs: paragraphs.flatMap((p) => p.split("\n")) }, ...actions.map((action) => ({ kind: "action" as const, action }))],
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { upload } from "@vercel/blob/client";
import { Check, ChevronDown, Circle, CircleDot, Pencil, Upload } from "lucide-react";
import { ANSWER_CHOICES, answersSchema, MAX_PORTFOLIO_BYTES, PORTFOLIO_TYPES, SUBJECTS, type Subject } from "@/lib/hiring/model";
import type { KnownDegree } from "@/lib/hiring/profile-degree";
import { emptyWeek, weekHoursCount, type WeekHours } from "@/lib/hiring/week-hours";
import { Layout, reveal, VisitConfirm } from "./booking";
import { WeekGrid } from "./week-grid";
import c from "./booking.module.css";
import s from "./candidate.module.css";

const ART: Subject = "Art & Design Technology";
// Shorter words on the chips (Fable r1). The stored value stays the Google Form's text, which the import and scoring read.
const SHORT: Record<string, string> = {
  "IB (MYP/ DP)": "IB",
  "British (IGCSE/ GCSE/ A-level)": "British (IGCSE, A‑level)",
  "American (US High School/ AP)": "American (AP)",
  "Thai National Curriculum": "Thai national",
  "Year 2-6 (Primary)": "Year 2–6",
  "Year 7-9 (Lower Secondary)": "Year 7–9",
  "Year 10-11 (IGCSE Level)": "Year 10–11",
  "Year 12-13 (A-level/ IB DP)": "Year 12–13",
  "Less than 1 year": "Less than 1\u00a0year",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className={s.section}>
      <legend className={s.sectionHead}>{title}</legend>
      {children}
    </fieldset>
  );
}

function Q({
  id,
  title,
  hint,
  optional,
  tag,
  hideTitle,
  children,
}: {
  id?: string;
  title: string;
  hint?: string;
  optional?: boolean;
  /** A short note after the title, such as "all that apply". */
  tag?: string;
  /** The section title already says it on screen; screen readers still get the question. */
  hideTitle?: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className={s.q} id={id} tabIndex={-1}>
      <legend className={hideTitle ? c.hidden : s.qTitle}>
        {title}
        {optional && <small>optional</small>}
        {tag && <small>{tag}</small>}
      </legend>
      {hint && <p className={c.note}>{hint}</p>}
      {children}
    </fieldset>
  );
}

/** Real checkbox and radio inputs, so the keyboard and screen readers work. */
function Chips<T extends string>({
  name,
  choices,
  value,
  onChange,
  many,
  disabled,
  off = [],
}: {
  name: string;
  choices: readonly T[];
  value: T[];
  onChange: (value: T[]) => void;
  many?: boolean;
  disabled: boolean;
  /** Choices shown but not open, such as a subject with no test now. */
  off?: readonly T[];
}) {
  return (
    <div className={s.chips}>
      {choices.map((choice) => (
        <label key={choice} className={s.chip} data-one={many ? undefined : ""}>
          <input
            className={c.hidden}
            type={many ? "checkbox" : "radio"}
            name={name}
            disabled={disabled || off.includes(choice)}
            checked={value.includes(choice)}
            onChange={(e) => onChange(many ? (e.target.checked ? [...value, choice] : value.filter((v) => v !== choice)) : [choice])}
          />
          {/* Checks for "all that apply", radio dots for "choose one" (Opus r18). */}
          {many ? <Check aria-hidden size={14} /> : value.includes(choice) ? <CircleDot aria-hidden size={14} /> : <Circle aria-hidden size={14} />}
          {SHORT[choice] ?? choice}
        </label>
      ))}
    </div>
  );
}

/**
 * The pre-screening questions on the booking page. The server checks the answers again, saves them once, and decides
 * whether the times open. After a send the page reloads its view.
 */
export function PreScreenQuestions({
  token,
  filePath,
  reload,
  knownDegree = null,
  testSubjects = [],
  top,
}: {
  token: string;
  filePath: string;
  reload: () => Promise<void>;
  /** The résumé's degree and field: one tap confirms them (Kevin, 24 Nov 2026). */
  knownDegree?: KnownDegree | null;
  /** Subjects a visit can be in now, highest priority first. */
  testSubjects?: Subject[];
  /** The steps and the visit plan, shown above the questions on a phone and beside them on a wide screen. */
  top?: ReactNode;
}) {
  const [degree, setDegree] = useState<(typeof ANSWER_CHOICES.degree)[number][]>([]),
    [field, setField] = useState(""),
    [degreeMode, setDegreeMode] = useState<"ask" | "known" | "confirmed">(knownDegree ? "known" : "ask"),
    [subjects, setSubjects] = useState<Subject[]>([]),
    [moreOpen, setMoreOpen] = useState(false),
    [testSubject, setTestSubject] = useState<Subject[]>([]),
    [curricula, setCurricula] = useState<(typeof ANSWER_CHOICES.curricula)[number][]>([]),
    [yearGroups, setYearGroups] = useState<(typeof ANSWER_CHOICES.yearGroups)[number][]>([]),
    [english, setEnglish] = useState<(typeof ANSWER_CHOICES.english)[number][]>([]),
    [englishEvidence, setEnglishEvidence] = useState(""),
    [experience, setExperience] = useState<(typeof ANSWER_CHOICES.experience)[number][]>([]),
    [portfolio, setPortfolio] = useState(""),
    [week, setWeek] = useState<WeekHours>(emptyWeek),
    [weeklyHours, setWeeklyHours] = useState<(typeof ANSWER_CHOICES.weeklyHours)[number][]>([]),
    [motivation, setMotivation] = useState(""),
    [teachingApproach, setTeachingApproach] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    // The name of the portfolio file that is now in storage, and the state of the upload.
    [fileName, setFileName] = useState(""),
    [fileNote, setFileNote] = useState("");
  async function choose(file: File | undefined) {
    if (!file) return;
    if (!(PORTFOLIO_TYPES as readonly string[]).includes(file.type)) return setFileNote("Choose a PDF, a JPEG or a PNG file.");
    if (file.size > MAX_PORTFOLIO_BYTES) return setFileNote("Choose a file smaller than 25 MB.");
    setBusy(true);
    setFileNote("Uploading…");
    try {
      // Browser to private storage, because a function request body is limited to 4.5 MB. The server gives a
      // token only for the path of this link's candidate.
      await upload(filePath, file, { access: "private", handleUploadUrl: `/api/hiring/book/${token}`, contentType: file.type });
      setFileName(file.name);
      setFileNote("");
    } catch {
      // The storage library hides the server's reason.
      setFileNote("The upload failed. Please try again, or add a link to your portfolio.");
    } finally {
      setBusy(false);
    }
  }
  // Subjects a visit can be in come first; the rest open on request (Mobbin: Meetup "popular" first, Bumble "show more").
  const first = testSubjects.length ? testSubjects.filter((v) => SUBJECTS.includes(v)) : [...SUBJECTS];
  const rest = SUBJECTS.filter((v) => !first.includes(v));
  // Collapsed, the list keeps any ticked extra subject in view, so "Fewer subjects" never hides a choice (Sol r14).
  const showRest = moreOpen;
  const shownSubjects = showRest ? [...first, ...rest] : [...first, ...rest.filter((v) => subjects.includes(v))];
  // The test subject is one of the ticked subjects that a visit can be in; with none of those, any ticked subject.
  const testable = subjects.filter((v) => testSubjects.includes(v));
  const testChoices = testable.length ? testable : subjects;
  const chosenTest = testSubject.filter((v) => testChoices.includes(v));
  const test = chosenTest[0] ?? (testChoices.length === 1 ? testChoices[0] : undefined);
  const known = degreeMode === "confirmed" && knownDegree;
  const answers = {
    degree: known ? knownDegree.degree : degree[0],
    field: known ? knownDegree.field : field,
    subjects,
    testSubject: test,
    curricula,
    yearGroups,
    english: english[0],
    englishEvidence,
    experience: experience[0],
    portfolio,
    availability: week,
    weeklyHours: weeklyHours[0],
    motivation,
    teachingApproach,
  };
  // Each question, whether it is answered, and where it is: the rail lists the open ones as jump links.
  const checks: [string, string, boolean][] = [
    // The names match the field labels, so "Next: …" points at what the candidate sees (Opus r16).
    ["q-degree", knownDegree && degreeMode !== "ask" ? "Your degree" : "Highest degree", !!answers.degree && !!answers.field.trim()],
    ["q-english", "English level", !!answers.english],
    ["q-experience", "Teaching experience", !!answers.experience],
    ["q-subjects", "Subjects", subjects.length > 0],
    // Always counted; asked only when there is a choice (one subject is chosen for the candidate).
    [subjects.length > 1 ? "q-test" : "q-subjects", "Test subject", !!test],
    // Art & Design needs its portfolio (a file or a link): its own step, so "Next" names it (Sol r13).
    ...(subjects.includes(ART) ? [["q-portfolio", "Portfolio", !!fileName || !!portfolio.trim()] as [string, string, boolean]] : []),
    ["q-curricula", "Curricula", curricula.length > 0],
    ["q-years", "Year groups", yearGroups.length > 0],
    ["q-hours", "Your hours", weekHoursCount(week) > 0],
    ["q-weekly", "Hours a week", !!answers.weeklyHours],
    ["q-why", "Why BeGifted", !!motivation.trim()],
    ["q-approach", "Your approach", !!teachingApproach.trim()],
  ];
  const done = checks.map((c) => c[2]);
  const answered = done.filter(Boolean).length;
  const open = checks.filter((c) => !c[2]);
  async function send() {
    const parsed = answersSchema.safeParse(answers);
    if (parsed.success && subjects.includes(ART) && !fileName && !portfolio.trim()) {
      reveal("q-portfolio", true);
      return setError("Upload your Art & Design portfolio, or add a link to it.");
    }
    if (!parsed.success) {
      // One plain sentence, and the first open question comes into view. A missing single choice has no message of its own.
      const issue = parsed.error.issues[0];
      // Short, so the sticky bar stays small (Opus r8); the page jumps to the first open question.
      setError(open.length ? `Still to answer: ${open[0][1]}${open.length > 1 ? `, and ${open.length - 1} more` : ""}.` : issue.code === "custom" || issue.code === "too_small" ? issue.message : "Please answer every question.");
      if (open.length) reveal(open[0][0], true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/hiring/book/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: parsed.data }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      await reload();
      // The times replace the questions: start the candidate at the test times.
      reveal("times-start", true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your answers.");
    } finally {
      setBusy(false);
    }
  }
  const text = (label: string, value: string, set: (v: string) => void, max: number, placeholder?: string, optional?: boolean) => (
    <label className={c.field}>
      <span className={s.qTitle}>
        {label}
        {optional && <small>optional</small>}
      </span>
      <input className={c.input} value={value} maxLength={max} placeholder={placeholder} disabled={busy} onChange={(e) => set(e.target.value)} />
    </label>
  );
  const long = (id: string, label: string, value: string, set: (v: string) => void) => (
    <label className={c.field} id={id} tabIndex={-1}>
      <span className={s.qTitle}>{label}</span>
      <textarea className={c.input} rows={4} value={value} maxLength={5000} disabled={busy} onChange={(e) => set(e.target.value)} />
    </label>
  );
  const questions = (
    <>
      <Section title="About you">
        {degreeMode !== "ask" && knownDegree ? (
          <div className={s.known} id="q-degree" tabIndex={-1} data-ok={degreeMode === "confirmed" || undefined}>
            <p>
              <small>Your degree · from your résumé</small>
              <b>
                {knownDegree.degree} · {knownDegree.field}
              </b>
            </p>
            <div className={s.knownActions}>
              <button type="button" aria-pressed={degreeMode === "confirmed"} disabled={busy} onClick={() => setDegreeMode("confirmed")}>
                {/* One name for both states; aria-pressed says whether it is confirmed (code review r13). */}
                {degreeMode === "confirmed" && <Check aria-hidden size={16} />}
                Yes, that&apos;s right
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDegree([knownDegree.degree]);
                  setField(knownDegree.field);
                  setDegreeMode("ask");
                }}
              >
                <Pencil aria-hidden size={14} />
                Edit
              </button>
            </div>
          </div>
        ) : (
          <>
            <Q id="q-degree" title="Highest degree">
              <Chips name="degree" choices={ANSWER_CHOICES.degree} value={degree} onChange={setDegree} disabled={busy} />
            </Q>
            {text("Field of study", field, setField, 200)}
          </>
        )}
        <Q id="q-english" title="English level">
          <Chips name="english" choices={ANSWER_CHOICES.english} value={english} onChange={setEnglish} disabled={busy} />
          <label className={s.small} htmlFor="english-proof">
            English proof <small>(optional)</small>
          </label>
          <input
            id="english-proof"
            className={c.input}
            value={englishEvidence}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setEnglishEvidence(e.target.value)}
          />
        </Q>
        <Q id="q-experience" title="Teaching experience">
          <Chips name="experience" choices={ANSWER_CHOICES.experience} value={experience} onChange={setExperience} disabled={busy} />
        </Q>
      </Section>
      <Section title="What you teach">
        <Q id="q-subjects" title="Subjects you teach confidently" tag="choose all">
          <Chips name="subjects" choices={shownSubjects} value={subjects} onChange={setSubjects} many disabled={busy} />
          {rest.length > 0 && (showRest || rest.some((v) => !subjects.includes(v))) && (
            <div>
              <button type="button" className={s.more} aria-expanded={showRest} onClick={() => setMoreOpen(!showRest)}>
                <ChevronDown aria-hidden size={16} style={showRest ? { transform: "rotate(180deg)" } : undefined} />
                {showRest ? "Fewer subjects" : `${rest.filter((v) => !subjects.includes(v)).length} more subjects`}
              </button>
            </div>
          )}
        </Q>
        {/* With one subject ticked there is no choice to show: one line says what the test is in (Sol r6, r20). */}
        {subjects.length === 1 && test && (
          <p className={c.note} role="status">
            Test and mock teaching subject: <b>{test}</b>
          </p>
        )}
        {subjects.length > 1 && testChoices.length > 0 && (
          <Q
            id="q-test"
            title="Choose one subject for your test and mock teaching"
            hint={testable.length && testable.length < subjects.length ? "Greyed: not tested." : undefined}
          >
            <Chips
              name="testSubject"
              choices={subjects}
              value={test ? [test] : []}
              onChange={setTestSubject}
              disabled={busy}
              off={testable.length ? subjects.filter((v) => !testable.includes(v)) : []}
            />
          </Q>
        )}
        {subjects.includes(ART) && (
          <Q id="q-portfolio" title="Portfolio">
            <label className={s.drop}>
              <input
                className={c.hidden}
                type="file"
                accept={PORTFOLIO_TYPES.join(",")}
                disabled={busy}
                onChange={(e) => choose(e.target.files?.[0])}
              />
              <Upload aria-hidden size={18} />
              <span>
                <b>{fileName || "Upload portfolio"}</b>
                <small>{fileName ? "Uploaded. Choose again to replace it." : "PDF, JPG or PNG, max 25 MB"}</small>
              </span>
            </label>
            {fileNote && (
              <p className={c.note} role="status">
                {fileNote}
              </p>
            )}
            {text("Link (no password)", portfolio, setPortfolio, 500)}
          </Q>
        )}
        <Q id="q-curricula" title="Curricula" tag="choose all">
          <Chips name="curricula" choices={ANSWER_CHOICES.curricula} value={curricula} onChange={setCurricula} many disabled={busy} />
        </Q>
        <Q id="q-years" title="Year groups" tag="choose all">
          <Chips name="yearGroups" choices={ANSWER_CHOICES.yearGroups} value={yearGroups} onChange={setYearGroups} many disabled={busy} />
        </Q>
      </Section>
      <Section title="When you can teach onsite">
        <Q id="q-hours" title="Your weekly hours for teaching onsite" hideTitle>
          <WeekGrid value={week} onChange={setWeek} disabled={busy} />
        </Q>
        <Q id="q-weekly" title="Hours a week you can commit">
          <Chips name="weeklyHours" choices={ANSWER_CHOICES.weeklyHours} value={weeklyHours} onChange={setWeeklyHours} disabled={busy} />
        </Q>
      </Section>
      <Section title="Your words">
        {long("q-why", "Why do you want to tutor with BeGifted?", motivation, setMotivation)}
        {long("q-approach", "A bright student is losing motivation and their grades are slipping. How would you approach it?", teachingApproach, setTeachingApproach)}
      </Section>
    </>
  );
  return (
    <Layout
      top={top}
      main={questions}
      side={
        <VisitConfirm
          compact
          error={error}
          disabled={busy}
          // Until every answer is in, the button takes the candidate to the next open question (Sol r17).
          label={busy ? "Saving…" : open.length ? `Next: ${open[0][1]}` : "Save and see times"}
          onConfirm={() => (open.length ? reveal(open[0][0], true) : send())}
          summary={
            <>
              <div className={s.progress}>
                <span>
                  {answered}/{done.length} answered
                </span>
                <span className={s.progressBar} aria-hidden>
                  <i style={{ width: `${(answered / done.length) * 100}%` }} />
                </span>
              </div>

            </>
          }
        />
      }
    />
  );
}

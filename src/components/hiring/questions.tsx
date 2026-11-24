"use client";

import { useState, type ReactNode } from "react";
import { upload } from "@vercel/blob/client";
import { ANSWER_CHOICES, answersSchema, MAX_PORTFOLIO_BYTES, PORTFOLIO_TYPES, SUBJECTS, TEST_SUBJECT_QUESTION, type Subject } from "@/lib/hiring/model";
import { VisitConfirm } from "./booking";
import c from "./booking.module.css";

const ART: Subject = "Art & Design Technology";

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className={c.step}>
      <legend className={c.stepHead}>
        <span className={c.stepTitle}>{title}</span>
      </legend>
      {hint && <p className={c.note}>{hint}</p>}
      {children}
    </fieldset>
  );
}

/** Real checkbox and radio inputs, so the keyboard and screen readers work. */
function Pills<T extends string>({
  name,
  choices,
  value,
  onChange,
  many,
  disabled,
}: {
  name: string;
  choices: readonly T[];
  value: T[];
  onChange: (value: T[]) => void;
  many?: boolean;
  disabled: boolean;
}) {
  return (
    <div className={c.pills}>
      {choices.map((choice) => (
        <label key={choice} className={c.pill}>
          <input
            className={c.hidden}
            type={many ? "checkbox" : "radio"}
            name={name}
            disabled={disabled}
            checked={value.includes(choice)}
            onChange={(e) =>
              onChange(many ? (e.target.checked ? [...value, choice] : value.filter((v) => v !== choice)) : [choice])
            }
          />
          {choice}
        </label>
      ))}
    </div>
  );
}

/**
 * The pre-screening questions on the booking page. The server checks the answers again, saves them once, and decides
 * whether the times open. After a send the page reloads its view.
 */
export function PreScreenQuestions({ token, filePath, reload }: { token: string; filePath: string; reload: () => Promise<void> }) {
  const [degree, setDegree] = useState<(typeof ANSWER_CHOICES.degree)[number][]>([]),
    [field, setField] = useState(""),
    [subjects, setSubjects] = useState<Subject[]>([]),
    [testSubject, setTestSubject] = useState<Subject[]>([]),
    [curricula, setCurricula] = useState<(typeof ANSWER_CHOICES.curricula)[number][]>([]),
    [yearGroups, setYearGroups] = useState<(typeof ANSWER_CHOICES.yearGroups)[number][]>([]),
    [english, setEnglish] = useState<(typeof ANSWER_CHOICES.english)[number][]>([]),
    [englishEvidence, setEnglishEvidence] = useState(""),
    [experience, setExperience] = useState<(typeof ANSWER_CHOICES.experience)[number][]>([]),
    [portfolio, setPortfolio] = useState(""),
    [availability, setAvailability] = useState<(typeof ANSWER_CHOICES.availability)[number][]>([]),
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
  // A test subject that is no longer ticked is no longer chosen.
  const chosenTest = testSubject.filter((s) => subjects.includes(s));
  const answers = {
    degree: degree[0],
    field,
    subjects,
    testSubject: chosenTest[0],
    curricula,
    yearGroups,
    english: english[0],
    englishEvidence,
    experience: experience[0],
    portfolio,
    availability,
    weeklyHours: weeklyHours[0],
    motivation,
    teachingApproach,
  };
  async function send() {
    const parsed = answersSchema.safeParse(answers);
    if (parsed.success && subjects.includes(ART) && !fileName && !portfolio.trim())
      return setError("Upload your Art & Design portfolio, or add a link to it.");
    if (!parsed.success) {
      // One plain sentence. A missing single choice has no message of its own.
      const issue = parsed.error.issues[0];
      setError(issue.code === "custom" || issue.code === "too_small" ? issue.message : "Please answer every question.");
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your answers.");
    } finally {
      setBusy(false);
    }
  }
  const text = (label: string, value: string, set: (v: string) => void, max: number, hint?: string) => (
    <label className={c.field}>
      <span className={c.stepTitle}>{label}</span>
      {hint && <span className={c.note}>{hint}</span>}
      <input className={c.input} value={value} maxLength={max} disabled={busy} onChange={(e) => set(e.target.value)} />
    </label>
  );
  const long = (label: string, value: string, set: (v: string) => void) => (
    <label className={c.field}>
      <span className={c.stepTitle}>{label}</span>
      <textarea className={c.input} rows={5} value={value} maxLength={5000} disabled={busy} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <>
      <Group title="Highest degree level" hint="Choose the highest degree that you have completed.">
        <Pills name="degree" choices={ANSWER_CHOICES.degree} value={degree} onChange={setDegree} disabled={busy} />
      </Group>
      {text("Field of study", field, setField, 200)}
      <Group title="Which subjects can you confidently teach?">
        <Pills name="subjects" choices={SUBJECTS} value={subjects} onChange={setSubjects} many disabled={busy} />
      </Group>
      {subjects.length > 0 && (
        <Group title={TEST_SUBJECT_QUESTION} hint="Choose one. Your test and your mock teaching are in this subject.">
          <Pills name="testSubject" choices={subjects} value={chosenTest} onChange={setTestSubject} disabled={busy} />
        </Group>
      )}
      {subjects.includes(ART) && (
        <Group title="Your Art & Design portfolio" hint="Upload one PDF, JPEG or PNG file of up to 25 MB. You can add a link too, or a link only.">
          <input
            className={c.input}
            type="file"
            aria-label="Portfolio file"
            accept={PORTFOLIO_TYPES.join(",")}
            disabled={busy}
            onChange={(e) => choose(e.target.files?.[0])}
          />
          {(fileNote || fileName) && (
            <p className={c.note} role="status">
              {fileNote || `Uploaded: ${fileName}`}
            </p>
          )}
          {text("Link to your portfolio (optional)", portfolio, setPortfolio, 500, "A link that we can open without a password.")}
        </Group>
      )}
      <Group title="Which curricula do you have experience teaching?">
        <Pills name="curricula" choices={ANSWER_CHOICES.curricula} value={curricula} onChange={setCurricula} many disabled={busy} />
      </Group>
      <Group title="Which year groups can you teach?">
        <Pills name="yearGroups" choices={ANSWER_CHOICES.yearGroups} value={yearGroups} onChange={setYearGroups} many disabled={busy} />
      </Group>
      <Group title="English proficiency level">
        <Pills name="english" choices={ANSWER_CHOICES.english} value={english} onChange={setEnglish} disabled={busy} />
      </Group>
      {text("Evidence of your English level (optional)", englishEvidence, setEnglishEvidence, 500, "For example: IELTS 8.0.")}
      <Group title="Years of tutoring or teaching experience">
        <Pills name="experience" choices={ANSWER_CHOICES.experience} value={experience} onChange={setExperience} disabled={busy} />
      </Group>
      <Group title="Which time slots work for you?" hint="Choose every time that you can teach onsite.">
        <Pills name="availability" choices={ANSWER_CHOICES.availability} value={availability} onChange={setAvailability} many disabled={busy} />
      </Group>
      <Group title="How many hours per week can you commit?">
        <Pills name="weeklyHours" choices={ANSWER_CHOICES.weeklyHours} value={weeklyHours} onChange={setWeeklyHours} disabled={busy} />
      </Group>
      {long("Why do you want to tutor with BeGifted?", motivation, setMotivation)}
      {long(
        "A student is bright but keeps losing motivation and their grades are slipping. How would you approach it?",
        teachingApproach,
        setTeachingApproach,
      )}
      <VisitConfirm error={error} disabled={busy} label={busy ? "Saving…" : "Save my answers and see the times"} onConfirm={send} />
    </>
  );
}

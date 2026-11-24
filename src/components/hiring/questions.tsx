"use client";

import { useState, type ReactNode } from "react";
import { ANSWER_CHOICES, answersSchema, SUBJECTS, TEST_SUBJECT_QUESTION, WRITTEN_MIN, type Subject } from "@/lib/hiring/model";
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
export function PreScreenQuestions({ token, reload }: { token: string; reload: () => Promise<void> }) {
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
    [error, setError] = useState("");
  // A test subject that is no longer ticked is no longer chosen.
  const chosenTest = testSubject.filter((s) => subjects.includes(s));
  const answers = {
    degree,
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
      <span className={c.note}>
        At least {WRITTEN_MIN} characters. {value.trim().length < WRITTEN_MIN ? `${value.trim().length} so far.` : ""}
      </span>
      <textarea className={c.input} rows={5} value={value} maxLength={5000} disabled={busy} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <>
      <Group title="Highest degree level" hint="Choose every degree that you have completed.">
        <Pills name="degree" choices={ANSWER_CHOICES.degree} value={degree} onChange={setDegree} many disabled={busy} />
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
      {subjects.includes(ART) && text("Link to your Art & Design portfolio", portfolio, setPortfolio, 500, "A link that we can open without a password.")}
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

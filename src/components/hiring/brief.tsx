import { ANSWER_LABELS } from "@/lib/hiring/model";
import type { briefView } from "@/lib/hiring/service";
import { BriefRubric } from "./brief-rubric";
import c from "./booking.module.css";

type Brief = Awaited<ReturnType<typeof briefView>>;

export const BriefLoading = () => (
  <p role="status" className={c.note}>
    Loading the candidate…
  </p>
);

/** One message for every failure, so a link tells nothing about a booking. */
export const BriefGone = () => (
  <p role="alert" className={c.alert}>
    This link is invalid or has expired. Ask BeGifted admin for the candidate&apos;s details.
  </p>
);

/** The interviewer's page: who they will meet, the résumé, the form answers, and the interviewer's own score form. No contact details and no AI scores. */
export function InterviewerBrief({ brief, resumeUrl, rubricUrl }: { brief: Brief; resumeUrl: string; rubricUrl: string }) {
  const facts: [string, string][] = [
    ["Subject", brief.subject],
    ...(brief.exam ? ([["Exam", `${brief.exam} (Bangkok)`]] as [string, string][]) : []),
    ["Mock teaching", `${brief.mock} (Bangkok)`],
    ["Interviewer", brief.interviewer ?? "To be confirmed"],
    ["Place", brief.location],
  ];
  return (
    <>
      <section className={c.facts}>
        <h2 className={c.subject}>{brief.name}</h2>
        <dl className={c.answers}>
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className={c.factLabel}>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={c.facts}>
        <h2 className={c.stepTitle}>Résumé</h2>
        {brief.resume ? (
          <>
            <a className={c.button} href={resumeUrl} target="_blank" rel="noreferrer">
              {brief.resume === "pdf" ? "Open the résumé (PDF)" : "Download the résumé (Word file)"}
            </a>
            <p className={c.note}>The résumé holds personal data. Do not share this page or the file.</p>
          </>
        ) : (
          <p className={c.note}>No résumé file is stored for this candidate.</p>
        )}
      </section>
      <section className={c.facts}>
        <h2 className={c.stepTitle}>Pre-screen answers</h2>
        {brief.answers ? (
          <dl className={c.answers}>
            {ANSWER_LABELS.map(([key, label]) => (
              <div key={key}>
                <dt className={c.factLabel}>{label}</dt>
                <dd>{brief.answers?.[key] || "No answer"}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className={c.note}>This candidate has no pre-screen reply.</p>
        )}
      </section>
      <section className={c.facts}>
        <h2 className={c.stepTitle}>Mock lesson scores</h2>
        <BriefRubric saved={brief.rubric} form={brief.form} url={rubricUrl} />
      </section>
    </>
  );
}

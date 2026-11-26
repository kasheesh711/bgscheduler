import type { atsOutcomes } from "@/lib/hiring/ats-outcomes";

const number = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const display = (score: number | null | undefined) => score == null ? "—" : number.format(score);
const tableStyle = "w-full table-fixed text-left text-sm tabular-nums [&_td]:py-2 [&_td]:text-right [&_th]:py-2 [&_tbody_th]:font-normal [&_tr]:border-b";
const cardStyle = "rounded-xl border bg-card p-4 sm:p-6";

export function AtsOutcomes({ report }: { report: Awaited<ReturnType<typeof atsOutcomes>> }) {
  const { accepted, rejected, threshold, softRejected, stageOnly } = report;
  const criteria = accepted.parts.length ? accepted.parts : rejected.parts;
  const headings = (first: string) => <thead><tr>
    <th scope="col" className="w-[48%]">{first}</th>
    <th scope="col" className="text-right">Accepted</th><th scope="col" className="text-right">Rejected</th>
  </tr></thead>;

  return <>
    <div className="grid gap-4 sm:grid-cols-2">
      {([["Accepted", accepted], ["Rejected", rejected]] as const).map(([label, cohort]) =>
        <section key={label} className={cardStyle}>
          <h2 className="text-base font-semibold">{label}</h2>
          <p className="my-2 text-4xl font-semibold tabular-nums">{cohort.total}</p>
          <p className="text-sm">{cohort.scored} of {cohort.total} with a résumé score</p>
          <p className="mt-1 text-sm text-muted-foreground">Median score <strong>{display(cohort.median)}</strong></p>
        </section>)}
    </div>
    <section className="rounded-xl border border-primary/25 bg-primary/5 p-4 sm:p-6">
      <h2 className="text-lg font-semibold">Invitation cutoff · {threshold} points</h2>
      <p className="mt-2">{rejected.scored ? <><strong>{rejected.atOrAbove} of {rejected.scored}</strong> scored rejections met the cutoff.</> : "No scored rejections yet."}
        {" "}{accepted.scored ? <><strong>{accepted.scored - accepted.atOrAbove} of {accepted.scored}</strong> scored acceptances fell below it.</> : "No scored acceptances yet."}</p>
      <p className="mt-2 text-sm text-muted-foreground">{!accepted.scored || !rejected.scored
        ? "A comparison needs scored candidates in both groups."
        : "Check the group sizes before changing the cutoff."} The ATS helps select whom to invite. Paper tests and mock teaching can change the final decision.</p>
    </section>
    <div className="grid gap-4 lg:grid-cols-2">
      <section className={cardStyle}>
        <h2 className="mb-3 text-lg font-semibold">Résumé score distribution</h2>
        <table className={tableStyle} aria-label="Candidate counts by résumé score">
          {headings("Score")}
          <tbody>{["Below 20", "20 to <40", "40 to <60", "60 to <80", "80 and above"].map((band, i) =>
            <tr key={band}><th scope="row">{band}</th><td>{accepted.bands[i]}</td><td>{rejected.bands[i]}</td></tr>)}
            <tr><th scope="row">Score missing</th><td>{accepted.total - accepted.scored}</td><td>{rejected.total - rejected.scored}</td></tr>
          </tbody>
        </table>
      </section>
      <section className={cardStyle}>
        <h2 className="text-lg font-semibold">Points by criterion</h2>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">Average points per scored candidate. The maximum appears in brackets.</p>
        {criteria.length ? <table className={tableStyle} aria-label="Average points by résumé scoring criterion">
          {headings("Criterion")}
          <tbody>{criteria.map(({ name, max }, i) => <tr key={name}>
            <th scope="row">{name} ({max})</th><td>{display(accepted.parts[i]?.mean)}</td><td>{display(rejected.parts[i]?.mean)}</td>
          </tr>)}
            <tr><th scope="row">Work rights deduction</th><td>{display(accepted.meanPenalty)}</td><td>{display(rejected.meanPenalty)}</td></tr>
          </tbody>
        </table> : <p className="text-sm">Criterion averages will appear with the first scored final decision.</p>}
      </section>
    </div>
    <section className="space-y-2 text-sm text-muted-foreground">
      <h2 className="font-semibold text-foreground">Which candidates count?</h2>
      <p>Each candidate counts once when their current stage matches a recorded final Hire or Reject decision. Accepted means BeGifted approved the hire. Contract signing is a later step.</p>
      <p>The comparison excludes {softRejected} automatic soft rejections and {stageOnly} candidates whose final stage has no matching decision. It also excludes open applications, withdrawals and missed replies.</p>
      <p>Scores use the current weights and the latest stored résumé assessment. Earlier decisions may have used different scores.</p>
    </section>
  </>;
}

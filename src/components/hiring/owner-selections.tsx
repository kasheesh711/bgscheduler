import type { atsOutcomes } from "@/lib/hiring/ats-outcomes";

const phoneLabel = "block text-xs font-medium text-muted-foreground sm:hidden";

export function OwnerSelections({ picks }: { picks: Awaited<ReturnType<typeof atsOutcomes>>["picks"] }) {
  return <section id="owner-selections" aria-labelledby="owner-selections-title" tabIndex={-1} className="rounded-xl border bg-card p-4 sm:p-6">
    <h2 id="owner-selections-title" className="text-lg font-semibold">Kevin’s candidate selections</h2>
    <p className="mt-1 text-sm text-muted-foreground">{picks.length} recorded decisions. Compare the latest intake score recorded before each pick with the cutoff in effect on the decision date. The dated snapshot preserves the score when the pick was logged.</p>
    {picks.length > 0 && <div className="mt-3">
      <table role="table" className="w-full text-left text-sm tabular-nums [&_td]:p-2 [&_th]:p-2 [&_tr]:border-b">
        <thead className="sr-only sm:not-sr-only sm:table-header-group"><tr>{["Decision date", "Candidate", "Decision", "Intake before pick", "Cutoff", "Score snapshot"].map(label =>
          <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody role="rowgroup" className="max-sm:grid max-sm:gap-2">{picks.map(pick => <tr key={pick.id} role="row" className="max-sm:grid max-sm:grid-cols-2 max-sm:rounded-lg max-sm:border">
          <td role="cell"><span className={phoneLabel} aria-hidden="true">Decision date</span>{pick.date}</td>
          <th scope="row" role="rowheader" className="break-words"><span className={phoneLabel} aria-hidden="true">Candidate</span>{pick.name}{pick.university && <span className="block font-normal">{pick.university}</span>}</th>
          <td role="cell"><span className={phoneLabel} aria-hidden="true">Decision</span>{pick.decision}</td>
          <td role="cell"><span className={phoneLabel} aria-hidden="true">Intake before pick</span>{pick.priorScore ?? "No score recorded"}{pick.priorScoreDate && <small className="block">{pick.priorScoreDate}</small>}</td>
          <td role="cell"><span className={phoneLabel} aria-hidden="true">Cutoff</span>{pick.cutoff ?? "Unknown"}</td>
          <td role="cell"><span className={phoneLabel} aria-hidden="true">Score snapshot</span>{pick.snapshotScore ?? "Unscored"}<small className="block">{pick.snapshotDate}</small></td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}

import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { hiringAudit, hiringCandidates } from "@/lib/db/schema";

const phoneLabel = "block text-xs font-medium text-muted-foreground sm:hidden";

export async function OwnerSelections({ db }: { db: Database }) {
  const picks = await db.select({
    id: hiringAudit.id,
    name: hiringCandidates.name,
    date: sql<string>`${hiringAudit.detail}->>'selectedDate'`,
    decision: sql<string>`${hiringAudit.detail}->>'decision'`,
    university: sql<string | null>`${hiringAudit.detail}->>'university'`,
    priorScore: sql<string | null>`${hiringAudit.detail}->>'priorScore'`,
    priorScoreDate: sql<string | null>`${hiringAudit.detail}->>'priorScoreDate'`,
    cutoff: sql<string | null>`${hiringAudit.detail}->>'decisionCutoff'`,
    snapshotScore: sql<string | null>`${hiringAudit.detail}->>'snapshotScore'`,
    snapshotDate: sql<string>`${hiringAudit.detail}->>'snapshotDate'`,
  }).from(hiringAudit)
    .innerJoin(hiringCandidates, eq(hiringCandidates.id, hiringAudit.candidateId))
    .where(eq(hiringAudit.action, "owner-selection"))
    .orderBy(desc(sql`${hiringAudit.detail}->>'selectedDate'`), hiringCandidates.name);

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

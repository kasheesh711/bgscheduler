import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { hiringAudit, hiringCandidates } from "@/lib/db/schema";

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

  return <section id="owner-selections" aria-labelledby="owner-selections-title" className="rounded-xl border bg-card p-4 sm:p-6">
    <h2 id="owner-selections-title" className="text-lg font-semibold">Kevin’s candidate selections</h2>
    <p className="mt-1 text-sm text-muted-foreground">{picks.length} recorded decisions. Compare the latest intake score recorded before each pick with the cutoff in effect on the decision date. The dated snapshot preserves the score when the pick was logged.</p>
    {picks.length > 0 && <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm tabular-nums [&_td]:p-2 [&_th]:p-2 [&_tr]:border-b">
        <thead><tr>{["Decision date", "Candidate", "Decision", "Intake before pick", "Cutoff", "Score snapshot"].map(label =>
          <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{picks.map(pick => <tr key={pick.id}>
          <td>{pick.date}</td>
          <th scope="row">{pick.name}{pick.university && <span className="block font-normal">{pick.university}</span>}</th>
          <td>{pick.decision}</td>
          <td>{pick.priorScore ?? "No score recorded"}{pick.priorScoreDate && <small className="block">{pick.priorScoreDate}</small>}</td>
          <td>{pick.cutoff ?? "Unknown"}</td>
          <td>{pick.snapshotScore ?? "Unscored"}<small className="block">{pick.snapshotDate}</small></td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}

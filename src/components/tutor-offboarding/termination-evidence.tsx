import type { OffboardingDashboardData, OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { Disclosure, Panel, Tag, Upper } from "./atoms";
import { formatDayYear } from "./format";

/** OFF-15: owner-confirmed Sheet evidence is independent of the estimated likelihood and OFF-03/OFF-04/OFF-06 gates. */
export function TerminationBadge({ row }: { row: OffboardingPersonRow }) {
  return row.termination ? <Tag tone="red">Confirmed terminated</Tag> : null;
}

function checkedLabel(iso: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  return `Checked ${formatDayYear(iso)} · ${time} Bangkok time`;
}

function sourceRowUrl(sourceUrl: string, sourceRow: number): string {
  const url = new URL(sourceUrl);
  if (url.hostname === "docs.google.com" && url.pathname.startsWith("/spreadsheets/")) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    fragment.set("range", `D${sourceRow}:H${sourceRow}`);
    url.hash = fragment.toString();
  }
  return url.href;
}

export function TerminationDetail({ row }: { row: OffboardingPersonRow }) {
  const evidence = row.termination;
  if (!evidence) return null;
  return (
    <section className="rounded-md border border-conflict/30 bg-conflict/5 px-3 py-3">
      <TerminationBadge row={row} />
      <p className="mt-2 text-xs">Struck through in the Tutors sheet, confirmed by the owner.</p>
      <p className="mt-1 text-xs text-muted-foreground">{evidence.sourceName}</p>
      <a href={sourceRowUrl(evidence.sourceUrl, evidence.sourceRow)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs underline underline-offset-2">
        {`Source row ${evidence.sourceRow}`}
      </a>
      <p className="mt-1 text-xs text-muted-foreground">{checkedLabel(evidence.checkedAt)}</p>
      <p className="mt-2 text-xs text-muted-foreground">The removal checks below still apply.</p>
    </section>
  );
}

export function TerminationSourcePanel({ source }: { source: NonNullable<OffboardingDashboardData["terminationSource"]> }) {
  const warning = source.status === "stale" ? "Confirmation data is out of date. The badges reflect the last successful check."
    : source.status === "not_synced" ? "The Tutors sheet has not been checked yet. Confirmed terminations are unavailable."
    : source.status === "error" ? "The Tutors sheet could not be read. Any badges reflect the last successful check."
    : null;
  return (
    <Panel className="mt-4 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Upper>Confirmed terminations</Upper>
        <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline underline-offset-2">Tutors sheet</a>
      </div>
      {source.checkedAt ? (
        <>
          <p className="mt-1 text-sm font-medium">{`${source.matchedPeople} people matched from ${source.confirmedRows} confirmed sheet rows`}</p>
          <p className="mt-1 text-xs text-muted-foreground">{checkedLabel(source.checkedAt)}</p>
        </>
      ) : null}
      {warning ? <p role="status" className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-200">{warning}</p> : null}
      {source.unmatched.length ? (
        <div className="mt-3">
          <Disclosure title="Source rows needing review" count={source.unmatched.length}>
            <ul className="space-y-2 px-5 py-3 text-xs">
              {source.unmatched.map((row) => (
                <li key={row.sourceRow} className="break-words">
                  <span className="font-medium">{`${row.sourceName} · row ${row.sourceRow}`}</span>
                  <span className="block text-muted-foreground">{row.reason}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      ) : null}
    </Panel>
  );
}

import Image from "next/image";

import { DigitSafe } from "@/components/learning-plan/digit-safe";
import {
  ClassTable,
  PackagesTable,
  StatTile,
  SummaryTable,
} from "@/components/student-report/report-tables";
import { formatBangkokDateTime } from "@/lib/bangkok-time";

import type {
  BucketTotal,
  ParentReportPayload,
  SessionBucket,
} from "@/lib/student-report/types";

function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function totalFor(
  totals: readonly BucketTotal[],
  bucket: SessionBucket,
): BucketTotal {
  return (
    totals.find((total) => total.bucket === bucket) ?? {
      bucket,
      sessions: 0,
      hours: 0,
      credits: 0,
    }
  );
}

function TotalsGrid({ totals }: { totals: BucketTotal[] }) {
  const attended = totalFor(totals, "attended");
  const upcoming = totalFor(totals, "upcoming");

  return (
    <div className="grid grid-cols-4 gap-3">
      <StatTile
        value={formatNumber(attended.sessions)}
        label="Attended classes"
      />
      <StatTile
        value={formatNumber(attended.hours)}
        label="Hours attended"
      />
      <StatTile
        value={formatNumber(attended.credits)}
        label="Credits used"
        tone="orange"
      />
      <StatTile
        value={formatNumber(upcoming.sessions)}
        label="Upcoming classes"
      />
    </div>
  );
}

export function ReportDocument({ payload }: { payload: ParentReportPayload }) {
  const { meta } = payload;
  const snapshotAsOf = formatBangkokDateTime(meta.snapshotGeneratedAt);
  const generatedAt = formatBangkokDateTime(meta.generatedAt);
  const multiMonth =
    meta.window.fromDateKey.slice(0, 7) !==
    meta.window.toDateKey.slice(0, 7);

  return (
    <article className="begifted report-root">
      <header className="flex items-start justify-between border-b-2 border-begifted-orange-500 pb-4">
        <Image
          src="/brand/logo-horizontal.png"
          alt="BeGifted"
          width={194}
          height={76}
          preload
          className="h-11 w-auto"
        />
        <div className="pt-1 text-right">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-begifted-orange-600">
            Class &amp; Credit Statement
          </p>
          <p className="digits mt-1 text-sm font-semibold text-begifted-neutral-800">
            {meta.window.label}
          </p>
          <p className="digits mt-1 text-xs text-begifted-neutral-500">
            Data as of {snapshotAsOf}
          </p>
        </div>
      </header>

      {meta.floorWarning || meta.ceilingWarning ? (
        <div className="digits mt-6 border-l-4 border-begifted-orange-500 bg-begifted-orange-50 px-4 py-3 text-sm text-begifted-neutral-700">
          This statement window extends beyond the data held for this period
          (records cover {meta.snapshotFloorDateKey} – {meta.snapshotCeilingDateKey}).
          Classes outside that range are not shown.
        </div>
      ) : null}

      <div data-testid="combined-stat-tiles" className="mt-6">
        <TotalsGrid totals={payload.combined.bucketTotals} />
      </div>

      {payload.students.map((section, index) => {
        const classAndTeacherLines = section.summaries.filter((line) =>
          multiMonth
            ? ["class", "teacher", "month", "modality"].includes(
                line.dimension,
              )
            : line.dimension === "class" || line.dimension === "teacher",
        );
        const netCredit = formatNumber(section.ledger.netCredit);

        return (
          <section
            key={section.student.studentKey}
            data-testid="student-report-section"
            className={index > 0 ? "break-before-page pt-2" : undefined}
          >
            <div className="mt-10 flex items-center justify-between gap-4">
              <h2 className="begifted-display text-3xl">
                <DigitSafe text={section.student.studentName} />
              </h2>
              {section.student.code ? (
                <span className="digits shrink-0 rounded-full bg-begifted-blue-100 px-3 py-1 text-xs font-semibold text-begifted-blue-700">
                  {section.student.code}
                </span>
              ) : null}
            </div>

            <div className="mt-5">
              <TotalsGrid totals={section.bucketTotals} />
            </div>

            <div className="mt-8">
              <ClassTable rows={section.rows} />
            </div>

            <div className="mt-8">
              <SummaryTable
                lines={classAndTeacherLines}
                title="Summary by class & teacher"
              />
            </div>

            <div className="mt-8">
              <h3 className="begifted-display text-2xl">
                Package balances — as of <DigitSafe text={snapshotAsOf} />
              </h3>
              <PackagesTable packages={section.packages} />
            </div>

            <p className="digits mt-4 text-xs text-begifted-neutral-500">
              {section.ledger.entries} credit-ledger entries in this period · net{" "}
              {section.ledger.netCredit >= 0 ? "+" : ""}
              {netCredit} credits
            </p>
          </section>
        );
      })}

      <footer className="mt-12 border-t border-begifted-neutral-200 pt-4 text-center text-[11px] text-begifted-neutral-500">
        BeGifted Education · Generated{" "}
        <span className="digits">{generatedAt}</span> · Snapshot{" "}
        <span className="digits">{meta.snapshotId.slice(0, 8)}</span>
      </footer>
    </article>
  );
}

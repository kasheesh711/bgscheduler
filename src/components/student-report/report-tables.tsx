import { Fragment } from "react";

import { DigitSafe } from "@/components/learning-plan/digit-safe";

import type {
  ReportClassFeedback,
  ReportClassRow,
  ReportPackageRow,
  SessionBucket,
  SummaryLine,
} from "@/lib/student-report/types";

const HEADER_CELL_CLASS =
  "text-[10px] font-bold uppercase tracking-[0.12em] text-begifted-orange-600 border-b-2 border-begifted-neutral-900 pb-1 text-left";
const BODY_CELL_CLASS = "text-xs text-begifted-neutral-700 py-1";
const NUMERIC_CELL_CLASS =
  "text-right tabular-nums digits whitespace-nowrap";
const EMPTY_STATE_CLASS = "py-4 text-sm text-begifted-neutral-500";

function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function formatShortDate(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return dateKey;
  return `${Number(match[3])}/${Number(match[2])}`;
}

function statusTone(bucket: SessionBucket): string {
  switch (bucket) {
    case "attended":
      return "bg-begifted-blue-100 text-begifted-blue-700";
    case "upcoming":
      return "bg-begifted-neutral-100 text-begifted-neutral-600";
    case "ended-no-credit":
      return "bg-begifted-orange-50 text-begifted-orange-600";
    case "cancelled":
      return "border border-begifted-neutral-200 bg-begifted-neutral-50 text-begifted-neutral-600";
    default:
      return "border border-begifted-neutral-200 bg-white text-begifted-neutral-700";
  }
}

function EmptyState() {
  return <p className={EMPTY_STATE_CLASS}>No rows in this period.</p>;
}

const FEEDBACK_FIELDS: readonly {
  key: keyof ReportClassFeedback;
  label: string;
}[] = [
  { key: "topics", label: "Topics" },
  { key: "performance", label: "Performance" },
  { key: "improvement", label: "Needs work" },
  { key: "homework", label: "Homework" },
];

/** Full-width tutor-feedback sub-row rendered directly under a class row. */
function ClassFeedbackRow({
  feedback,
  stripeClass,
}: {
  feedback: ReportClassFeedback;
  stripeClass: string | undefined;
}) {
  return (
    <tr className={stripeClass} data-testid="class-feedback-row">
      <td colSpan={7} className="pt-0 pb-2 pl-3 align-top">
        {FEEDBACK_FIELDS.map(({ key, label }) =>
          feedback[key] === "" ? null : (
            <p
              key={key}
              className="text-[10px] leading-snug text-begifted-neutral-600 whitespace-pre-wrap"
            >
              <span className="font-semibold uppercase tracking-[0.08em] text-begifted-neutral-400">
                {label}:{" "}
              </span>
              {feedback[key]}
            </p>
          ),
        )}
      </td>
    </tr>
  );
}

export function StatTile({
  value,
  label,
  tone = "neutral",
}: {
  value: string;
  label: string;
  tone?: "neutral" | "orange";
}) {
  return (
    <div
      className={`rounded-[20px] ${
        tone === "orange"
          ? "bg-begifted-orange-50"
          : "bg-begifted-neutral-50"
      } p-4`}
    >
      <p className="digits text-3xl font-bold text-begifted-orange-500">
        {value}
      </p>
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-begifted-neutral-500">
        {label}
      </p>
    </div>
  );
}

export function ClassTable({ rows }: { rows: ReportClassRow[] }) {
  if (rows.length === 0) return <EmptyState />;

  const credits = rows.reduce(
    (total, row) => total + row.creditApplied,
    0,
  );
  const hasLedgerRows = rows.some((row) => row.source === "ledger");

  return (
    <>
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={HEADER_CELL_CLASS}>Date</th>
          <th className={HEADER_CELL_CLASS}>Time</th>
          <th className={HEADER_CELL_CLASS}>Class</th>
          <th className={HEADER_CELL_CLASS}>Mode</th>
          <th className={HEADER_CELL_CLASS}>Teacher</th>
          <th className={HEADER_CELL_CLASS}>Status</th>
          <th className={`${HEADER_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
            Credit
          </th>
        </tr>
      </thead>
      <tbody>
        {/* Striping is index-based (not nth-child) so a class row and its
            feedback sub-row always share one stripe. */}
        {rows.map((row, index) => {
          const stripeClass =
            index % 2 === 1 ? "bg-begifted-neutral-50" : undefined;
          return (
            <Fragment key={row.wiseSessionId}>
              <tr
                className={stripeClass}
                data-feedback-parent={row.feedback ? "" : undefined}
              >
                <td className={`${BODY_CELL_CLASS} digits whitespace-nowrap`}>
                  {formatShortDate(row.dateKey)} {row.weekday}
                </td>
                <td className={`${BODY_CELL_CLASS} digits whitespace-nowrap`}>
                  {row.startLabel}
                  {row.timeApproximate ? " †" : ""}
                </td>
                <td className={BODY_CELL_CLASS}>{row.classLabel}</td>
                <td className={BODY_CELL_CLASS}>{row.modality}</td>
                <td className={BODY_CELL_CLASS}>{row.teacher}</td>
                <td className={BODY_CELL_CLASS}>
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${statusTone(
                      row.bucket,
                    )}`}
                  >
                    {row.bucket}
                  </span>
                </td>
                <td className={`${BODY_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
                  {formatNumber(row.creditApplied)}
                </td>
              </tr>
              {row.feedback ? (
                <ClassFeedbackRow
                  feedback={row.feedback}
                  stripeClass={stripeClass}
                />
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="font-bold text-begifted-neutral-900 border-t-2 border-begifted-neutral-900">
          <td className="digits py-1 text-xs" colSpan={2}>
            Total · {rows.length} sessions
          </td>
          <td className="py-1 text-xs" colSpan={4} />
          <td className={`py-1 text-xs ${NUMERIC_CELL_CLASS}`}>
            {formatNumber(credits)}
          </td>
        </tr>
      </tfoot>
    </table>
    {hasLedgerRows ? (
      <p className="mt-2 text-[10px] text-begifted-neutral-500">
        † Reconstructed from the billing ledger; the time shown is the charge
        timestamp (approximate).
      </p>
    ) : null}
    </>
  );
}

export function SummaryTable({
  lines,
  title,
}: {
  lines: SummaryLine[];
  title: string;
}) {
  return (
    <div>
      <h3 className="begifted-display text-2xl">
        <DigitSafe text={title} />
      </h3>
      {lines.length === 0 ? (
        <EmptyState />
      ) : (
        <table className="mt-3 w-full border-collapse">
          <thead>
            <tr>
              <th className={HEADER_CELL_CLASS}>Teacher</th>
              <th className={`${HEADER_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
                Sessions
              </th>
              <th className={`${HEADER_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
                Hours
              </th>
              <th className={`${HEADER_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
                Credits
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={`${line.dimension}:${line.key}`}
                className="even:bg-begifted-neutral-50"
              >
                <td className={BODY_CELL_CLASS}>{line.key}</td>
                <td className={`${BODY_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
                  {formatNumber(line.sessions)}
                </td>
                <td className={`${BODY_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
                  {formatNumber(line.hours)}
                </td>
                <td className={`${BODY_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
                  {formatNumber(line.credits)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** True when any balance is not a whole 0.5-credit step (after 2dp rounding). */
function hasFractionalBalances(packages: ReportPackageRow[]): boolean {
  return packages.some((row) =>
    [
      row.totalCredits,
      row.consumedCredits,
      row.remainingCredits,
      row.availableCredits,
    ].some((value) => !Number.isInteger(Math.round(value * 100) / 100 * 2)),
  );
}

export function PackagesTable({
  packages,
}: {
  packages: ReportPackageRow[];
}) {
  if (packages.length === 0) return <EmptyState />;

  return (
    <>
    <table className="mt-3 w-full border-collapse">
      <thead>
        <tr>
          <th className={HEADER_CELL_CLASS}>Package</th>
          <th className={HEADER_CELL_CLASS}>Subject</th>
          <th className={HEADER_CELL_CLASS}>Type</th>
          <th className={`${HEADER_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
            Total
          </th>
          <th className={`${HEADER_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
            Consumed
          </th>
          <th className={`${HEADER_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
            Remaining
          </th>
          <th className={`${HEADER_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
            Available
          </th>
          <th className={`${HEADER_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
            Booked
          </th>
        </tr>
      </thead>
      <tbody>
        {packages.map((row, index) => (
          <tr
            key={`${row.packageName}:${row.subject}:${index}`}
            className="even:bg-begifted-neutral-50"
          >
            <td className={BODY_CELL_CLASS}>
              <span>{row.packageName}</span>
              {row.excludedReason ? (
                <span className="mt-0.5 block text-[10px] text-begifted-neutral-500">
                  {row.excludedReason}
                </span>
              ) : null}
            </td>
            <td className={BODY_CELL_CLASS}>{row.subject || "(none)"}</td>
            <td className={BODY_CELL_CLASS}>{row.classType || "(none)"}</td>
            <td className={`${BODY_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
              {formatNumber(row.totalCredits)}
            </td>
            <td className={`${BODY_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
              {formatNumber(row.consumedCredits)}
            </td>
            <td className={`${BODY_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
              {formatNumber(row.remainingCredits)}
            </td>
            <td className={`${BODY_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
              {formatNumber(row.availableCredits)}
            </td>
            <td className={`${BODY_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
              {formatNumber(row.bookedSessions)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {hasFractionalBalances(packages) ? (
      <p className="mt-2 text-[10px] text-begifted-neutral-500">
        Fractional balances mirror pro-rated credit top-ups recorded in Wise;
        per-class charges are always 0.5-credit steps.
      </p>
    ) : null}
    </>
  );
}

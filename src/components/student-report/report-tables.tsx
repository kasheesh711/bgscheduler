import { DigitSafe } from "@/components/learning-plan/digit-safe";

import type {
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

  const durationMinutes = rows.reduce(
    (total, row) => total + row.durationMinutes,
    0,
  );
  const credits = rows.reduce(
    (total, row) => total + row.creditApplied,
    0,
  );

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={HEADER_CELL_CLASS}>Date</th>
          <th className={HEADER_CELL_CLASS}>Time</th>
          <th className={`${HEADER_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
            Mins
          </th>
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
        {rows.map((row) => (
          <tr key={row.wiseSessionId} className="even:bg-begifted-neutral-50">
            <td className={`${BODY_CELL_CLASS} digits whitespace-nowrap`}>
              {formatShortDate(row.dateKey)} {row.weekday}
            </td>
            <td className={`${BODY_CELL_CLASS} digits whitespace-nowrap`}>
              {row.startLabel}
            </td>
            <td className={`${BODY_CELL_CLASS} ${NUMERIC_CELL_CLASS}`}>
              {formatNumber(row.durationMinutes)}
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
        ))}
      </tbody>
      <tfoot>
        <tr className="font-bold text-begifted-neutral-900 border-t-2 border-begifted-neutral-900">
          <td className="digits py-1 text-xs" colSpan={2}>
            Total · {rows.length} sessions
          </td>
          <td className={`py-1 text-xs ${NUMERIC_CELL_CLASS}`}>
            {formatNumber(durationMinutes)}
          </td>
          <td className="py-1 text-xs" colSpan={4} />
          <td className={`py-1 text-xs ${NUMERIC_CELL_CLASS}`}>
            {formatNumber(credits)}
          </td>
        </tr>
      </tfoot>
    </table>
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
              <th className={HEADER_CELL_CLASS}>Dimension</th>
              <th className={HEADER_CELL_CLASS}>Key</th>
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
                <td className={BODY_CELL_CLASS}>{line.dimension}</td>
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

export function PackagesTable({
  packages,
}: {
  packages: ReportPackageRow[];
}) {
  if (packages.length === 0) return <EmptyState />;

  return (
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
  );
}

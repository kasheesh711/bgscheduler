// ----------------------------------------------------------------------------
// Printable student monthly schedule (admin → PDF).
//
// Mirrors the learning-plan report: a bare (print) route, A4 sheet wrapper and
// a toolbar that calls window.print(). Landscape comes from the named
// `schedule-landscape` @page in student-schedule.css, so this route can print
// wide without flipping any other printable page in the app.
// ----------------------------------------------------------------------------

import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { PrintToolbar } from "@/components/learning-plan/print-toolbar";
import { ScheduleMonthCalendar } from "@/components/student-schedule/schedule-month-calendar";
import { getStudentMonthlySchedule } from "@/lib/student-schedule/data";
import { formatBangkokDateTime } from "@/lib/bangkok-time";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const robots = { index: false, follow: false };

const paramsSchema = z.object({
  studentKey: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

function parseParams(raw: Record<string, string | string[] | undefined>) {
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  return paramsSchema.safeParse({
    studentKey: first(raw.studentKey),
    month: first(raw.month),
  });
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const parsed = parseParams(await searchParams);
  if (!parsed.success) return { title: { absolute: "Student Schedule" }, robots };
  return {
    title: { absolute: `BeGifted Schedule — ${parsed.data.month}` },
    robots,
  };
}

function ReportShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-student-schedule-report
      className="schedule-scroll min-h-0 flex-1 overflow-y-auto bg-muted/40 print:bg-white"
    >
      {children}
    </div>
  );
}

function InvalidParams() {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold">That link doesn&apos;t look right</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The report needs a student and a month in YYYY-MM form.
      </p>
    </div>
  );
}

async function StudentScheduleReportBody({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  const parsed = parseParams(await searchParams);
  if (!parsed.success) {
    return <ReportShell><InvalidParams /></ReportShell>;
  }

  const payload = await getStudentMonthlySchedule(getDb(), {
    studentKey: parsed.data.studentKey,
    monthKey: parsed.data.month,
  });
  if (!payload) {
    return <ReportShell><InvalidParams /></ReportShell>;
  }

  return (
    <ReportShell>
      <PrintToolbar backHref="/student-schedule" backLabel="Back to Student Schedule" />
      <div className="schedule-report-root">
        <div className="schedule-sheet mx-auto my-8 max-w-[277mm] rounded-md bg-white p-[10mm] shadow-lg">
          <header className="mb-4 flex items-end justify-between border-b pb-3">
            <div>
              <h1 className="text-lg font-semibold text-black">
                {payload.student.studentName}
              </h1>
              <p className="text-sm text-neutral-600">
                Class schedule · {payload.monthLabel}
              </p>
            </div>
            <div className="text-right text-xs text-neutral-500">
              <div className="font-semibold text-neutral-700">BeGifted Education</div>
              <div>{formatBangkokDateTime(payload.generatedAt)}</div>
            </div>
          </header>
          <ScheduleMonthCalendar payload={payload} />
        </div>
      </div>
    </ReportShell>
  );
}

export default function StudentScheduleReportPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <Suspense fallback={<ReportShell><div className="min-h-screen" /></ReportShell>}>
      <StudentScheduleReportBody searchParams={searchParams} />
    </Suspense>
  );
}

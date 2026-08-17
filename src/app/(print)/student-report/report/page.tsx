// ----------------------------------------------------------------------------
// Printable parent class report (admin → PDF).
//
// Mirrors the learning-plan report: a bare (print) route, portrait A4 sheet
// (the app-wide default @page in learning-plans.css) and a toolbar that calls
// window.print(). Every failure mode renders a visible card — a statement
// must never print as a silently empty sheet.
// ----------------------------------------------------------------------------

import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { PrintToolbar } from "@/components/learning-plan/print-toolbar";
import { ReportDocument } from "@/components/student-report/report-document";
import { getParentClassReport } from "@/lib/student-report/db";
import {
  normalizeReportParams,
  reportParamsSchema,
} from "@/lib/student-report/params";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const robots = { index: false, follow: false };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const parsed = reportParamsSchema.safeParse(
    normalizeReportParams(await searchParams),
  );
  if (!parsed.success) {
    return { title: { absolute: "Parent Report" }, robots };
  }
  return {
    title: {
      absolute: `BeGifted Class Report — ${parsed.data.from} – ${parsed.data.to}`,
    },
    robots,
  };
}

function ReportShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-student-report
      className="begifted report-scroll min-h-0 flex-1 overflow-y-auto bg-begifted-neutral-100 print:bg-white"
    >
      {children}
    </div>
  );
}

function ErrorCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="eyebrow mb-3">Parent Report</p>
      <h1 className="begifted-display text-3xl">{title}</h1>
      <p className="mt-3 text-sm text-begifted-neutral-500">{detail}</p>
      <Link
        href="/student-report"
        className="mt-6 rounded-full bg-begifted-orange-500 px-6 py-2.5 text-sm font-semibold text-white shadow-begifted-md hover:bg-begifted-orange-600"
      >
        Back to Parent Report
      </Link>
    </div>
  );
}

async function StudentReportBody({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  const parsed = reportParamsSchema.safeParse(
    normalizeReportParams(await searchParams),
  );
  if (!parsed.success) {
    return (
      <ReportShell>
        <ErrorCard
          title="That link doesn’t look right"
          detail="The report needs at least one student and a from/to date range in YYYY-MM-DD form."
        />
      </ReportShell>
    );
  }

  const result = await getParentClassReport(getDb(), {
    studentKeys: parsed.data.students,
    from: parsed.data.from,
    to: parsed.data.to,
  });

  if (result.status === "no-snapshot") {
    return (
      <ReportShell>
        <ErrorCard
          title="No data snapshot available"
          detail="There is no active credit-control snapshot to report from. Wait for the next sync and try again."
        />
      </ReportShell>
    );
  }
  if (result.status === "students-not-found") {
    return (
      <ReportShell>
        <ErrorCard
          title="Some students were not found"
          detail={`These student keys are not on the active snapshot: ${result.missing.join(", ")}`}
        />
      </ReportShell>
    );
  }

  return (
    <ReportShell>
      <PrintToolbar backHref="/student-report" backLabel="Back to Parent Report" />
      <div className="report-root">
        <div className="report-sheet mx-auto my-8 max-w-[210mm] rounded-md bg-white p-[14mm] shadow-begifted-lg">
          <ReportDocument payload={result.payload} />
        </div>
      </div>
    </ReportShell>
  );
}

export default function StudentReportPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <Suspense
      fallback={
        <ReportShell>
          <div className="min-h-screen" />
        </ReportShell>
      }
    >
      <StudentReportBody searchParams={searchParams} />
    </Suspense>
  );
}

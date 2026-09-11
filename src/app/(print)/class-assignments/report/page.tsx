import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ClassroomPrintConflictError, loadClassroomPrintReport, printDateSchema, printRunsSchema, printViewSchema } from "@/lib/classrooms/print-report";
import { ClassroomPrintDocument, ClassroomPrintUnavailable } from "@/components/class-assignments/classroom-print-document";
import Link from "next/link";

export const metadata: Metadata = { title: { absolute: "BeGifted · Daily classroom assignments" }, robots: { index: false, follow: false } };
export const maxDuration = 180;
type Params = Promise<Record<string, string | string[] | undefined>>;

async function Report({ searchParams }: { searchParams: Params }) {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  if (session.user.allowedPages && !session.user.allowedPages.includes("/class-assignments")) redirect("/");
  const raw = await searchParams;
  const ids = printRunsSchema.safeParse(typeof raw.runIds === "string" ? raw.runIds.split(",") : []);
  const view = printViewSchema.safeParse(raw.view ?? "tutors");
  let error = "Choose one to seven saved daily assignments to print.";
  let report: Awaited<ReturnType<typeof loadClassroomPrintReport>> | undefined;
  if (ids.success && view.success) {
    try {
      report = await loadClassroomPrintReport(getDb(), ids.data);
    } catch (cause) {
      error = cause instanceof ClassroomPrintConflictError ? cause.message : "Student rosters could not be refreshed from Wise. Please retry.";
    }
  }
  if (report) {
    const missingDates = (typeof raw.missingDates === "string" ? raw.missingDates.split(",") : []).filter(date => printDateSchema.safeParse(date).success).slice(0, 7);
    return <ClassroomPrintDocument key={report.generatedAt} report={report} view={view.success ? view.data : "tutors"} missingDates={missingDates} />;
  }
  return <main className="begifted flex min-h-0 flex-1 items-center justify-center p-8"><div className="max-w-lg rounded-xl border p-8"><h1 className="begifted-display text-3xl">Classroom sheets unavailable</h1><ClassroomPrintUnavailable message={view.success ? error : "Choose By tutor or By room to print."} /><Link href="/class-assignments" className="underline">Back to Class Assignments</Link></div></main>;
}

export default function ClassroomReportPage(props: { searchParams: Params }) {
  return <Suspense fallback={<div className="p-8">Loading daily classroom sheets…</div>}><Report {...props} /></Suspense>;
}

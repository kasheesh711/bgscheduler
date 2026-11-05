import { Suspense } from "react";
import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { resolveTheaLink, loadTheaPrintReport } from "@/lib/classrooms/thea-weekend";
import { ClassroomPrintDocument } from "@/components/class-assignments/classroom-print-document";

export const metadata: Metadata = { title: "Thea · Weekend schedule", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const maxDuration = 180;

async function Report({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getDb();
  const request = await resolveTheaLink(db, token);
  if (!request) return <p data-thea-pdf-error>This schedule link is unavailable. Request a new link in BG The Loop.</p>;
  let report;
  try {
    report = await loadTheaPrintReport(db, request.runIds);
  } catch {
    return <p data-thea-pdf-error>Student rosters or saved assignments could not be verified. Request the schedule again.</p>;
  }
  return <><ClassroomPrintDocument report={report} view="rooms" pdf /><ClassroomPrintDocument report={report} view="tutors" pdf /></>;
}
export default function Page(props: { params: Promise<{ token: string }> }) {
  return <Suspense fallback={<p>Preparing weekend schedule…</p>}><Report {...props} /></Suspense>;
}

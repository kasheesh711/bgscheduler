// ----------------------------------------------------------------------------
// PUBLIC parent schedule page — the only unauthenticated page in the app that
// renders student data.
//
// Access is the token in the URL and nothing else, so:
//   • Every failure mode (malformed, unknown, expired, revoked) renders ONE
//     identical message. The page must never be usable as an oracle for which
//     tokens exist.
//   • The token grants exactly one (studentKey, monthKey); the schedule is
//     re-read live on each visit, so a link stays accurate as classes change
//     but can never widen its scope.
//   • noindex/nofollow, and the nickname is used in the heading rather than
//     the full legal name.
//
// Reachability requires the `/schedule/` prefix in src/middleware.ts.
// ----------------------------------------------------------------------------

import type { Metadata } from "next";
import { Suspense } from "react";

import { getDb } from "@/lib/db";
import { ScheduleMonthCalendar } from "@/components/student-schedule/schedule-month-calendar";
import { resolveStudentScheduleLink } from "@/lib/student-schedule/links";
import {
  getStudentMonthlySchedule,
  parseStudentDisplay,
} from "@/lib/student-schedule/data";
import { PUBLIC_PAGE_COPY, formatThaiMonth } from "@/lib/line/schedule-bot-copy";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import { todayBangkok } from "@/lib/room-capacity/dates";

export const metadata: Metadata = {
  title: { absolute: "BeGifted — ตารางเรียน" },
  robots: { index: false, follow: false },
};

type Params = Promise<{ token: string }>;

function ExpiredNotice() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-semibold">{PUBLIC_PAGE_COPY.brand}</h1>
      <p className="whitespace-pre-line text-sm text-muted-foreground">
        {PUBLIC_PAGE_COPY.expired}
      </p>
    </main>
  );
}

async function PublicScheduleBody({ params }: { params: Params }) {
  const { token } = await params;
  const db = getDb();

  const grant = await resolveStudentScheduleLink(db, token);
  // One response for every failure mode — do not branch this.
  if (!grant) return <ExpiredNotice />;

  const payload = await getStudentMonthlySchedule(db, {
    studentKey: grant.studentKey,
    monthKey: grant.monthKey,
  });
  if (!payload) return <ExpiredNotice />;

  const shortName = parseStudentDisplay(payload.student.studentName).shortName;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="mb-5 border-b pb-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {PUBLIC_PAGE_COPY.title}
        </p>
        <h1 className="mt-1 text-xl font-semibold">
          น้อง{shortName} · {formatThaiMonth(payload.monthKey)}
        </h1>
        <p className="text-sm text-muted-foreground">{payload.monthLabel}</p>
      </header>

      {payload.sessions.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          {PUBLIC_PAGE_COPY.emptyMonth}
        </p>
      ) : (
        <ScheduleMonthCalendar payload={payload} todayKey={todayBangkok()} />
      )}

      <footer className="mt-8 border-t pt-4 text-center text-xs text-muted-foreground">
        {PUBLIC_PAGE_COPY.brand} · {PUBLIC_PAGE_COPY.updatedPrefix}{" "}
        {formatBangkokDateTime(payload.generatedAt)}
      </footer>
    </main>
  );
}

export default function PublicSchedulePage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<div className="min-h-dvh" />}>
      <PublicScheduleBody params={params} />
    </Suspense>
  );
}

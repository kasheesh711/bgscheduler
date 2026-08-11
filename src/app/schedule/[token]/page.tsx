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
// The root layout's body is a fixed-height overflow-hidden flex shell, so this
// page must own its scrolling (min-h-0 flex-1 overflow-y-auto) or everything
// below the first viewport is clipped — the pattern documented in
// src/components/admissions/parent/parent-dashboard.tsx.
//
// Reachability requires the `/schedule/` prefix in src/middleware.ts.
// ----------------------------------------------------------------------------

import type { Metadata, Viewport } from "next";
import { Suspense } from "react";

import { getDb } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ParentScheduleAgenda } from "@/components/student-schedule/parent-schedule-agenda";
import { AgendaTodayScroller } from "@/components/student-schedule/agenda-today-scroller";
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

// viewportFit makes env(safe-area-inset-*) nonzero on notched phones; the
// themeColor is a hex approximation of --background oklch(0.985 0.005 85).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fbfaf7",
};

type Params = Promise<{ token: string }>;

function ExpiredNotice() {
  return (
    <main
      lang="th"
      className="font-thai flex min-h-0 w-full flex-1 items-center justify-center overflow-y-auto px-6 py-8"
    >
      <Card className="w-full max-w-sm gap-4 px-6 py-8 text-center">
        <h1 className="text-lg font-semibold">{PUBLIC_PAGE_COPY.brand}</h1>
        <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
          {PUBLIC_PAGE_COPY.expired}
        </p>
      </Card>
    </main>
  );
}

/** Mirrors the loaded layout so the reveal doesn't reflow. */
function ScheduleFallback() {
  return (
    <div className="min-h-0 w-full flex-1 overflow-hidden">
      <div className="border-b px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <div className="mx-auto max-w-screen-sm space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-6 w-52" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-screen-sm space-y-4 px-4 py-4">
        {[0, 1, 2].map((group) => (
          <div key={group} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-[4.5rem] w-full rounded-xl" />
            <Skeleton className="h-[4.5rem] w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
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
    <div
      lang="th"
      className="font-thai min-h-0 w-full flex-1 overflow-y-auto text-base"
    >
      <header className="sticky top-0 z-10 border-b bg-background/95 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="mx-auto flex max-w-screen-sm items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              {PUBLIC_PAGE_COPY.title}
            </p>
            <h1 className="mt-0.5 truncate text-lg leading-tight font-semibold">
              น้อง{shortName} · {formatThaiMonth(payload.monthKey)}
            </h1>
          </div>
          {payload.sessions.length > 0 && (
            <Badge variant="secondary" className="shrink-0 tabular-nums">
              {payload.sessions.length} {PUBLIC_PAGE_COPY.classUnit}
            </Badge>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-screen-sm px-4 py-4">
        {payload.sessions.length === 0 ? (
          <Card className="px-6 py-10 text-center text-sm text-muted-foreground">
            {PUBLIC_PAGE_COPY.emptyMonth}
          </Card>
        ) : (
          <>
            <ParentScheduleAgenda payload={payload} todayKey={todayBangkok()} />
            <AgendaTodayScroller />
          </>
        )}

        <footer className="mt-8 border-t pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground">
          {PUBLIC_PAGE_COPY.brand} · {PUBLIC_PAGE_COPY.updatedPrefix}{" "}
          {formatBangkokDateTime(payload.generatedAt)}
        </footer>
      </main>
    </div>
  );
}

export default function PublicSchedulePage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<ScheduleFallback />}>
      <PublicScheduleBody params={params} />
    </Suspense>
  );
}

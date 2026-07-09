import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  buildCaseCalendar,
  type CalendarItem,
} from "@/lib/admissions/calendar";
import { getCaseDetail } from "@/lib/admissions/cases";
import {
  listCaseTasks,
  type AdmissionsTaskDto,
} from "@/lib/admissions/checklists";
import {
  listApplicationEvents,
  type AdmissionsApplicationEventDto,
} from "@/lib/admissions/colleges";
import { roleAtLeast } from "@/lib/admissions/config";
import { listMeetings } from "@/lib/admissions/meetings";
import { listNotesForRole } from "@/lib/admissions/notes";
import {
  listCollegeDocs,
  listRecommenders,
  type AdmissionsCollegeDocDto,
  type AdmissionsRecommenderWithCollegesDto,
} from "@/lib/admissions/recommenders";
import { todayBangkok } from "@/lib/room-capacity/dates";
import {
  CaseDetailShell,
  CaseDetailSkeleton,
} from "@/components/admissions/case-detail-shell";
import type {
  AdmissionsCaseDetail,
  AdmissionsMeetingDto,
  AdmissionsNoteDto,
  CaseAccess,
} from "@/lib/admissions/types";

// Per-request membership checks + fresh reads on every navigation — this page
// deliberately does NOT use "use cache" (revocation must be instant, §2.2).

async function CaseDetailBody({ caseId }: { caseId: string }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    redirect("/login");
  }

  // Server-side access gate (design §2.2): membership is re-resolved from
  // Postgres on every request. Forbidden → back to the caseload (existence
  // never leaks to non-members); NotFound (admin-only) → 404.
  let access: CaseAccess;
  try {
    access = await requireCaseAccess(email, caseId, "parent");
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }
    if (error instanceof Error && error.message === "Forbidden") {
      redirect("/admissions");
    }
    if (error instanceof Error && error.message === "NotFound") {
      notFound();
    }
    throw error;
  }

  const isStaff = roleAtLeast(access.role, "counselor");
  // Checklist reads are student+ (design §4); parents consume the progress
  // rollup on the case detail instead of task rows. The calendar shares the
  // same student+ gate — parents see the family-visible deadline list only.
  const canViewChecklist = roleAtLeast(access.role, "student");

  // Current Bangkok month window ("YYYY-MM-01".."YYYY-MM-<last>") for the
  // Overview calendar sub-view; month navigation fetches other months
  // client-side from the calendar API.
  const calendarMonth = todayBangkok().slice(0, 7);
  const [calendarYear, calendarMonthNumber] = calendarMonth.split("-").map(Number);
  const calendarMonthLastDay = new Date(
    Date.UTC(calendarYear, calendarMonthNumber, 0),
  ).getUTCDate();

  let caseDetail: AdmissionsCaseDetail;
  let notes: AdmissionsNoteDto[];
  let meetings: AdmissionsMeetingDto[];
  let tasks: AdmissionsTaskDto[];
  let calendarItems: CalendarItem[];
  let recommenders: AdmissionsRecommenderWithCollegesDto[];
  let collegeDocs: AdmissionsCollegeDocDto[];
  const applicationEvents: Record<string, AdmissionsApplicationEventDto[]> = {};
  try {
    [caseDetail, notes, meetings, tasks, calendarItems, recommenders, collegeDocs] =
      await Promise.all([
        getCaseDetail(caseId),
        // Role-shaped: family readers only ever receive shared_with_family rows.
        listNotesForRole(caseId, access.role),
        // The meeting log is staff-only (design §4); family viewers get none.
        isStaff ? listMeetings(caseId) : Promise.resolve([]),
        canViewChecklist ? listCaseTasks(caseId) : Promise.resolve([]),
        canViewChecklist
          ? buildCaseCalendar(caseId, {
              from: `${calendarMonth}-01`,
              to: `${calendarMonth}-${String(calendarMonthLastDay).padStart(2, "0")}`,
            })
          : Promise.resolve([]),
        // Colleges/Applications data shares the checklist's student+ gate
        // (design §4) — parents get their projection on the parent dashboard.
        canViewChecklist ? listRecommenders(caseId) : Promise.resolve([]),
        canViewChecklist ? listCollegeDocs(caseId) : Promise.resolve([]),
      ]);

    // Decision chains (CM-43) hang off the college list ids, so they load
    // after the case detail resolves — one batched fan-out, oldest first.
    if (canViewChecklist && caseDetail.collegeList.length > 0) {
      const eventLists = await Promise.all(
        caseDetail.collegeList.map((item) => listApplicationEvents(item.id)),
      );
      caseDetail.collegeList.forEach((item, index) => {
        applicationEvents[item.id] = eventLists[index];
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message === "NotFound") {
      notFound();
    }
    throw error;
  }

  return (
    <CaseDetailShell
      caseDetail={caseDetail}
      meetings={meetings}
      notes={notes}
      tasks={tasks}
      calendarMonth={calendarMonth}
      calendarItems={calendarItems}
      recommenders={recommenders}
      collegeDocs={collegeDocs}
      applicationEvents={applicationEvents}
      viewerRole={access.role}
      viewerEmail={access.email}
    />
  );
}

export default async function AdmissionsCaseDetailPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;

  return (
    <Suspense fallback={<CaseDetailSkeleton />}>
      <CaseDetailBody caseId={caseId} />
    </Suspense>
  );
}

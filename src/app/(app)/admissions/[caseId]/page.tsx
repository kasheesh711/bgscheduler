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
  buildParentDashboard,
  type ParentDashboard,
} from "@/lib/admissions/parent-projection";
import {
  listCollegeDocs,
  listRecommenders,
  type AdmissionsCollegeDocDto,
  type AdmissionsRecommenderWithCollegesDto,
} from "@/lib/admissions/recommenders";
import {
  ADMISSIONS_SECTION_KEYS,
  getSectionState,
  type AdmissionsSectionStateDto,
} from "@/lib/admissions/sections";
import {
  getBestScores,
  type AdmissionsBestScore,
} from "@/lib/admissions/testing";
import { todayBangkok } from "@/lib/room-capacity/dates";
import {
  CaseDetailShell,
  CaseDetailSkeleton,
} from "@/components/admissions/case-detail-shell";
import { ParentDashboardView } from "@/components/admissions/parent/parent-dashboard";
import { StudentPortalShell } from "@/components/admissions/student/portal-shell";
import type {
  AdmissionsCaseDetail,
  AdmissionsMeetingDto,
  AdmissionsNoteDto,
  CaseAccess,
} from "@/lib/admissions/types";

// Per-request membership checks + fresh reads on every navigation — this page
// deliberately does NOT use "use cache" (revocation must be instant, §2.2;
// the parent projection must never be cached cross-user either). Student
// members get the mobile-first portal shell (design §5.2); parent members get
// ONLY the read-only parent dashboard built from the closed parent projection
// (design §5.3 — never the staff or student shells, fail-closed); counselors
// and admins get the staff case-detail shell.

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

  // ── Student portal branch (design §5.2, CM-120..122) ──
  // Students get the mobile-first portal: the case detail (which carries
  // thisWeek, phaseProgress, essays, activities, sittings, and section
  // summaries), checklist tasks, best scores (CM-82), and the full
  // self-report section states (CM-121 — the guided forms need definitions
  // + saved answers). Staff surfaces — meetings, notes, recommenders,
  // decision chains — are never queried for a student.
  if (access.role === "student") {
    let caseDetail: AdmissionsCaseDetail;
    let tasks: AdmissionsTaskDto[];
    let bestScores: AdmissionsBestScore[];
    let sectionStates: AdmissionsSectionStateDto[];
    try {
      [caseDetail, tasks, bestScores, sectionStates] = await Promise.all([
        getCaseDetail(caseId),
        listCaseTasks(caseId),
        getBestScores(caseId),
        Promise.all(
          ADMISSIONS_SECTION_KEYS.map((sectionKey) =>
            getSectionState(caseId, sectionKey),
          ),
        ),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message === "NotFound") {
        notFound();
      }
      throw error;
    }
    return (
      <StudentPortalShell
        caseDetail={caseDetail}
        tasks={tasks}
        bestScores={bestScores}
        sectionStates={sectionStates}
        viewerRole={access.role}
        viewerEmail={access.email}
      />
    );
  }

  // ── Parent dashboard branch (design §5.3, CM-130..131) ──
  // Parents receive ONLY the closed parent projection (§2.3): every field is
  // whitelisted field-by-field in buildParentDashboard, so staff commentary,
  // aid fields, and unreleased scores are structurally unreachable. The
  // staff/student shells below are never rendered for a parent (fail-closed).
  if (access.role === "parent") {
    let dashboard: ParentDashboard;
    try {
      dashboard = await buildParentDashboard(caseId);
    } catch (error) {
      if (error instanceof Error && error.message === "NotFound") {
        notFound();
      }
      throw error;
    }
    return <ParentDashboardView dashboard={dashboard} />;
  }

  // Staff branch (counselor/admin only from here on).
  const isStaff = roleAtLeast(access.role, "counselor");
  // Checklist reads are student+ (design §4). Only counselors/admins reach
  // this branch today (students and parents return above), but the gate stays
  // role-derived so a future role below "student" fails closed here too.
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
  let bestScores: AdmissionsBestScore[];
  let sectionStates: AdmissionsSectionStateDto[];
  const applicationEvents: Record<string, AdmissionsApplicationEventDto[]> = {};
  try {
    [
      caseDetail,
      notes,
      meetings,
      tasks,
      calendarItems,
      recommenders,
      collegeDocs,
      bestScores,
      sectionStates,
    ] =
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
        // Testing best scores + full self-report section states share the
        // same student+ gate (design §4); parents get released milestones
        // via their projection instead.
        canViewChecklist ? getBestScores(caseId) : Promise.resolve([]),
        canViewChecklist
          ? Promise.all(
              ADMISSIONS_SECTION_KEYS.map((sectionKey) =>
                getSectionState(caseId, sectionKey),
              ),
            )
          : Promise.resolve([]),
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
      bestScores={bestScores}
      sectionStates={sectionStates}
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

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AffectedClassesPanel,
  LeaveTimelinePanel,
  PreviewOnlyNotice,
  RequestInspector,
  RequestQueue,
} from "../leave-requests-panels";
import type {
  AffectedLineContact,
  AffectedSession,
  AffectedStudentContact,
  LeaveRequestDetail,
  LeaveRequestRow,
} from "../types";
import {
  affectedSessionFallbackText,
  buildNext14DayTimeline,
  buildListParams,
  buildTimelineBucketsFromRows,
  dateRangeForPreset,
  filterQueueRows,
  isTimelineDateSelected,
  isTimelineDateToday,
  pressureLabel,
  requestAlerts,
  sheetStatusMeta,
  statusLabel,
  statusToneClass,
  studentContactState,
} from "../view-model";

function leaveRow(overrides: Partial<LeaveRequestRow> = {}): LeaveRequestRow {
  return {
    id: overrides.id ?? "request-1",
    sourceRowNumber: overrides.sourceRowNumber ?? 124,
    sourceSubmittedAt: overrides.sourceSubmittedAt ?? "2026-05-31T14:02:00.000Z",
    tutorName: overrides.tutorName ?? "Kavin (Kavin) Diwan Singh",
    tutorEmail: overrides.tutorEmail ?? "kavin@example.com",
    tutorDisplayName: overrides.tutorDisplayName ?? "Kavin",
    matchConfidence: overrides.matchConfidence ?? "email",
    startDate: overrides.startDate ?? "2026-06-08",
    endDate: overrides.endDate ?? "2026-06-08",
    timePeriod: overrides.timePeriod ?? "Full Day",
    specificTimeText: overrides.specificTimeText ?? null,
    normalizationStatus: overrides.normalizationStatus ?? "ok",
    normalizationError: overrides.normalizationError ?? null,
    reportedAffectedClasses: overrides.reportedAffectedClasses ?? "1 class",
    sourceSheetStatus: overrides.sourceSheetStatus ?? null,
    workflowStatus: overrides.workflowStatus ?? "new",
    staffNote: overrides.staffNote ?? null,
    sheetWriteStatus: overrides.sheetWriteStatus ?? "not_required",
    sheetWriteError: overrides.sheetWriteError ?? null,
    affectedClassCount: overrides.affectedClassCount ?? 1,
    cancellationPreviewCount: overrides.cancellationPreviewCount ?? 0,
    unread: overrides.unread ?? true,
    updatedAt: overrides.updatedAt ?? "2026-06-01T00:48:00.000Z",
  };
}

function affectedSession(overrides: Partial<AffectedSession> = {}): AffectedSession {
  return {
    id: overrides.id ?? "affected-1",
    wiseClassId: overrides.wiseClassId ?? "LIVE-000123",
    wiseSessionId: overrides.wiseSessionId ?? "session-1",
    startTime: overrides.startTime ?? "2026-06-08T07:00:00.000Z",
    endTime: overrides.endTime ?? "2026-06-08T08:00:00.000Z",
    startMinute: overrides.startMinute ?? 840,
    endMinute: overrides.endMinute ?? 900,
    wiseStatus: overrides.wiseStatus ?? "Scheduled",
    sessionType: overrides.sessionType ?? "OFFLINE",
    location: overrides.location ?? "Room A",
    studentName: overrides.studentName ?? "Live Session - Math",
    studentCount: overrides.studentCount ?? 1,
    subject: overrides.subject ?? "Math",
    classType: overrides.classType ?? "1:1",
    title: overrides.title ?? "Live Session - Math",
    overlapMinutes: overrides.overlapMinutes ?? 60,
    cancelPreviewSelected: overrides.cancelPreviewSelected ?? true,
    students: overrides.students ?? [affectedStudent()],
  };
}

function lineContact(overrides: Partial<AffectedLineContact> = {}): AffectedLineContact {
  return {
    linkId: overrides.linkId ?? "link-1",
    contactId: overrides.contactId ?? "contact-1",
    lineUserId: overrides.lineUserId ?? "U11111111111111111111111111111111",
    displayName: overrides.displayName ?? "Mom Ada",
    linkedParentLabel: overrides.linkedParentLabel ?? "Parent Li",
    linkedStudentLabel: overrides.linkedStudentLabel ?? "Ada.Li",
    lineChatUrl: overrides.lineChatUrl ?? "https://chat.line.biz/U22222222222222222222222222222222/chat/U11111111111111111111111111111111",
  };
}

function affectedStudent(overrides: Partial<AffectedStudentContact> = {}): AffectedStudentContact {
  return {
    wiseStudentId: overrides.wiseStudentId ?? "student-1",
    studentKey: overrides.studentKey ?? "ada li::parent li",
    studentName: overrides.studentName ?? "Ada Li",
    parentName: overrides.parentName ?? "Parent Li",
    lineContacts: overrides.lineContacts ?? [lineContact()],
  };
}

function detail(overrides: Partial<LeaveRequestDetail["request"]> = {}): LeaveRequestDetail {
  return {
    request: {
      ...leaveRow(),
      rawValues: {},
      reason: "Personal leave",
      makeupOptions: "Thursdays after 3pm Friday all day",
      certificateUrl: null,
      situationText: null,
      daysNotice: 7,
      lateNotice: null,
      adminFee: null,
      emergencyUsed: 0,
      matchReason: null,
      ...overrides,
    },
    affectedSessions: [affectedSession()],
    activityLog: [{
      id: "log-1",
      actionType: "source_refreshed",
      status: "success",
      message: "Refreshed Form Responses 1 row 124.",
      errorMessage: null,
      createdByEmail: null,
      createdAt: "2026-06-01T00:48:00.000Z",
      requestPayload: {},
    }],
  };
}

describe("leave request view-model helpers", () => {
  it("filters action-needed rows from workflow and sheet state", () => {
    const rows = [
      leaveRow({ id: "new", workflowStatus: "new" }),
      leaveRow({ id: "review", workflowStatus: "needs_review" }),
      leaveRow({ id: "failed", workflowStatus: "done", sheetWriteStatus: "failed" }),
      leaveRow({ id: "done", workflowStatus: "done", sheetWriteStatus: "success" }),
    ];

    expect(filterQueueRows(rows, "action").map((row) => row.id)).toEqual(["new", "review", "failed"]);
  });

  it("labels workflow and sheet states with stable tones", () => {
    expect(statusLabel("needs_review")).toBe("Needs review");
    expect(statusToneClass("needs_review")).toContain("amber");
    expect(sheetStatusMeta("failed")).toMatchObject({
      label: "Failed",
      className: "text-red-700",
    });
  });

  it("builds query params from existing filter inputs", () => {
    const params = buildListParams({
      filter: "review",
      query: " Kavin ",
      datePreset: "today",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(params.get("status")).toBe("needs_review");
    expect(params.get("q")).toBe("Kavin");
    expect(params.get("startDate")).toBe("2026-06-01");
    expect(params.get("endDate")).toBe("2026-06-01");
  });

  it("keeps preset date ranges in Bangkok calendar days", () => {
    expect(dateRangeForPreset("week", new Date("2026-06-03T12:00:00.000Z"))).toEqual({
      startDate: "2026-06-01",
      endDate: "2026-06-07",
    });
  });

  it("builds next-14-day timeline buckets from visible rows and fills empty days", () => {
    const sparse = buildTimelineBucketsFromRows([
      leaveRow({ id: "day-1", startDate: "2026-06-01", affectedClassCount: 2, workflowStatus: "new" }),
      leaveRow({ id: "day-3", startDate: "2026-06-03", affectedClassCount: 4, workflowStatus: "done", sheetWriteStatus: "success" }),
    ]);
    const timeline = buildNext14DayTimeline(sparse, new Date("2026-06-01T01:00:00.000Z"));

    expect(timeline).toHaveLength(14);
    expect(timeline[0]).toMatchObject({ date: "2026-06-01", total: 1, affectedClasses: 2, needsAction: 1 });
    expect(timeline[1]).toMatchObject({ date: "2026-06-02", total: 0, affectedClasses: 0, needsAction: 0 });
    expect(timeline[2]).toMatchObject({ date: "2026-06-03", total: 1, affectedClasses: 4, needsAction: 0 });
  });

  it("keeps the 14-day strip continuous across month boundaries", () => {
    const timeline = buildNext14DayTimeline([], new Date("2026-03-31T01:00:00.000Z"));
    expect(timeline[0].date).toBe("2026-03-31");
    expect(timeline[1].date).toBe("2026-04-01");
    expect(timeline[13].date).toBe("2026-04-13");
  });

  it("labels timeline pressure and selected/today states explicitly", () => {
    const bucket = { date: "2026-06-01", total: 1, needsAction: 1, affectedClasses: 10 };
    expect(pressureLabel(0)).toBe("No class impact");
    expect(pressureLabel(2)).toBe("Low class impact");
    expect(pressureLabel(3)).toBe("Medium class impact");
    expect(pressureLabel(10)).toBe("High class impact");
    expect(isTimelineDateSelected(bucket, "2026-06-01")).toBe(true);
    expect(isTimelineDateToday(bucket, new Date("2026-06-01T01:00:00.000Z"))).toBe(true);
  });
});

describe("leave request UI panels", () => {
  it("renders an empty queue state", () => {
    const html = renderToStaticMarkup(
      <RequestQueue
        rows={[]}
        loading={false}
        filter="action"
        query=""
        datePreset="any"
        selectedId={null}
        onFilterChange={() => undefined}
        onQueryChange={() => undefined}
        onDatePresetChange={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain("No leave requests in this view");
  });

  it("renders the 14-day timeline as a compact contained rail", () => {
    const timeline = buildNext14DayTimeline(
      [{ date: "2026-06-02", total: 2, needsAction: 1, affectedClasses: 4 }],
      new Date("2026-06-01T01:00:00.000Z"),
    );
    const html = renderToStaticMarkup(
      <LeaveTimelinePanel buckets={timeline} selectedDate="2026-06-02" />,
    );

    expect(html).toContain("Next 14 days");
    expect(html).toContain("1 Jun - 14 Jun 2026");
    expect(html).toContain("No leave");
    expect(html).toContain("Req");
    expect(html).toContain("Cls");
    expect(html).toContain("1 Action");
    expect(html).toContain("needs admin work");
    expect(html).not.toContain("min-w-[900px]");
    expect(html).not.toContain("min-h-[176px]");
  });

  it("surfaces normalization, match, sheet, and overlap alerts", () => {
    const alertDetail = detail({
      matchConfidence: "unmatched",
      matchReason: "Tutor could not be matched to Wise.",
      normalizationError: "Missing leave date.",
      sheetWriteStatus: "failed",
      sheetWriteError: "Google Sheets writeback failed.",
    });

    expect(requestAlerts(alertDetail)).toEqual([
      "Missing leave date.",
      "Tutor could not be matched to Wise.",
      "Google Sheets writeback failed.",
      "1 Wise class overlaps with this leave.",
    ]);
  });

  it("renders selected affected count and preview-only policy copy", () => {
    const selected = new Set(["affected-1"]);
    const html = renderToStaticMarkup(
      <AffectedClassesPanel
        detail={detail()}
        loading={false}
        selectedAffected={selected}
        onToggle={() => undefined}
      />,
    );
    const notice = renderToStaticMarkup(<PreviewOnlyNotice selectedCount={1} />);

    expect(html).toContain("1 selected");
    expect(html).toContain("Ada Li");
    expect(html).toContain("Parent Li");
    expect(html).toContain("Open");
    expect(html).toContain("LIVE-000123");
    expect(notice).toContain("Preview only - no Wise mutation is sent.");
  });

  it("renders affected roster fallbacks and unverified LINE states", () => {
    const noLine = affectedStudent({ lineContacts: [] });
    expect(studentContactState(noLine)).toBe("No verified LINE link");

    const noRosterSession = affectedSession({ students: [] });
    expect(affectedSessionFallbackText(noRosterSession)).toBe("No student roster found; showing Wise session label");

    const html = renderToStaticMarkup(
      <AffectedClassesPanel
        detail={{ ...detail(), affectedSessions: [affectedSession({ students: [noLine] })] }}
        loading={false}
        selectedAffected={new Set()}
        onToggle={() => undefined}
      />,
    );

    expect(html).toContain("No verified LINE link");
  });

  it("renders every affected student for group classes", () => {
    const html = renderToStaticMarkup(
      <RequestInspector
        detail={{
          ...detail(),
          affectedSessions: [affectedSession({
            studentCount: 2,
            students: [
              affectedStudent({ studentName: "Ada Li", studentKey: "ada::parent", wiseStudentId: "student-1" }),
              affectedStudent({ studentName: "Ben Li", studentKey: "ben::parent", wiseStudentId: "student-2", lineContacts: [] }),
            ],
          })],
        }}
        loading={false}
        saving={false}
        detailStatus="new"
        sheetText="New"
        staffNote=""
        selectedAffected={new Set()}
        onStatusChange={() => undefined}
        onSheetTextChange={() => undefined}
        onStaffNoteChange={() => undefined}
        onSave={() => undefined}
        onRetrySheet={() => undefined}
        onToggleAffected={() => undefined}
        onPreviewCancel={() => undefined}
      />,
    );

    expect(html).toContain("Ada Li");
    expect(html).toContain("Ben Li");
    expect(html).toContain("No verified LINE link");
  });

  it("renders the guided inspector with no affected sessions", () => {
    const noOverlapDetail = {
      ...detail(),
      affectedSessions: [],
    };
    const html = renderToStaticMarkup(
      <RequestInspector
        detail={noOverlapDetail}
        loading={false}
        saving={false}
        detailStatus="new"
        sheetText="New"
        staffNote=""
        selectedAffected={new Set()}
        onStatusChange={() => undefined}
        onSheetTextChange={() => undefined}
        onStaffNoteChange={() => undefined}
        onSave={() => undefined}
        onRetrySheet={() => undefined}
        onToggleAffected={() => undefined}
        onPreviewCancel={() => undefined}
      />,
    );

    expect(html).toContain("Workflow decision");
    expect(html).toContain("No Wise sessions overlap this leave.");
    expect(html).toContain("Preview only - no Wise mutation is sent.");
  });
});

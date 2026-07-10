"use client";

// ----------------------------------------------------------------------------
// Admissions student portal shell (design §5.2, PRD CM-120..CM-122) — the
// mobile-first, single-column workspace a student lands on for their own case.
//
// View state lives in the URL (`?view=` + `?sub=`, mirroring the case
// shell's URL-as-source-of-truth `?tab=` pattern) so refresh/back/forward
// restore the active view. Navigation is a fixed bottom bar (5 items, ≥44px
// targets, safe-area padding) that is ADDITIVE to the shared AppNav top bar —
// students keep the top bar. Views: Home ("This Week" ranked actions,
// season-relevant phase rings, read-only announcements), Tasks
// (student-togglable checklist reusing checklist-tab's exported pure helpers
// + optimistic-tick pattern), Colleges (read-only — list composition is
// counselor-only, design §2.4), Essays (the shared EssaysView, student
// variant, CM-60..63), and More (case info + links + sign-out plus a stacked
// menu whose entries — Activities, Testing, Self-report sections, Resources —
// each open a full-screen sub-view with a back affordance, driven by `?sub=`).
//
// Write surface (design §2.4): every mutation in this shell is a student
// self-report surface — ticking their own tasks (owner === "student" via
// canToggleTask), their essay statuses, their activities, their test
// sittings, and their section forms; the APIs re-check membership + role on
// every request. No staff affordances (notes composer, member management,
// verification, custom tasks, profile editing, counselor stage, score
// release, section review) exist here.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GraduationCapIcon,
  HomeIcon,
  ListChecksIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PenLineIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import {
  ADMISSIONS_APP_ROUND_LABELS,
  type AdmissionsAppStatus,
} from "@/lib/admissions/shared/colleges";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { AcademicsPanel } from "../academics-panel";
import { ActivitiesView } from "../activities-view";
import { AwardsPanel } from "../awards-panel";
import { CollegeDetailsPanel } from "../college-details-panel";
import {
  canToggleTask,
  computeTaskProgress,
  groupTasksByPhase,
  isTaskOverdue,
  mergeTaskOverrides,
} from "../checklist-tab";
import { TASK_OWNER_LABELS } from "../custom-task-dialog";
import { NotificationPreferencesPanel } from "../communications-panel";
import { EssaysView, type EssayCollegeOption } from "../essays-view";
import { ResourcesPanel } from "../resources-panel";
import { SectionsList } from "../sections-list";
import { TestingView } from "../testing-view";
import { SharedFeedbackPanel } from "./shared-feedback-panel";
import type { AdmissionsTaskDto, AdmissionsTaskStatus } from "@/lib/admissions/checklists";
import type {
  AdmissionsApplicationEventDto,
  AdmissionsCollegeListRowDto,
} from "@/lib/admissions/colleges";
import type { AdmissionsResourceTopicGroup } from "@/lib/admissions/resources";
import type { AdmissionsSectionStateDto } from "@/lib/admissions/sections";
import type { AdmissionsPhaseProgress, ThisWeekActionKind } from "@/lib/admissions/student-home";
import type { AdmissionsBestScore } from "@/lib/admissions/testing";
import type {
  AdmissionsCaseStatus,
  AdmissionsStudentCaseDetail,
  CaseRole,
} from "@/lib/admissions/types";

// ── Views ───────────────────────────────────────────────────────────────

/** The 5 bottom-nav views in display order (design §5.2). */
export const STUDENT_VIEWS = [
  { key: "home", label: "Home", icon: HomeIcon },
  { key: "tasks", label: "Tasks", icon: ListChecksIcon },
  { key: "colleges", label: "Colleges", icon: GraduationCapIcon },
  { key: "essays", label: "Essays", icon: PenLineIcon },
  { key: "more", label: "More", icon: MoreHorizontalIcon },
] as const;

/** Stable student view key ("home" … "more"). */
export type StudentViewKey = (typeof STUDENT_VIEWS)[number]["key"];

const DEFAULT_STUDENT_VIEW: StudentViewKey = "home";

/** Max "This Week" actions shown on Home (CM-120: 3–5 ranked actions). */
export const THIS_WEEK_DISPLAY_LIMIT = 5;

/**
 * Resolves a raw `?view=` value to a known view key. Unknown or missing
 * values fall back to "home" (fail-closed — never guess a different view).
 */
export function resolveStudentView(raw: string | null): StudentViewKey {
  const match = STUDENT_VIEWS.find((view) => view.key === raw);
  return match ? match.key : DEFAULT_STUDENT_VIEW;
}

/**
 * Maps a "This Week" action kind to the view its tap target opens: checklist
 * tasks → Tasks, application deadlines → Colleges, essays → Essays, testing
 * and self-report-section nudges → More (the Testing and Sections sub-views
 * open from its stacked menu). Unknown kinds stay on Home (fail-closed).
 */
export function resolveActionView(kind: ThisWeekActionKind): StudentViewKey {
  return resolveActionDestination(kind).view;
}

export interface StudentActionDestination {
  view: StudentViewKey;
  sub?: MoreSubViewKey;
  item?: string;
}

/** Direct destination for a ranked home action, including More sub-views. */
export function resolveActionDestination(
  kind: ThisWeekActionKind,
  anchor?: string,
): StudentActionDestination {
  const item = anchor?.includes(":") ? anchor.slice(anchor.indexOf(":") + 1) : undefined;
  switch (kind) {
    case "task":
      return { view: "tasks", item };
    case "application":
      return { view: "colleges", item };
    case "essay":
      return { view: "essays", item };
    case "testing":
      return { view: "more", sub: "testing", item };
    case "section":
      return { view: "more", sub: "sections", item };
    default:
      return { view: DEFAULT_STUDENT_VIEW };
  }
}

// ── More sub-views ──────────────────────────────────────────────────────

/** The More view's stacked menu entries in display order (design §5.2). */
export const MORE_SUBVIEWS = [
  {
    key: "academics",
    label: "Academics",
    description: "Your counselor-verified GPA, curriculum, and transcript links.",
  },
  {
    key: "activities",
    label: "Activities",
    description: "Your Common App and UC activities list.",
  },
  {
    key: "awards",
    label: "Honors & Awards",
    description: "Recognition, Common App ranking, and UC narratives.",
  },
  {
    key: "testing",
    label: "Testing",
    description: "Test sittings, scores, and registration deadlines.",
  },
  {
    key: "sections",
    label: "Self-report sections",
    description: "Guided forms your counselor uses to get to know you.",
  },
  {
    key: "feedback",
    label: "Shared feedback",
    description: "Counselor notes explicitly shared with your family.",
  },
  {
    key: "resources",
    label: "Resources",
    description: "Helpful links curated by your counselors.",
  },
] as const;

/** Stable More sub-view key ("activities" | "testing" | "sections" | "resources"). */
export type MoreSubViewKey = (typeof MORE_SUBVIEWS)[number]["key"];

/**
 * Resolves a raw `?sub=` value to a known More sub-view key. Unknown or
 * missing values fall back to null — the stacked More menu (fail-closed —
 * never guess a sub-view).
 */
export function resolveMoreSubView(raw: string | null): MoreSubViewKey | null {
  const match = MORE_SUBVIEWS.find((entry) => entry.key === raw);
  return match ? match.key : null;
}

// ── Presentation labels ─────────────────────────────────────────────────

const CASE_STATUS_LABELS: Record<AdmissionsCaseStatus, string> = {
  active: "Active",
  committed: "Committed",
  completed: "Completed",
  withdrawn: "Withdrawn",
  archived: "Archived",
};

const APP_STATUS_LABELS: Record<AdmissionsAppStatus, string> = {
  researching: "Researching",
  applying: "Applying",
  submitted: "Submitted",
  complete: "Complete",
};

// ── Private helpers (file-local, mirroring the sibling shells) ──────────

/** "YYYY-MM-DD" → "D/M/YYYY" (repo-wide D/M convention); non-dates pass through. */
function formatDateOnly(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
}

/** ISO timestamp → "D/M/YYYY, HH:mm" on the Asia/Bangkok clock. */
function formatBangkokTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return fallback;
}

function readTaskFromPayload(payload: unknown): AdmissionsTaskDto | null {
  if (typeof payload === "object" && payload !== null && "task" in payload) {
    const task = (payload as { task?: unknown }).task;
    if (
      typeof task === "object" &&
      task !== null &&
      typeof (task as { id?: unknown }).id === "string"
    ) {
      return task as AdmissionsTaskDto;
    }
  }
  return null;
}

// ── Home view atoms ─────────────────────────────────────────────────────

/** Compact SVG progress ring for one season-relevant phase (CM-120). */
function PhaseRing({ ring }: { ring: AdmissionsPhaseProgress }) {
  const size = 64;
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - ring.percent / 100);
  return (
    <div data-testid="phase-ring" className="flex flex-col items-center gap-1">
      <div
        role="img"
        aria-label={`${ring.label}: ${ring.percent}% done`}
        className="relative"
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-muted"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className="stroke-primary"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-foreground">
          {ring.percent}%
        </span>
      </div>
      <span className="max-w-20 text-center text-xs leading-tight text-muted-foreground">
        {ring.label}
      </span>
    </div>
  );
}

// ── Home view ───────────────────────────────────────────────────────────

function StudentHomeView({
  caseDetail,
  onOpenAction,
}: {
  caseDetail: AdmissionsStudentCaseDetail;
  onOpenAction: (destination: StudentActionDestination) => void;
}) {
  const greetingName =
    caseDetail.student.preferredName ?? caseDetail.student.fullName;
  const actions = caseDetail.thisWeek.slice(0, THIS_WEEK_DISPLAY_LIMIT);

  return (
    <div className="space-y-4">
      <header className="px-1">
        <h1 className="text-lg font-semibold text-foreground">
          Hi, {greetingName}
        </h1>
        <p className="text-sm text-muted-foreground">
          {caseDetail.cohort.name} · Class of {caseDetail.cohort.graduationYear}
        </p>
      </header>

      {/* ── "This Week" ranked actions (CM-120) ── */}
      <Card>
        <CardHeader>
          <CardTitle>This Week</CardTitle>
          <CardDescription>Your next actions, most urgent first.</CardDescription>
        </CardHeader>
        <CardContent>
          {actions.length > 0 ? (
            <ul className="space-y-2">
              {actions.map((action) => (
                <li key={action.anchor}>
                  <button
                    type="button"
                    data-testid="this-week-action"
                    onClick={() =>
                      onOpenAction(resolveActionDestination(action.kind, action.anchor))
                    }
                    className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                      {action.title}
                    </span>
                    {action.dueDate ? (
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums",
                          action.overdue
                            ? "bg-conflict/10 font-medium text-conflict"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {formatDateOnly(action.dueDate)}
                        {action.overdue ? " · Overdue" : ""}
                      </span>
                    ) : (
                      <ChevronRightIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing due this week — check the Tasks view for what&apos;s next.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Season-relevant phase progress rings (CM-120) ── */}
      {caseDetail.phaseProgress.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Your progress</CardTitle>
            <CardDescription>
              Checklist progress for this season&apos;s phases.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-x-2 gap-y-3">
              {caseDetail.phaseProgress.map((ring) => (
                <PhaseRing key={ring.phase} ring={ring} />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Announcements (read-only, CM-90) ── */}
      <Card>
        <CardHeader>
          <CardTitle>Announcements</CardTitle>
        </CardHeader>
        <CardContent>
          {caseDetail.announcements.length > 0 ? (
            <ul className="space-y-3">
              {caseDetail.announcements.map((announcement) => (
                <li
                  key={announcement.id}
                  data-testid="announcement-row"
                  className="space-y-0.5"
                >
                  <p className="text-sm font-medium text-foreground">
                    {announcement.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatBangkokTimestamp(announcement.createdAt)}
                  </p>
                  <p className="text-sm whitespace-pre-wrap text-foreground">
                    {announcement.body}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No announcements yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Tasks view ──────────────────────────────────────────────────────────

function StudentTaskRow({
  task,
  viewerRole,
  todayIso,
  busy,
  onToggleStatus,
}: {
  task: AdmissionsTaskDto;
  viewerRole: CaseRole;
  todayIso: string;
  busy: boolean;
  onToggleStatus: (task: AdmissionsTaskDto) => void;
}) {
  const done = task.status === "done";
  const overdue = isTaskOverdue(task, todayIso);
  const toggleAllowed = canToggleTask(viewerRole, task);

  return (
    <li data-testid="student-task-row" className="rounded-lg border border-border/60">
      <label
        className={cn(
          "flex min-h-11 items-start gap-3 px-3 py-2.5",
          toggleAllowed && !busy ? "cursor-pointer" : "cursor-default",
        )}
      >
        <input
          type="checkbox"
          data-testid={`task-checkbox-${task.id}`}
          className="mt-0.5 size-5 shrink-0 accent-primary"
          checked={done}
          disabled={!toggleAllowed || busy}
          onChange={() => onToggleStatus(task)}
          aria-label={done ? `Mark ${task.title} not done` : `Mark ${task.title} done`}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-sm font-medium text-foreground",
              done && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {task.owner !== "student" ? (
              <span>{TASK_OWNER_LABELS[task.owner]} task</span>
            ) : null}
            {task.dueDate ? (
              <span
                data-testid={`task-due-${task.id}`}
                className={cn(overdue && "font-medium text-conflict")}
              >
                Due {formatDateOnly(task.dueDate)}
                {overdue ? " · Overdue" : ""}
              </span>
            ) : null}
          </span>
        </span>
      </label>
    </li>
  );
}

function StudentTasksView({
  caseId,
  tasks,
  viewerRole,
}: {
  caseId: string;
  tasks: AdmissionsTaskDto[];
  viewerRole: CaseRole;
}) {
  const router = useRouter();
  const todayIso = useMemo(() => todayBangkok(), []);

  const [overrides, setOverrides] = useState<Record<string, AdmissionsTaskDto | null>>({});
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const mergedTasks = useMemo(
    () => mergeTaskOverrides(tasks, overrides),
    [tasks, overrides],
  );
  const groups = useMemo(() => groupTasksByPhase(mergedTasks), [mergedTasks]);
  const liveProgress = useMemo(() => computeTaskProgress(mergedTasks), [mergedTasks]);

  const setTaskBusy = useCallback((taskId: string, busy: boolean) => {
    setBusyTaskIds((previous) => {
      const next = new Set(previous);
      if (busy) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }, []);

  // Optimistic status tick with rollback — the mobile mirror of
  // checklist-tab's handleToggleStatus (same API, same fail-closed
  // verification clearing when a task leaves "done").
  const handleToggleStatus = useCallback(
    async (task: AdmissionsTaskDto) => {
      if (!canToggleTask(viewerRole, task)) return;
      const nextStatus: AdmissionsTaskStatus =
        task.status === "done" ? "not_started" : "done";
      const hadOverride = Object.prototype.hasOwnProperty.call(overrides, task.id);
      const previousOverride = hadOverride ? overrides[task.id] : undefined;
      const optimistic: AdmissionsTaskDto = {
        ...task,
        status: nextStatus,
        ...(nextStatus !== "done" && task.verifiedAt !== null
          ? { verifiedAt: null, verifiedByEmail: null }
          : {}),
      };
      setActionError(null);
      setOverrides((previous) => ({ ...previous, [task.id]: optimistic }));
      setTaskBusy(task.id, true);
      try {
        const response = await fetch(`/api/admissions/cases/${caseId}/tasks`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "status",
            taskId: task.id,
            status: nextStatus,
          }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(readErrorMessage(payload, "Failed to update the task."));
        }
        const serverTask = readTaskFromPayload(payload);
        if (serverTask) {
          setOverrides((previous) => ({ ...previous, [serverTask.id]: serverTask }));
        }
        router.refresh();
      } catch (error) {
        // Roll back the optimistic tick.
        setOverrides((previous) => {
          const next = { ...previous };
          if (previousOverride === undefined) delete next[task.id];
          else next[task.id] = previousOverride;
          return next;
        });
        setActionError(
          error instanceof Error ? error.message : "Failed to update the task.",
        );
      } finally {
        setTaskBusy(task.id, false);
      }
    },
    [viewerRole, overrides, caseId, router, setTaskBusy],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Tasks</CardTitle>
          <CardDescription>
            {liveProgress.done}/{liveProgress.total} done · you can tick tasks
            assigned to you.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label="Checklist progress"
            aria-valuenow={liveProgress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${liveProgress.percent}%` }}
            />
          </div>
          <span className="text-sm font-medium text-foreground">
            {liveProgress.percent}%
          </span>
        </CardContent>
      </Card>

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {groups.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No checklist tasks yet — your counselor will set these up.
            </p>
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => {
          const phaseProgress = computeTaskProgress(group.tasks);
          return (
            <section
              key={group.key}
              aria-label={group.label}
              className="rounded-xl border border-border"
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className="flex-1 text-sm font-semibold text-foreground">
                  {group.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {phaseProgress.done}/{phaseProgress.total} done
                </span>
              </div>
              <ul className="space-y-2 px-3 pb-3">
                {group.tasks.map((task) => (
                  <StudentTaskRow
                    key={task.id}
                    task={task}
                    viewerRole={viewerRole}
                    todayIso={todayIso}
                    busy={busyTaskIds.has(task.id)}
                    onToggleStatus={(target) => void handleToggleStatus(target)}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

// ── Colleges view (read-only, design §2.4) ──────────────────────────────

function StudentCollegesView({
  caseId,
  colleges,
}: {
  caseId: string;
  colleges: AdmissionsCollegeListRowDto[];
}) {
  const todayIso = useMemo(() => todayBangkok(), []);
  const [eventsByCollege, setEventsByCollege] = useState<
    Record<string, AdmissionsApplicationEventDto[]>
  >({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      colleges.map(async (college) => {
        const response = await fetch(
          `/api/admissions/cases/${caseId}/colleges/${college.id}/events`,
        );
        const payload: unknown = await response.json().catch(() => null);
        const events = response.ok && payload && typeof payload === "object" && "events" in payload && Array.isArray((payload as { events?: unknown }).events)
          ? (payload as { events: AdmissionsApplicationEventDto[] }).events
          : [];
        return [college.id, events] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setEventsByCollege(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [caseId, colleges]);

  return (
    <div className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Colleges &amp; applications</CardTitle>
        <CardDescription>
          Decisions, events, and document completeness. Your counselor manages
          the official college list and application state.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {colleges.length > 0 ? (
          <ul className="space-y-2">
            {colleges.map((college) => {
              const overdue =
                college.deadline !== null &&
                college.deadline < todayIso &&
                (college.appStatus === "researching" ||
                  college.appStatus === "applying");
              const location = [college.city, college.stateAbbr]
                .filter((value): value is string => Boolean(value))
                .join(", ");
              return (
                <li
                  key={college.id}
                  data-testid="college-row"
                  className="space-y-1.5 rounded-lg border border-border/60 p-3"
                >
                  <p className="text-sm font-medium text-foreground">
                    {college.instName}
                  </p>
                  {location ? (
                    <p className="text-xs text-muted-foreground">{location}</p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">
                      {ADMISSIONS_APP_ROUND_LABELS[college.round]}
                    </Badge>
                    {college.deadline ? (
                      <Badge
                        className={
                          overdue
                            ? "bg-conflict/15 text-conflict"
                            : "bg-muted text-muted-foreground"
                        }
                      >
                        Due {formatDateOnly(college.deadline)}
                        {overdue ? " · Overdue" : ""}
                      </Badge>
                    ) : null}
                    <Badge variant="secondary">
                      {APP_STATUS_LABELS[college.appStatus]}
                    </Badge>
                  </div>
                  {college.completeness ? (
                    <div className="grid grid-cols-2 gap-1 rounded-md bg-muted/50 p-2 text-xs sm:grid-cols-4">
                      <span>
                        Recs {college.completeness.recsSubmitted}/
                        {college.completeness.recsTotal}
                      </span>
                      <span>
                        Transcript {college.completeness.transcriptSent ? "sent" : "pending"}
                      </span>
                      <span>
                        School report {college.completeness.schoolReportSent ? "sent" : "pending"}
                      </span>
                      <span>
                        Scores {college.completeness.scoreSendsSent > 0 ? "sent" : "pending"}
                      </span>
                    </div>
                  ) : null}
                  {(eventsByCollege[college.id] ?? []).length > 0 ? (
                    <div className="space-y-1 border-t border-border/60 pt-2">
                      <p className="text-xs font-medium text-muted-foreground">
                        Application events
                      </p>
                      <ul className="flex flex-wrap gap-1.5">
                        {eventsByCollege[college.id].map((event) => (
                          <li key={event.id}>
                            <Badge variant="outline">
                              {event.event.replace("_", " ")} · {formatDateOnly(event.eventDate)}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No colleges on your list yet — your counselor will add them.
          </p>
        )}
      </CardContent>
    </Card>
    <CollegeDetailsPanel
      caseId={caseId}
      colleges={colleges}
      viewerRole="student"
    />
    </div>
  );
}

// ── More view (stacked sub-view menu + case info + links + sign-out) ────

function StudentMoreView({
  caseDetail,
  viewerEmail,
  onOpenSubView,
}: {
  caseDetail: AdmissionsStudentCaseDetail;
  viewerEmail: string;
  onOpenSubView: (key: MoreSubViewKey) => void;
}) {
  const { student, cohort } = caseDetail;
  const counselors = caseDetail.counselors;
  const driveFolder = caseDetail.driveFolder;
  const router = useRouter();
  const [profileDraft, setProfileDraft] = useState({
    fullName: student.fullName,
    preferredName: student.preferredName ?? "",
    phone: student.phone ?? "",
    school: student.school ?? "",
    schoolCounselor: student.schoolCounselor ?? "",
  });
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setProfileBusy(true);
    setProfileMessage(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseDetail.caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedUpdatedAt: caseDetail.updatedAt,
          student: {
            fullName: profileDraft.fullName,
            preferredName: profileDraft.preferredName || null,
            phone: profileDraft.phone || null,
            school: profileDraft.school || null,
            schoolCounselor: profileDraft.schoolCounselor || null,
          },
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readErrorMessage(payload, "Profile could not be saved."));
      setProfileMessage("Profile saved.");
      router.refresh();
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : "Profile could not be saved.");
    } finally {
      setProfileBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Stacked sub-view menu (Activities / Testing / Sections) ── */}
      <Card>
        <CardHeader>
          <CardTitle>Your records</CardTitle>
          <CardDescription>
            Academics, activities, awards, testing, feedback, and resources.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {MORE_SUBVIEWS.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  data-testid={`more-menu-${entry.key}`}
                  onClick={() => onOpenSubView(entry.key)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-border/60 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {entry.label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {entry.description}
                    </span>
                  </span>
                  <ChevronRightIcon
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your case</CardTitle>
          <CardDescription>
            {cohort.name} · Class of {cohort.graduationYear} ·{" "}
            {CASE_STATUS_LABELS[caseDetail.status]}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Name</dt>
              <dd>{student.fullName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Email</dt>
              <dd>{student.studentEmail}</dd>
            </div>
            {student.school ? (
              <div>
                <dt className="text-xs text-muted-foreground">School</dt>
                <dd>{student.school}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-xs text-muted-foreground">
                Counselor{counselors.length > 1 ? "s" : ""}
              </dt>
              <dd>
                {counselors.length > 0
                  ? counselors.map((member) => member.email).join(", ")
                  : "Not assigned yet"}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card data-testid="student-profile-editor">
        <CardHeader>
          <CardTitle>Your profile</CardTitle>
          <CardDescription>Keep your contact and school details current.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={saveProfile}>
            <div className="grid gap-3 sm:grid-cols-2">
              {([
                ["fullName", "Full name", true],
                ["preferredName", "Preferred name", false],
                ["phone", "Phone", false],
                ["school", "School", false],
                ["schoolCounselor", "School counselor", false],
              ] as const).map(([field, label, required]) => (
                <label key={field} className="space-y-1 text-xs font-medium text-foreground">
                  {label}
                  <Input
                    required={required}
                    value={profileDraft[field]}
                    onChange={(event) => setProfileDraft((current) => ({
                      ...current,
                      [field]: event.target.value,
                    }))}
                  />
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={profileBusy}>
                {profileBusy ? "Saving…" : "Save profile"}
              </Button>
              {profileMessage ? <p role="status" className="text-xs text-muted-foreground">{profileMessage}</p> : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* ── Links ── */}
      <Card>
        <CardHeader>
          <CardTitle>Links</CardTitle>
        </CardHeader>
        <CardContent>
          {driveFolder ? (
            driveFolder.startsWith("http") ? (
              <a
                href={driveFolder}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <ExternalLinkIcon aria-hidden className="size-4" />
                Open your Drive folder
              </a>
            ) : (
              <p className="text-sm text-foreground">{driveFolder}</p>
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              No Drive folder linked yet.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Account ── */}
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Signed in as {viewerEmail}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/api/auth/signout"
            prefetch={false}
            className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <LogOutIcon aria-hidden className="size-4" />
            Sign out
          </Link>
        </CardContent>
      </Card>

      <NotificationPreferencesPanel caseId={caseDetail.caseId} compact />
    </div>
  );
}

// ── More sub-views (full-screen with a back affordance) ─────────────────

/** One full-screen More sub-view: back affordance + the shared feature view. */
function StudentMoreSubView({
  subView,
  caseDetail,
  bestScores,
  sectionStates,
  resourceGroups,
  viewerRole,
  onBack,
}: {
  subView: MoreSubViewKey;
  caseDetail: AdmissionsStudentCaseDetail;
  bestScores: AdmissionsBestScore[];
  sectionStates: AdmissionsSectionStateDto[];
  resourceGroups: AdmissionsResourceTopicGroup[];
  viewerRole: CaseRole;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <Button
        variant="ghost"
        size="sm"
        data-testid="more-back"
        className="min-h-11"
        onClick={onBack}
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        Back to More
      </Button>

      {subView === "activities" ? (
        <ActivitiesView
          caseId={caseDetail.caseId}
          activities={caseDetail.activities}
          viewerRole={viewerRole}
          variant="portal"
        />
      ) : null}

      {subView === "academics" ? (
        <AcademicsPanel
          caseId={caseDetail.caseId}
          viewerRole={viewerRole}
        />
      ) : null}

      {subView === "awards" ? (
        <AwardsPanel
          caseId={caseDetail.caseId}
          viewerRole={viewerRole}
        />
      ) : null}

      {subView === "testing" ? (
        <TestingView
          caseId={caseDetail.caseId}
          sittings={caseDetail.testSittings}
          bestScores={bestScores}
          viewerRole={viewerRole}
          variant="student"
        />
      ) : null}

      {subView === "sections" ? (
        <SectionsList
          caseId={caseDetail.caseId}
          sections={sectionStates}
          viewerRole={viewerRole}
          variant="student"
        />
      ) : null}

      {subView === "resources" ? (
        <ResourcesPanel groups={resourceGroups} viewerRole={viewerRole} />
      ) : null}

      {subView === "feedback" ? (
        <SharedFeedbackPanel caseId={caseDetail.caseId} />
      ) : null}
    </div>
  );
}

// ── Shell ───────────────────────────────────────────────────────────────

/** Props for the student portal shell — all data is server-fetched by the page. */
export interface StudentPortalShellProps {
  caseDetail: AdmissionsStudentCaseDetail;
  /** Live checklist tasks (the tasks API is student+). */
  tasks: AdmissionsTaskDto[];
  /** Best actual score per test type (getBestScores, CM-82). */
  bestScores: AdmissionsBestScore[];
  /** Full self-report section states (getSectionState per key, CM-121). */
  sectionStates: AdmissionsSectionStateDto[];
  /** Resource library topic groups (listResources, CM-92 — read-only here). */
  resourceGroups: AdmissionsResourceTopicGroup[];
  /** Per-case role from requireCaseAccess — "student" on this shell today. */
  viewerRole: CaseRole;
  viewerEmail: string;
}

/**
 * Student portal shell (design §5.2): mobile-first single column with a fixed
 * 5-item bottom nav (Home / Tasks / Colleges / Essays / More) driven by
 * `?view=` URL state (`?sub=` opens a More sub-view). 16px base font, ≥44px
 * touch targets, safe-area padding.
 */
export function StudentPortalShell({
  caseDetail,
  tasks,
  bestScores,
  sectionStates,
  resourceGroups,
  viewerRole,
  viewerEmail,
}: StudentPortalShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  // SSR-safe: useSearchParams() can be null outside a router provider.
  const searchParams = useSearchParams();
  const activeView = resolveStudentView(searchParams?.get("view") ?? null);
  // A `?sub=` only means something under More (fail-closed elsewhere).
  const activeSubView =
    activeView === "more"
      ? resolveMoreSubView(searchParams?.get("sub") ?? null)
      : null;

  // The EssaysView add-form link targets: the case's live college list.
  const collegeOptions = useMemo<EssayCollegeOption[]>(
    () =>
      caseDetail.collegeList.map((item) => ({
        id: item.id,
        instName: item.instName,
      })),
    [caseDetail.collegeList],
  );

  // ── View navigation (URL is the source of truth) ──
  const handleViewChange = useCallback(
    (key: StudentViewKey) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (key === DEFAULT_STUDENT_VIEW) params.delete("view");
      else params.set("view", key);
      // Switching (or re-tapping) a view always closes any open sub-view.
      params.delete("sub");
      params.delete("item");
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [searchParams, pathname, router],
  );

  // ── More sub-view navigation (same URL source-of-truth rule) ──
  const handleSubViewChange = useCallback(
    (key: MoreSubViewKey | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("view", "more");
      if (key === null) params.delete("sub");
      else params.set("sub", key);
      params.delete("item");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, pathname, router],
  );

  const handleActionOpen = useCallback(
    (destination: StudentActionDestination) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (destination.view === DEFAULT_STUDENT_VIEW) params.delete("view");
      else params.set("view", destination.view);
      if (destination.sub) params.set("sub", destination.sub);
      else params.delete("sub");
      if (destination.item) params.set("item", destination.item);
      else params.delete("item");
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [searchParams, pathname, router],
  );

  const activeLabel =
    STUDENT_VIEWS.find((view) => view.key === activeView)?.label ?? "Home";

  return (
    <div className="flex min-h-0 flex-1 flex-col text-base">
      {/* ── Scrollable single-column content ── */}
      <div className="flex-1 overflow-y-auto">
        <section
          aria-label={activeLabel}
          className="mx-auto w-full max-w-screen-sm pt-2 pb-28"
        >
          {activeView === "home" ? (
            <StudentHomeView
              caseDetail={caseDetail}
              onOpenAction={handleActionOpen}
            />
          ) : null}

          {activeView === "tasks" ? (
            <StudentTasksView
              caseId={caseDetail.caseId}
              tasks={tasks}
              viewerRole={viewerRole}
            />
          ) : null}

          {activeView === "colleges" ? (
            <StudentCollegesView
              caseId={caseDetail.caseId}
              colleges={caseDetail.collegeList}
            />
          ) : null}

          {activeView === "essays" ? (
            <EssaysView
              caseId={caseDetail.caseId}
              essays={caseDetail.essays}
              collegeOptions={collegeOptions}
              viewerRole={viewerRole}
              variant="student"
            />
          ) : null}

          {activeView === "more" ? (
            activeSubView !== null ? (
              <StudentMoreSubView
                subView={activeSubView}
                caseDetail={caseDetail}
                bestScores={bestScores}
                sectionStates={sectionStates}
                resourceGroups={resourceGroups}
                viewerRole={viewerRole}
                onBack={() => handleSubViewChange(null)}
              />
            ) : (
              <StudentMoreView
                caseDetail={caseDetail}
                viewerEmail={viewerEmail}
                onOpenSubView={handleSubViewChange}
              />
            )
          ) : null}
        </section>
      </div>

      {/* ── Fixed bottom nav (additive to the AppNav top bar) ── */}
      <nav
        aria-label="Student portal"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]"
      >
        <div className="mx-auto flex w-full max-w-screen-sm items-stretch">
          {STUDENT_VIEWS.map((view) => {
            const selected = view.key === activeView;
            const Icon = view.icon;
            return (
              <button
                key={view.key}
                type="button"
                aria-label={view.label}
                aria-current={selected ? "page" : undefined}
                data-testid={`student-nav-${view.key}`}
                onClick={() => handleViewChange(view.key)}
                className={cn(
                  "flex min-h-14 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                  selected
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden className="size-5" />
                <span className="text-[11px] leading-none font-medium">
                  {view.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

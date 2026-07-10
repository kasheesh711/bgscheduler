"use client";

// ----------------------------------------------------------------------------
// Admissions case detail shell (design §5.1) — sticky case header + tab bar.
//
// Tab state lives in the URL (`?tab=`, mirroring the us-universities shell's
// URL-as-source-of-truth pattern) so refresh/back/forward restore the active
// tab. All 10 tabs are implemented: Overview / Profile / Checklist /
// Colleges / Applications / Essays / Activities / Testing / Meetings /
// Notes. The Overview tab also hosts the upcoming-deadlines list (CM-102),
// the month-grid deadline calendar as a toggled sub-view (CM-100 — design
// §5.1 lists no Calendar tab), and the announcements panel (CM-90); the
// Profile tab hosts the self-report sections list (CM-121 — staff variant,
// so counselors can open a section and review it).
//
// Server data arrives as props from the page (no client cache): every
// successful mutation calls router.refresh() so the server component re-reads
// Postgres and re-hydrates the props. Profile edits carry expectedUpdatedAt
// (optimistic concurrency, design §6); a 409 renders a conflict banner with
// both versions. The notes composer has NO preselected visibility — submit is
// blocked until the author makes an explicit choice (design §3, CM-91).
// Writes are gated to counselor/admin viewers (design §2.4); parents/students
// get read-only surfaces here, and the API re-checks on every request anyway.
// ----------------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftIcon, CalendarIcon, LockIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { roleAtLeast } from "@/lib/admissions/config";
import {
  ADMISSIONS_TASK_OWNERS,
  type AdmissionsTaskOwner,
} from "@/lib/admissions/shared/meetings";
import { ActivitiesView } from "./activities-view";
import { AnnouncementsPanel } from "./announcements-panel";
import { ApplicationsTab } from "./applications-tab";
import { CalendarTab } from "./calendar-tab";
import { ChecklistTab } from "./checklist-tab";
import { CollegesTab } from "./colleges-tab";
import { EssaysView, type EssayCollegeOption } from "./essays-view";
import { SectionsList } from "./sections-list";
import { TestingView } from "./testing-view";
import type { CalendarItem } from "@/lib/admissions/calendar";
import type { AdmissionsTaskDto } from "@/lib/admissions/checklists";
import type { AdmissionsApplicationEventDto } from "@/lib/admissions/colleges";
import type { AdmissionsCollegeDocDto, AdmissionsRecommenderWithCollegesDto } from "@/lib/admissions/recommenders";
import type { AdmissionsSectionStateDto } from "@/lib/admissions/sections";
import type { AdmissionsBestScore } from "@/lib/admissions/testing";
import type {
  AdmissionsCaseDetail,
  AdmissionsCaseStatus,
  AdmissionsMeetingDto,
  AdmissionsNoteDto,
  AdmissionsNoteVisibility,
  AdmissionsStudentDto,
  CaseRole,
} from "@/lib/admissions/types";

// ── Tabs ────────────────────────────────────────────────────────────────

/** The 10 case tabs in canonical order (design §5.1). */
export const CASE_TABS = [
  { key: "overview", label: "Overview" },
  { key: "profile", label: "Profile" },
  { key: "checklist", label: "Checklist" },
  { key: "colleges", label: "Colleges" },
  { key: "applications", label: "Applications" },
  { key: "essays", label: "Essays" },
  { key: "activities", label: "Activities" },
  { key: "testing", label: "Testing" },
  { key: "meetings", label: "Meetings" },
  { key: "notes", label: "Notes" },
] as const;

/** Stable tab key ("overview" … "notes"). */
export type CaseTabKey = (typeof CASE_TABS)[number]["key"];

const DEFAULT_CASE_TAB: CaseTabKey = "overview";

/**
 * Resolves a raw `?tab=` value to a known tab key. Unknown or missing values
 * fall back to "overview" (fail-closed — never guess a different tab).
 */
export function resolveCaseTab(raw: string | null): CaseTabKey {
  const match = CASE_TABS.find((tab) => tab.key === raw);
  return match ? match.key : DEFAULT_CASE_TAB;
}

// ── Status presentation ─────────────────────────────────────────────────

const CASE_STATUS_LABELS: Record<AdmissionsCaseStatus, string> = {
  active: "Active",
  committed: "Committed",
  completed: "Completed",
  withdrawn: "Withdrawn",
  archived: "Archived",
};

const CASE_STATUS_CLASSES: Record<AdmissionsCaseStatus, string> = {
  active: "bg-primary/10 text-primary",
  committed: "bg-available/15 text-available",
  completed: "bg-secondary text-secondary-foreground",
  withdrawn: "bg-blocked/15 text-blocked",
  archived: "bg-muted text-muted-foreground",
};

// ── Pure helpers (exported for tests) ───────────────────────────────────

/**
 * Returns true when the notes composer may submit: a non-blank body AND an
 * explicit visibility choice. There is deliberately no default visibility
 * (design §3 — the admissions_notes column is NOT NULL with no default).
 */
export function canSubmitNote(
  body: string,
  visibility: AdmissionsNoteVisibility | null,
): boolean {
  return body.trim().length > 0 && visibility !== null;
}

/** Editable student profile fields as form strings ("" = empty/null). */
export interface ProfileFormValues {
  fullName: string;
  preferredName: string;
  phone: string;
  school: string;
  schoolCounselor: string;
  wiseStudentKey: string;
}

const PROFILE_FIELDS: { key: keyof ProfileFormValues; label: string }[] = [
  { key: "fullName", label: "Full name" },
  { key: "preferredName", label: "Preferred name" },
  { key: "phone", label: "Phone" },
  { key: "school", label: "School" },
  { key: "schoolCounselor", label: "School counselor" },
  { key: "wiseStudentKey", label: "Wise student key" },
];

/** Maps a student DTO to editable form values (nulls become ""). */
export function buildProfileFormValues(student: AdmissionsStudentDto): ProfileFormValues {
  return {
    fullName: student.fullName,
    preferredName: student.preferredName ?? "",
    phone: student.phone ?? "",
    school: student.school ?? "",
    schoolCounselor: student.schoolCounselor ?? "",
    wiseStudentKey: student.wiseStudentKey ?? "",
  };
}

/** A profile edit rejected with 409: the editor's values vs the server's. */
export interface ProfileConflict {
  yourVersion: ProfileFormValues;
  /** Latest server values when the 409 payload carried them, else null. */
  currentVersion: ProfileFormValues | null;
  /** Fresh concurrency token from the 409 payload, when present. */
  currentUpdatedAt: string | null;
}

/**
 * Parses a 409 response payload into a ProfileConflict (design §3: mutating
 * routes return 409 "with both versions" on an expectedUpdatedAt mismatch).
 *
 * 1. Defensively walk payload.current.student — every field is optional and
 *    non-string values are ignored (never trust the wire).
 * 2. When no student object is present, currentVersion is null and the banner
 *    falls back to a "reload to compare" message.
 */
export function parseProfileConflict(
  payload: unknown,
  yourVersion: ProfileFormValues,
): ProfileConflict {
  let currentVersion: ProfileFormValues | null = null;
  let currentUpdatedAt: string | null = null;

  if (typeof payload === "object" && payload !== null && "current" in payload) {
    const current = (payload as { current?: unknown }).current;
    if (typeof current === "object" && current !== null) {
      const record = current as Record<string, unknown>;
      if (typeof record.updatedAt === "string") currentUpdatedAt = record.updatedAt;
      const student = record.student;
      if (typeof student === "object" && student !== null) {
        const s = student as Record<string, unknown>;
        const read = (key: keyof ProfileFormValues): string =>
          typeof s[key] === "string" ? (s[key] as string) : "";
        currentVersion = {
          fullName: read("fullName"),
          preferredName: read("preferredName"),
          phone: read("phone"),
          school: read("school"),
          schoolCounselor: read("schoolCounselor"),
          wiseStudentKey: read("wiseStudentKey"),
        };
      }
    }
  }

  return { yourVersion, currentVersion, currentUpdatedAt };
}

/** "YYYY-MM-DD" → "D/M/YYYY" (repo-wide D/M convention); non-dates pass through. */
export function formatDateOnly(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
}

/** Comma-separated attendees → trimmed, de-blanked list. */
export function parseAttendees(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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

// ── Conflict banner (exported for tests) ────────────────────────────────

/**
 * Banner shown after a profile PATCH returns 409: both versions side by side,
 * differing fields highlighted, with "use latest" / "keep editing" actions.
 */
export function ProfileConflictBanner({
  conflict,
  onUseLatest,
  onDismiss,
}: {
  conflict: ProfileConflict;
  onUseLatest: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="profile-conflict-banner"
      className="rounded-lg border border-conflict/40 bg-conflict/10 p-3"
    >
      <p className="text-sm font-semibold text-foreground">Edit conflict</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        This profile changed while you were editing. Review both versions, then
        re-apply the edits you want to keep.
      </p>
      {conflict.currentVersion ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Field</th>
                <th className="py-1 pr-3 font-medium">Your version</th>
                <th className="py-1 font-medium">Latest version</th>
              </tr>
            </thead>
            <tbody>
              {PROFILE_FIELDS.map(({ key, label }) => {
                const yours = conflict.yourVersion[key];
                const latest = conflict.currentVersion![key];
                const differs = yours !== latest;
                return (
                  <tr key={key} className={cn("border-t border-border/60", differs && "font-medium")}>
                    <td className="py-1 pr-3 text-muted-foreground">{label}</td>
                    <td className="py-1 pr-3">{yours || "—"}</td>
                    <td className={cn("py-1", differs && "text-conflict")}>{latest || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-xs text-foreground">
          The latest values could not be loaded — reload the page to compare
          before saving again.
        </p>
      )}
      <div className="mt-2 flex gap-2">
        {conflict.currentVersion ? (
          <Button size="xs" variant="outline" onClick={onUseLatest}>
            Use latest version
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Keep my edits
        </Button>
      </div>
    </div>
  );
}

// ── Small presentational atoms ──────────────────────────────────────────

function FieldRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm", value ? "text-foreground" : "text-muted-foreground")}>
        {value || "—"}
      </dd>
    </div>
  );
}

function VisibilityBadge({ visibility }: { visibility: AdmissionsNoteVisibility }) {
  if (visibility === "staff_only") {
    return (
      <Badge className="bg-blocked/15 text-blocked">
        <LockIcon aria-hidden />
        Staff only
      </Badge>
    );
  }
  return <Badge variant="outline">Shared with family</Badge>;
}

const SELECT_CLASSES = cn(SELECT_FIELD_CLASSES, "h-8 w-full");

// ── Meeting form model ──────────────────────────────────────────────────

interface MeetingFormValues {
  meetingDate: string;
  mode: string;
  attendees: string;
  notes: string;
  nextMeetingDate: string;
}

interface ActionItemDraft {
  title: string;
  owner: AdmissionsTaskOwner;
  dueDate: string;
}

const EMPTY_MEETING_FORM: MeetingFormValues = {
  meetingDate: "",
  mode: "",
  attendees: "",
  notes: "",
  nextMeetingDate: "",
};

function buildMeetingFormValues(meeting: AdmissionsMeetingDto): MeetingFormValues {
  return {
    meetingDate: meeting.meetingDate,
    mode: meeting.mode ?? "",
    attendees: meeting.attendees.join(", "),
    notes: meeting.notes ?? "",
    nextMeetingDate: meeting.nextMeetingDate ?? "",
  };
}

// ── Shell ───────────────────────────────────────────────────────────────

/** Props for the case detail shell — all data is server-fetched by the page. */
export interface CaseDetailShellProps {
  caseDetail: AdmissionsCaseDetail;
  /** Empty for non-staff viewers (the page never fetches family meetings). */
  meetings: AdmissionsMeetingDto[];
  /** Already role-filtered by listNotesForRole on the server. */
  notes: AdmissionsNoteDto[];
  /** Live checklist tasks; empty for parent viewers (the tasks API is student+). */
  tasks: AdmissionsTaskDto[];
  /** Current Bangkok month ("YYYY-MM") the page fetched calendarItems for. */
  calendarMonth: string;
  /** buildCaseCalendar items for calendarMonth; empty for parent viewers. */
  calendarItems: CalendarItem[];
  /** Recommenders + links (CM-50/51); empty for parent viewers (student+ API). */
  recommenders: AdmissionsRecommenderWithCollegesDto[];
  /** College-doc rows (CM-46); empty for parent viewers (student+ API). */
  collegeDocs: AdmissionsCollegeDocDto[];
  /** Decision chains keyed by list item id (CM-43); empty for parent viewers. */
  applicationEvents: Record<string, AdmissionsApplicationEventDto[]>;
  /** Best actual score per test type (CM-82); empty for parent viewers. */
  bestScores: AdmissionsBestScore[];
  /** Full self-report section states (CM-121); empty for parent viewers. */
  sectionStates: AdmissionsSectionStateDto[];
  viewerRole: CaseRole;
  viewerEmail: string;
}

/**
 * Case detail workspace (design §5.1): sticky case header, 10-tab bar with
 * URL-driven state; every tab is implemented (Overview / Profile / Checklist /
 * Colleges / Applications / Essays / Activities / Testing / Meetings / Notes).
 */
export function CaseDetailShell({
  caseDetail,
  meetings,
  notes,
  tasks,
  calendarMonth,
  calendarItems,
  recommenders,
  collegeDocs,
  applicationEvents,
  bestScores,
  sectionStates,
  viewerRole,
  viewerEmail,
}: CaseDetailShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  // SSR-safe: useSearchParams() can be null outside a router provider.
  const searchParams = useSearchParams();
  const activeTab = resolveCaseTab(searchParams?.get("tab") ?? null);
  const isStaff = roleAtLeast(viewerRole, "counselor");
  // The calendar API is student+ (design §4); parents only get the
  // family-visible deadline list from the case detail payload.
  const canViewCalendar = roleAtLeast(viewerRole, "student");
  const [showCalendar, setShowCalendar] = useState(false);

  const { student, cohort } = caseDetail;

  // The case's live college list as {id, instName} options — the EssaysView
  // add-form link targets and the TestingView score-send display names.
  const collegeOptions = useMemo<EssayCollegeOption[]>(
    () =>
      caseDetail.collegeList.map((item) => ({
        id: item.id,
        instName: item.instName,
      })),
    [caseDetail.collegeList],
  );

  // ── Tab navigation (URL is the source of truth) ──
  const handleTabChange = useCallback(
    (key: CaseTabKey) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (key === DEFAULT_CASE_TAB) params.delete("tab");
      else params.set("tab", key);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [searchParams, pathname, router],
  );

  // ── Discard-confirmation dialog (destructive action guard) ──
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);

  // ── Profile edit state ──
  const initialProfile = useMemo(() => buildProfileFormValues(student), [student]);
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileFormValues>(initialProfile);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileConflict, setProfileConflict] = useState<ProfileConflict | null>(null);
  const [latestUpdatedAt, setLatestUpdatedAt] = useState(caseDetail.updatedAt);

  const profileDirty = PROFILE_FIELDS.some(
    ({ key }) => profileForm[key] !== initialProfile[key],
  );

  const startProfileEdit = useCallback(() => {
    setProfileForm(initialProfile);
    setProfileError(null);
    setProfileConflict(null);
    setLatestUpdatedAt(caseDetail.updatedAt);
    setEditingProfile(true);
  }, [initialProfile, caseDetail.updatedAt]);

  const closeProfileEdit = useCallback(() => {
    setEditingProfile(false);
    setProfileError(null);
    setProfileConflict(null);
  }, []);

  const handleProfileCancel = useCallback(() => {
    if (profileDirty) setPendingDiscard(() => closeProfileEdit);
    else closeProfileEdit();
  }, [profileDirty, closeProfileEdit]);

  const handleProfileSave = useCallback(async () => {
    if (!profileForm.fullName.trim()) {
      setProfileError("Full name is required.");
      return;
    }
    setProfileSaving(true);
    setProfileError(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseDetail.caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedUpdatedAt: latestUpdatedAt,
          student: {
            fullName: profileForm.fullName.trim(),
            preferredName: profileForm.preferredName.trim() || null,
            phone: profileForm.phone.trim() || null,
            school: profileForm.school.trim() || null,
            schoolCounselor: profileForm.schoolCounselor.trim() || null,
            wiseStudentKey: profileForm.wiseStudentKey.trim() || null,
          },
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409) {
        const conflict = parseProfileConflict(payload, profileForm);
        setProfileConflict(conflict);
        if (conflict.currentUpdatedAt) setLatestUpdatedAt(conflict.currentUpdatedAt);
        return;
      }
      if (!response.ok) {
        setProfileError(readErrorMessage(payload, "Failed to save profile."));
        return;
      }
      setEditingProfile(false);
      setProfileConflict(null);
      router.refresh();
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Failed to save profile.");
    } finally {
      setProfileSaving(false);
    }
  }, [profileForm, latestUpdatedAt, caseDetail.caseId, router]);

  // ── Meeting form state ──
  // null = closed; "create" = new meeting; otherwise the meetingId being edited.
  const [meetingFormTarget, setMeetingFormTarget] = useState<string | null>(null);
  const [meetingForm, setMeetingForm] = useState<MeetingFormValues>(EMPTY_MEETING_FORM);
  const [actionItems, setActionItems] = useState<ActionItemDraft[]>([]);
  const [meetingSaving, setMeetingSaving] = useState(false);
  const [meetingError, setMeetingError] = useState<string | null>(null);

  const meetingBaseline = useMemo(() => {
    if (meetingFormTarget === null || meetingFormTarget === "create") {
      return EMPTY_MEETING_FORM;
    }
    const existing = meetings.find((meeting) => meeting.id === meetingFormTarget);
    return existing ? buildMeetingFormValues(existing) : EMPTY_MEETING_FORM;
  }, [meetingFormTarget, meetings]);

  const meetingDirty =
    (Object.keys(meetingForm) as (keyof MeetingFormValues)[]).some(
      (key) => meetingForm[key] !== meetingBaseline[key],
    ) || actionItems.length > 0;

  const openMeetingForm = useCallback(
    (target: "create" | AdmissionsMeetingDto) => {
      if (target === "create") {
        setMeetingForm(EMPTY_MEETING_FORM);
        setMeetingFormTarget("create");
      } else {
        setMeetingForm(buildMeetingFormValues(target));
        setMeetingFormTarget(target.id);
      }
      setActionItems([]);
      setMeetingError(null);
    },
    [],
  );

  const closeMeetingForm = useCallback(() => {
    setMeetingFormTarget(null);
    setMeetingError(null);
    setActionItems([]);
  }, []);

  const handleMeetingCancel = useCallback(() => {
    if (meetingDirty) setPendingDiscard(() => closeMeetingForm);
    else closeMeetingForm();
  }, [meetingDirty, closeMeetingForm]);

  const handleMeetingSubmit = useCallback(async () => {
    if (!meetingForm.meetingDate) {
      setMeetingError("Meeting date is required.");
      return;
    }
    if (actionItems.some((item) => !item.title.trim())) {
      setMeetingError("Every action item needs a title.");
      return;
    }
    setMeetingSaving(true);
    setMeetingError(null);
    try {
      const isCreate = meetingFormTarget === "create";
      const shared = {
        meetingDate: meetingForm.meetingDate,
        mode: meetingForm.mode.trim() || null,
        attendees: parseAttendees(meetingForm.attendees),
        notes: meetingForm.notes.trim() || null,
        nextMeetingDate: meetingForm.nextMeetingDate || null,
      };
      const response = await fetch(
        `/api/admissions/cases/${caseDetail.caseId}/meetings`,
        {
          method: isCreate ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isCreate
              ? {
                  ...shared,
                  actionItems: actionItems.map((item) => ({
                    title: item.title.trim(),
                    owner: item.owner,
                    dueDate: item.dueDate || null,
                  })),
                }
              : { meetingId: meetingFormTarget, ...shared },
          ),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setMeetingError(readErrorMessage(payload, "Failed to save meeting."));
        return;
      }
      closeMeetingForm();
      router.refresh();
    } catch (error) {
      setMeetingError(error instanceof Error ? error.message : "Failed to save meeting.");
    } finally {
      setMeetingSaving(false);
    }
  }, [meetingForm, actionItems, meetingFormTarget, caseDetail.caseId, closeMeetingForm, router]);

  // ── Notes composer state ──
  const [noteBody, setNoteBody] = useState("");
  // Deliberately null — the author must make an explicit visibility choice.
  const [noteVisibility, setNoteVisibility] = useState<AdmissionsNoteVisibility | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const handleNoteSubmit = useCallback(async () => {
    if (!canSubmitNote(noteBody, noteVisibility)) {
      setNoteError("Write a note and choose who can see it before posting.");
      return;
    }
    setNoteSaving(true);
    setNoteError(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseDetail.caseId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: noteBody, visibility: noteVisibility }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setNoteError(readErrorMessage(payload, "Failed to post note."));
        return;
      }
      setNoteBody("");
      setNoteVisibility(null);
      router.refresh();
    } catch (error) {
      setNoteError(error instanceof Error ? error.message : "Failed to post note.");
    } finally {
      setNoteSaving(false);
    }
  }, [noteBody, noteVisibility, caseDetail.caseId, router]);

  // ── Derived header/overview values ──
  const counselors = caseDetail.members.filter(
    (member) => member.role === "counselor" && member.status === "active",
  );
  const displayName = student.preferredName
    ? `${student.fullName} (${student.preferredName})`
    : student.fullName;
  const lastMeeting = meetings.length > 0 ? meetings[0] : null;
  const recentNotes = notes.slice(0, 3);

  return (
    // min-h-0 flex-1 overflow-y-auto: the (app) layout's <main> is a
    // fixed-height overflow-hidden flex column, so the shell must own its
    // scrolling — this also gives the sticky header a scrolling ancestor.
    <div className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto px-4 pb-10">
      {/* ── Sticky case header + tab bar ── */}
      <header className="sticky top-0 z-30 -mx-4 border-b border-border bg-background/95 px-4 pt-3 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href="/admissions"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeftIcon aria-hidden className="size-3.5" />
              All cases
            </Link>
            <h1 className="mt-0.5 truncate text-lg font-semibold text-foreground">
              {displayName}
            </h1>
            <p className="text-xs text-muted-foreground">
              {counselors.length > 0
                ? `Counselor${counselors.length > 1 ? "s" : ""}: ${counselors
                    .map((member) => member.email)
                    .join(", ")}`
                : "No active counselor"}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 pt-4">
            <Badge variant="outline">
              {cohort.name} · {cohort.graduationYear}
            </Badge>
            <Badge className={CASE_STATUS_CLASSES[caseDetail.status]}>
              {CASE_STATUS_LABELS[caseDetail.status]}
            </Badge>
            {caseDetail.committedCollegeName ? (
              <Badge className="bg-accent text-accent-foreground">
                Committed: {caseDetail.committedCollegeName}
              </Badge>
            ) : null}
          </div>
        </div>
        <nav
          role="tablist"
          aria-label="Case sections"
          className="mt-2 flex gap-1 overflow-x-auto pb-2"
        >
          {CASE_TABS.map((tab) => {
            const selected = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                id={`case-tab-${tab.key}`}
                aria-selected={selected}
                aria-controls={`case-panel-${tab.key}`}
                onClick={() => handleTabChange(tab.key)}
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  selected
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>

      {/* ── Active panel ── */}
      <main
        role="tabpanel"
        id={`case-panel-${activeTab}`}
        aria-labelledby={`case-tab-${activeTab}`}
        className="mt-4"
      >
        {activeTab === "overview" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Status</CardTitle>
                <CardDescription>
                  {CASE_STATUS_LABELS[caseDetail.status]} since{" "}
                  {formatBangkokTimestamp(caseDetail.statusChangedAt)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p>
                  Checklist progress:{" "}
                  <span className="font-medium">{caseDetail.progressPercent}%</span>
                </p>
                <p className="text-muted-foreground">
                  {caseDetail.progress.done}/{caseDetail.progress.total} tasks
                  done · {caseDetail.progress.verifiedCount} verified — details
                  in the Checklist tab.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Upcoming deadlines</CardTitle>
                {canViewCalendar ? (
                  <CardAction>
                    <Button
                      size="xs"
                      variant="outline"
                      data-testid="calendar-toggle"
                      aria-expanded={showCalendar}
                      onClick={() => setShowCalendar((previous) => !previous)}
                    >
                      <CalendarIcon aria-hidden />
                      {showCalendar ? "Hide calendar" : "Show calendar"}
                    </Button>
                  </CardAction>
                ) : null}
              </CardHeader>
              <CardContent className="text-sm">
                {caseDetail.upcomingDeadlines.length > 0 ? (
                  <ul className="space-y-1.5">
                    {caseDetail.upcomingDeadlines.map((item) => (
                      <li
                        key={item.id}
                        data-testid="upcoming-deadline"
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="min-w-0 truncate">{item.title}</span>
                        <span
                          className={cn(
                            "shrink-0 text-xs tabular-nums",
                            item.overdue
                              ? "font-medium text-conflict"
                              : "text-muted-foreground",
                          )}
                        >
                          {formatDateOnly(item.date)}
                          {item.overdue ? " · Overdue" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">
                    No open deadlines — dated checklist items appear here.
                  </p>
                )}
              </CardContent>
            </Card>
            {canViewCalendar && showCalendar ? (
              <div className="md:col-span-2">
                <CalendarTab
                  caseId={caseDetail.caseId}
                  initialMonth={calendarMonth}
                  initialItems={calendarItems}
                />
              </div>
            ) : null}
            <Card>
              <CardHeader>
                <CardTitle>Last meeting</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {caseDetail.lastMeetingDate ? (
                  <>
                    <p>
                      <CalendarIcon aria-hidden className="mr-1 inline size-3.5" />
                      {formatDateOnly(caseDetail.lastMeetingDate)}
                    </p>
                    {isStaff && lastMeeting?.nextMeetingDate ? (
                      <p className="text-muted-foreground">
                        Next planned: {formatDateOnly(lastMeeting.nextMeetingDate)}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-muted-foreground">No meetings logged yet.</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Recent notes</CardTitle>
              </CardHeader>
              <CardContent>
                {recentNotes.length > 0 ? (
                  <ul className="space-y-2">
                    {recentNotes.map((note) => (
                      <li key={note.id} className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {note.authorEmail} · {formatBangkokTimestamp(note.createdAt)}
                          </span>
                          <VisibilityBadge visibility={note.visibility} />
                        </div>
                        <p className="line-clamp-2 text-sm">{note.body}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No notes yet — add the first one in the Notes tab.
                  </p>
                )}
              </CardContent>
            </Card>
            <div className="md:col-span-2">
              <AnnouncementsPanel
                caseId={caseDetail.caseId}
                cohortId={cohort.id}
                cohortName={cohort.name}
                announcements={caseDetail.announcements}
                viewerRole={viewerRole}
              />
            </div>
          </div>
        ) : null}

        {activeTab === "profile" ? (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Student profile</CardTitle>
                <CardDescription>
                  Contact and school details captured at case creation.
                </CardDescription>
                {isStaff && !editingProfile ? (
                  <CardAction>
                    <Button size="sm" variant="outline" onClick={startProfileEdit}>
                      <PencilIcon aria-hidden />
                      Edit profile
                    </Button>
                  </CardAction>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-3">
                {profileConflict ? (
                  <ProfileConflictBanner
                    conflict={profileConflict}
                    onUseLatest={() => {
                      if (profileConflict.currentVersion) {
                        setProfileForm(profileConflict.currentVersion);
                      }
                      setProfileConflict(null);
                    }}
                    onDismiss={() => setProfileConflict(null)}
                  />
                ) : null}
                {editingProfile ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleProfileSave();
                    }}
                    className="space-y-3"
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      {PROFILE_FIELDS.map(({ key, label }) => (
                        <label key={key} className="space-y-1 text-xs font-medium text-foreground">
                          {label}
                          {key === "fullName" ? (
                            <span aria-hidden className="text-destructive">
                              {" "}
                              *
                            </span>
                          ) : null}
                          <Input
                            value={profileForm[key]}
                            onChange={(event) =>
                              setProfileForm((previous) => ({
                                ...previous,
                                [key]: event.target.value,
                              }))
                            }
                          />
                        </label>
                      ))}
                      <div className="space-y-1 text-xs font-medium text-foreground">
                        Student email
                        <Input value={student.studentEmail} disabled aria-label="Student email (read-only)" />
                        <p className="text-[11px] font-normal text-muted-foreground">
                          Email changes go through membership management.
                        </p>
                      </div>
                    </div>
                    {profileError ? (
                      <p role="alert" className="text-sm text-destructive">
                        {profileError}
                      </p>
                    ) : null}
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={profileSaving}>
                        {profileSaving ? "Saving…" : "Save changes"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={handleProfileCancel}
                        disabled={profileSaving}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                    <FieldRow label="Full name" value={student.fullName} />
                    <FieldRow label="Preferred name" value={student.preferredName} />
                    <FieldRow label="Student email" value={student.studentEmail} />
                    <FieldRow label="Phone" value={student.phone} />
                    <FieldRow label="School" value={student.school} />
                    <FieldRow label="School counselor" value={student.schoolCounselor} />
                    <FieldRow label="Wise student key" value={student.wiseStudentKey} />
                    <FieldRow
                      label="Drive folder"
                      value={caseDetail.driveFolder}
                    />
                  </dl>
                )}
              </CardContent>
            </Card>

            {/* ── Self-report sections (CM-121, staff variant → review) ── */}
            <SectionsList
              caseId={caseDetail.caseId}
              sections={sectionStates}
              viewerRole={viewerRole}
              variant="staff"
            />
          </div>
        ) : null}

        {activeTab === "checklist" ? (
          <ChecklistTab
            caseId={caseDetail.caseId}
            tasks={tasks}
            progress={caseDetail.progress}
            viewerRole={viewerRole}
          />
        ) : null}

        {activeTab === "colleges" ? (
          <CollegesTab
            caseId={caseDetail.caseId}
            colleges={caseDetail.collegeList}
            warnings={caseDetail.applicationWarnings}
            recommenders={recommenders}
            collegeDocs={collegeDocs}
            viewerRole={viewerRole}
          />
        ) : null}

        {activeTab === "applications" ? (
          <ApplicationsTab
            caseId={caseDetail.caseId}
            colleges={caseDetail.collegeList}
            committedListItemId={caseDetail.committedListItemId}
            committedCollegeName={caseDetail.committedCollegeName}
            eventsByItem={applicationEvents}
            viewerRole={viewerRole}
          />
        ) : null}

        {activeTab === "essays" ? (
          <EssaysView
            caseId={caseDetail.caseId}
            essays={caseDetail.essays}
            collegeOptions={collegeOptions}
            viewerRole={viewerRole}
            variant="staff"
          />
        ) : null}

        {activeTab === "activities" ? (
          <ActivitiesView
            caseId={caseDetail.caseId}
            activities={caseDetail.activities}
            viewerRole={viewerRole}
            variant="tab"
          />
        ) : null}

        {activeTab === "testing" ? (
          <TestingView
            caseId={caseDetail.caseId}
            sittings={caseDetail.testSittings}
            bestScores={bestScores}
            collegeDocs={collegeDocs}
            colleges={collegeOptions}
            viewerRole={viewerRole}
            variant="staff"
          />
        ) : null}

        {activeTab === "meetings" ? (
          isStaff ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">
                  Meeting log
                </h2>
                {meetingFormTarget === null ? (
                  <Button size="sm" onClick={() => openMeetingForm("create")}>
                    <PlusIcon aria-hidden />
                    Log meeting
                  </Button>
                ) : null}
              </div>

              {meetingFormTarget !== null ? (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      {meetingFormTarget === "create" ? "Log a meeting" : "Edit meeting"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleMeetingSubmit();
                      }}
                      className="space-y-3"
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1 text-xs font-medium text-foreground">
                          Meeting date
                          <span aria-hidden className="text-destructive">
                            {" "}
                            *
                          </span>
                          <Input
                            type="date"
                            required
                            value={meetingForm.meetingDate}
                            onChange={(event) =>
                              setMeetingForm((previous) => ({
                                ...previous,
                                meetingDate: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label className="space-y-1 text-xs font-medium text-foreground">
                          Mode
                          <select
                            className={SELECT_CLASSES}
                            value={meetingForm.mode}
                            onChange={(event) =>
                              setMeetingForm((previous) => ({
                                ...previous,
                                mode: event.target.value,
                              }))
                            }
                          >
                            <option value="">Not set</option>
                            <option value="In person">In person</option>
                            <option value="Online">Online</option>
                            <option value="Phone">Phone</option>
                            <option value="Other">Other</option>
                          </select>
                        </label>
                        <label className="space-y-1 text-xs font-medium text-foreground sm:col-span-2">
                          Attendees (comma-separated)
                          <Input
                            placeholder="e.g. Ploy, Khun Anong, Counselor May"
                            value={meetingForm.attendees}
                            onChange={(event) =>
                              setMeetingForm((previous) => ({
                                ...previous,
                                attendees: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label className="space-y-1 text-xs font-medium text-foreground sm:col-span-2">
                          Notes
                          <Textarea
                            value={meetingForm.notes}
                            onChange={(event) =>
                              setMeetingForm((previous) => ({
                                ...previous,
                                notes: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label className="space-y-1 text-xs font-medium text-foreground">
                          Next meeting date
                          <Input
                            type="date"
                            value={meetingForm.nextMeetingDate}
                            onChange={(event) =>
                              setMeetingForm((previous) => ({
                                ...previous,
                                nextMeetingDate: event.target.value,
                              }))
                            }
                          />
                        </label>
                      </div>

                      {meetingFormTarget === "create" ? (
                        <fieldset className="space-y-2">
                          <legend className="text-xs font-medium text-foreground">
                            Action items (become checklist tasks)
                          </legend>
                          {actionItems.map((item, index) => (
                            <div
                              key={index}
                              className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2"
                            >
                              <label className="min-w-40 flex-1 space-y-1 text-xs font-medium text-foreground">
                                Title
                                <Input
                                  value={item.title}
                                  onChange={(event) =>
                                    setActionItems((previous) =>
                                      previous.map((entry, i) =>
                                        i === index
                                          ? { ...entry, title: event.target.value }
                                          : entry,
                                      ),
                                    )
                                  }
                                />
                              </label>
                              <label className="space-y-1 text-xs font-medium text-foreground">
                                Owner
                                <select
                                  className={cn(SELECT_CLASSES, "w-32")}
                                  value={item.owner}
                                  onChange={(event) =>
                                    setActionItems((previous) =>
                                      previous.map((entry, i) =>
                                        i === index
                                          ? {
                                              ...entry,
                                              owner: event.target
                                                .value as AdmissionsTaskOwner,
                                            }
                                          : entry,
                                      ),
                                    )
                                  }
                                >
                                  {ADMISSIONS_TASK_OWNERS.map((owner) => (
                                    <option key={owner} value={owner}>
                                      {owner}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="space-y-1 text-xs font-medium text-foreground">
                                Due date
                                <Input
                                  type="date"
                                  className="w-36"
                                  value={item.dueDate}
                                  onChange={(event) =>
                                    setActionItems((previous) =>
                                      previous.map((entry, i) =>
                                        i === index
                                          ? { ...entry, dueDate: event.target.value }
                                          : entry,
                                      ),
                                    )
                                  }
                                />
                              </label>
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Remove action item ${index + 1}`}
                                onClick={() =>
                                  setActionItems((previous) =>
                                    previous.filter((_, i) => i !== index),
                                  )
                                }
                              >
                                <Trash2Icon aria-hidden />
                              </Button>
                            </div>
                          ))}
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              setActionItems((previous) => [
                                ...previous,
                                { title: "", owner: "student", dueDate: "" },
                              ])
                            }
                          >
                            <PlusIcon aria-hidden />
                            Add action item
                          </Button>
                        </fieldset>
                      ) : null}

                      {meetingError ? (
                        <p role="alert" className="text-sm text-destructive">
                          {meetingError}
                        </p>
                      ) : null}
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" disabled={meetingSaving}>
                          {meetingSaving
                            ? "Saving…"
                            : meetingFormTarget === "create"
                              ? "Log meeting"
                              : "Save changes"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={handleMeetingCancel}
                          disabled={meetingSaving}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  </CardContent>
                </Card>
              ) : null}

              {meetings.length > 0 ? (
                <ul className="space-y-3">
                  {meetings.map((meeting) => (
                    <li key={meeting.id}>
                      <Card>
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2 text-sm">
                            {formatDateOnly(meeting.meetingDate)}
                            {meeting.mode ? (
                              <Badge variant="secondary">{meeting.mode}</Badge>
                            ) : null}
                          </CardTitle>
                          {meeting.attendees.length > 0 ? (
                            <CardDescription>
                              Attendees: {meeting.attendees.join(", ")}
                            </CardDescription>
                          ) : null}
                          <CardAction>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => openMeetingForm(meeting)}
                            >
                              <PencilIcon aria-hidden />
                              Edit
                            </Button>
                          </CardAction>
                        </CardHeader>
                        <CardContent className="space-y-1 text-sm">
                          {meeting.notes ? (
                            <p className="whitespace-pre-wrap">{meeting.notes}</p>
                          ) : (
                            <p className="text-muted-foreground">No notes recorded.</p>
                          )}
                          {meeting.nextMeetingDate ? (
                            <p className="text-xs text-muted-foreground">
                              Next meeting: {formatDateOnly(meeting.nextMeetingDate)}
                            </p>
                          ) : null}
                        </CardContent>
                      </Card>
                    </li>
                  ))}
                </ul>
              ) : (
                <Card>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      No meetings logged yet. Log the first meeting to start the
                      touch history for this case.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          ) : (
            <Card>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  The meeting log is visible to counselors and admins only.
                </p>
              </CardContent>
            </Card>
          )
        ) : null}

        {activeTab === "notes" ? (
          <div className="space-y-4">
            {isStaff ? (
              <Card>
                <CardHeader>
                  <CardTitle>Add a note</CardTitle>
                  <CardDescription>
                    Choose who can see the note — there is no default.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleNoteSubmit();
                    }}
                    className="space-y-3"
                  >
                    <Textarea
                      aria-label="Note body"
                      placeholder="Write a note about this case…"
                      value={noteBody}
                      onChange={(event) => setNoteBody(event.target.value)}
                    />
                    <fieldset>
                      <legend className="text-xs font-medium text-foreground">
                        Visibility
                        <span aria-hidden className="text-destructive">
                          {" "}
                          *
                        </span>
                      </legend>
                      <div className="mt-1.5 flex flex-col gap-1.5">
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            type="radio"
                            name="note-visibility"
                            value="staff_only"
                            checked={noteVisibility === "staff_only"}
                            onChange={() => setNoteVisibility("staff_only")}
                            className="mt-1"
                          />
                          <span>
                            Staff only
                            <span className="block text-xs text-muted-foreground">
                              Visible to counselors and admins — never to the
                              student or parents.
                            </span>
                          </span>
                        </label>
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            type="radio"
                            name="note-visibility"
                            value="shared_with_family"
                            checked={noteVisibility === "shared_with_family"}
                            onChange={() => setNoteVisibility("shared_with_family")}
                            className="mt-1"
                          />
                          <span>
                            Shared with family
                            <span className="block text-xs text-muted-foreground">
                              Also visible to the student and parents.
                            </span>
                          </span>
                        </label>
                      </div>
                    </fieldset>
                    {noteError ? (
                      <p role="alert" className="text-sm text-destructive">
                        {noteError}
                      </p>
                    ) : null}
                    <Button
                      type="submit"
                      size="sm"
                      data-testid="note-submit"
                      disabled={!canSubmitNote(noteBody, noteVisibility) || noteSaving}
                    >
                      {noteSaving ? "Posting…" : "Post note"}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            ) : null}

            {notes.length > 0 ? (
              <ul className="space-y-3">
                {notes.map((note) => (
                  <li key={note.id}>
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm font-medium">
                          {note.authorEmail === viewerEmail ? "You" : note.authorEmail}
                        </CardTitle>
                        <CardDescription>
                          {formatBangkokTimestamp(note.createdAt)}
                        </CardDescription>
                        <CardAction>
                          <VisibilityBadge visibility={note.visibility} />
                        </CardAction>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm whitespace-pre-wrap">{note.body}</p>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            ) : (
              <Card>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {isStaff
                      ? "No notes yet. Post the first note above."
                      : "No shared notes yet."}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        ) : null}

      </main>

      {/* ── Discard-changes confirmation (destructive action guard) ── */}
      <Dialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDiscard(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your edits have not been saved. Discarding cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDiscard(null)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                pendingDiscard?.();
                setPendingDiscard(null);
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────────

/** Suspense fallback for the case detail page (>300ms loads, design §5.4). */
export function CaseDetailSkeleton() {
  return (
    <div
      className="mx-auto min-h-0 w-full max-w-5xl flex-1 animate-pulse overflow-y-auto px-4 pt-3"
      aria-hidden
    >
      <div className="h-3 w-16 rounded bg-muted" />
      <div className="mt-2 h-6 w-64 rounded bg-muted" />
      <div className="mt-2 h-3 w-40 rounded bg-muted" />
      <div className="mt-4 flex gap-2">
        {CASE_TABS.map((tab) => (
          <div key={tab.key} className="h-7 w-20 rounded-md bg-muted" />
        ))}
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-36 rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import {
  Archive,
  BarChart3,
  Calendar,
  Check,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Inbox,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Send,
  SendHorizontal,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ComparePanel } from "@/components/compare/compare-panel";
import { useCompare } from "@/hooks/use-compare";
import type { TutorListItem } from "@/lib/data/tutors";
import { cn } from "@/lib/utils";
import { buildSchedulerCompareFocusTarget } from "./scheduler-compare-focus";

type SchedulerConversationStatus = "active" | "archived";
type SchedulerMessageRole = "admin" | "parent" | "assistant" | "system";

interface SchedulerExtractedState {
  searchMode?: "recurring" | "one_time";
  dayOfWeek?: number;
  date?: string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: 60 | 90 | 120;
  mode?: "online" | "onsite" | "either";
  filters?: { subject?: string; curriculum?: string; level?: string };
  academicLevelResolution?: {
    rawLevelLabel: string;
    wiseLevel?: string;
    status: "mapped" | "ambiguous" | "unknown";
    candidates: string[];
    message: string;
  };
  businessRequirements?: {
    englishProficiency?: "native" | "near-native" | "fluent" | "conversational" | "basic" | "unknown";
    strengthTags?: string[];
    curriculumExperience?: string[];
    schoolKeywords?: string[];
  };
  requestedSlots?: {
    id?: string;
    searchMode?: "recurring" | "one_time";
    dayOfWeek?: number;
    date?: string;
    startTime?: string;
    endTime?: string;
    durationMinutes?: 60 | 90 | 120;
  }[];
  explicitUnknownFilters?: string[];
  explicitUnknownBusinessRequirements?: string[];
  tutorNames?: string[];
  tutorExclusions?: string[];
  parentName?: string;
  studentName?: string;
  contact?: string;
  negativeFeedback?: boolean;
  assumptions?: string[];
  unresolvedQuestions?: string[];
  parentRequestSummary?: string;
}

interface SchedulerConversation {
  id: string;
  title: string;
  status: SchedulerConversationStatus;
  customerParentName: string | null;
  customerStudentName: string | null;
  customerContact: string | null;
  notes: string;
  extractedState: SchedulerExtractedState;
  createdByEmail: string | null;
  createdByName: string | null;
  archivedAt: string | null;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

interface SchedulerMessage {
  id: string;
  conversationId: string;
  role: SchedulerMessageRole;
  content: string;
  structuredPayload: SchedulerPayload | Record<string, unknown> | null;
  model: string | null;
  latencyMs: number | null;
  createdByEmail: string | null;
  createdByName: string | null;
  createdAt: string;
}

interface SchedulerSuggestion {
  id: string;
  rank: number;
  searchMode: "recurring" | "one_time";
  dayOfWeek?: number;
  date?: string;
  start: string;
  end: string;
  durationMinutes: 60 | 90 | 120;
  mode: "online" | "onsite" | "either";
  confidence: "Best fit" | "Strong fit" | "Good fit";
  tutors: { tutorGroupId: string; displayName: string; supportedModes: string[]; profileEvidence?: string[] }[];
  availableTutorCount: number;
  reasons: string[];
  parentReady: boolean;
  requestedSlotId?: string;
}

interface SchedulerAvailabilityWindowSummary {
  date: string;
  weekday: number;
  start: string;
  end: string;
  mode: "online" | "onsite" | "either";
}

interface SchedulerAvailabilityTutorSummary {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  matchedSubjects: string[];
  windows: SchedulerAvailabilityWindowSummary[];
  profileEvidence?: string[];
}

interface SchedulerAvailabilitySummary {
  dateRange: { startDate: string; endDate: string };
  searchedFilters: Array<{ subject?: string; curriculum?: string; level?: string }>;
  durationMinutes: 60 | 90 | 120;
  mode: "online" | "onsite" | "either";
  tutors: SchedulerAvailabilityTutorSummary[];
  needsReview: Array<{ tutorGroupId: string; displayName: string; reasons: string[] }>;
}

interface SchedulerConstraintLedgerItem {
  key: string;
  label: string;
  requested: string | null;
  normalized: string | null;
  evidence: "model" | "deterministic" | "default" | "not_provided";
  status: "proven" | "needs_clarification" | "not_applicable";
  message: string;
}

interface SchedulerPayload {
  state?: SchedulerExtractedState;
  suggestions?: SchedulerSuggestion[];
  availabilitySummary?: SchedulerAvailabilitySummary;
  constraintLedger?: SchedulerConstraintLedgerItem[];
  parentMessageDraft?: string;
  warnings?: string[];
  questions?: string[];
  parentReady?: boolean;
  error?: string;
}

interface SchedulerWorkspaceProps {
  sessionUser: {
    email: string;
    name: string;
  };
  aiSchedulerEnabled: boolean;
  tutorList: TutorListItem[];
}

interface LineSchedulerReview {
  id: string;
  contactId: string;
  lineUserId: string;
  contactDisplayName: string | null;
  inboundMessageId: string;
  conversationId: string | null;
  classifierCategory: string;
  classifierConfidence: number | null;
  classifierSummary: string | null;
  status: "pending_review" | "approved_sent" | "accepted_no_send" | "rejected" | "dismissed";
  proposedDraft: string;
  finalText: string | null;
  rejectionReason: string | null;
  reasonCategory: string | null;
  staffCorrection: string | null;
  selectedTutorIds: string[];
  studentLinkOverride: boolean;
  verifiedStudentKeys: string[];
  sendLineMessageId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

interface LineSchedulerAnalytics {
  classifiedMessages: number;
  schedulingMessages: number;
  nonSchedulingMessages: number;
  unclearMessages: number;
  pendingReviews: number;
  approvedSent: number;
  acceptedNoSend: number;
  rejected: number;
  dismissed: number;
  rejectionRate: number;
  averageEditDistance: number | null;
  averageModelLatencyMs: number | null;
  classificationReviewedMessages: number;
  classificationAccuracy: number | null;
  classificationFalsePositives: number;
  classificationFalseNegatives: number;
  classificationReviewCoverage: number;
  unverifiedLinkBacklog: number;
  commonRejectionReasons: Array<{ reason: string; count: number }>;
  commonRejectionCategories: Array<{ category: string; count: number }>;
  feedbackLabels: Array<{ label: "accepted" | "edited" | "rejected" | "dismissed"; count: number }>;
}

interface LineContactStudentLink {
  id: string;
  contactId: string;
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  status: "suggested" | "verified" | "rejected";
  confidence: number | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
}

interface DetailsState {
  title: string;
  customerParentName: string;
  customerStudentName: string;
  customerContact: string;
  notes: string;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LINE_CLASSIFICATION_CATEGORIES = [
  "scheduling_request",
  "scheduling_change",
  "non_scheduling",
  "unclear",
] as const;
const LINE_REJECTION_REASON_OPTIONS = [
  { value: "wrong_student_link", label: "Wrong student" },
  { value: "wrong_extracted_request", label: "Wrong request" },
  { value: "wrong_tutor_fit", label: "Wrong tutor" },
  { value: "wrong_availability", label: "Wrong availability" },
  { value: "unsafe_draft", label: "Unsafe draft" },
  { value: "unclear", label: "Unclear" },
  { value: "other", label: "Other" },
] as const;
const UNTITLED = "Untitled scheduler chat";

function emptyDetails(): DetailsState {
  return {
    title: UNTITLED,
    customerParentName: "",
    customerStudentName: "",
    customerContact: "",
    notes: "",
  };
}

function detailsFromConversation(conversation: SchedulerConversation | null): DetailsState {
  if (!conversation) return emptyDetails();
  return {
    title: conversation.title,
    customerParentName: conversation.customerParentName ?? "",
    customerStudentName: conversation.customerStudentName ?? "",
    customerContact: conversation.customerContact ?? "",
    notes: conversation.notes,
  };
}

function payloadFromMessage(message: SchedulerMessage): SchedulerPayload | null {
  const payload = message.structuredPayload as SchedulerPayload | null;
  if (!payload || typeof payload !== "object") return null;
  if (!("suggestions" in payload) && !("availabilitySummary" in payload) && !("parentMessageDraft" in payload) && !("error" in payload)) return null;
  return payload;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatSuggestionDay(suggestion: SchedulerSuggestion): string {
  if (suggestion.searchMode === "one_time" && suggestion.date) return suggestion.date;
  if (typeof suggestion.dayOfWeek === "number") return `Every ${DAY_NAMES[suggestion.dayOfWeek]}`;
  return "Requested day";
}

function formatAvailabilityDate(date: string, weekday: number): string {
  const [, monthRaw, dayRaw] = date.split("-");
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${DAY_NAMES[weekday]?.slice(0, 3) ?? "Day"} ${day} ${monthNames[month - 1] ?? monthRaw}`;
}

function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function compactAvailabilityWindows(windows: SchedulerAvailabilityWindowSummary[], dateLimit = 2): string {
  const byDate = new Map<string, { weekday: number; ranges: Array<{ start: number; end: number }> }>();
  for (const window of windows) {
    const entry = byDate.get(window.date) ?? { weekday: window.weekday, ranges: [] };
    entry.ranges.push({ start: timeToMinutes(window.start), end: timeToMinutes(window.end) });
    byDate.set(window.date, entry);
  }

  const grouped = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => {
      const merged: Array<{ start: number; end: number }> = [];
      for (const range of entry.ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
        const current = merged[merged.length - 1];
        if (current && range.start <= current.end) {
          current.end = Math.max(current.end, range.end);
        } else {
          merged.push({ ...range });
        }
      }
      return { date, weekday: entry.weekday, ranges: merged };
    });

  const visible = grouped.slice(0, dateLimit).map((entry) => (
    `${formatAvailabilityDate(entry.date, entry.weekday)} ${entry.ranges.map((range) => `${minutesToTime(range.start)}-${minutesToTime(range.end)}`).join(", ")}`
  ));
  const remaining = grouped.length - visible.length;
  return `${visible.join("; ")}${remaining > 0 ? `; +${remaining} more day${remaining === 1 ? "" : "s"}` : ""}`;
}

function formatMode(mode?: string): string {
  if (!mode || mode === "either") return "Online or onsite";
  return mode === "online" ? "Online" : "Onsite";
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return data as T;
}

function RequirementPill({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="rounded-md border border-border bg-background px-2 py-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-xs text-foreground">{value || "Not set"}</div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  onCompareSuggestion,
}: {
  suggestion: SchedulerSuggestion;
  onCompareSuggestion: (suggestion: SchedulerSuggestion) => void;
}) {
  const canCompare = suggestion.tutors.length > 0;

  return (
    <div className="rounded-md border border-border bg-background p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Badge variant={suggestion.parentReady ? "secondary" : "outline"} className="h-5 text-[10px]">
              #{suggestion.rank}
            </Badge>
            <span className="text-xs font-semibold">{formatSuggestionDay(suggestion)}</span>
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {suggestion.start}-{suggestion.end}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {suggestion.durationMinutes} min · {formatMode(suggestion.mode)}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onCompareSuggestion(suggestion)}
          disabled={!canCompare}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Calendar className="h-3 w-3" aria-hidden />
          Compare
        </button>
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        {suggestion.tutors.map((tutor) => tutor.displayName).join(" or ")}
      </div>
      {suggestion.tutors.some((tutor) => (tutor.profileEvidence ?? []).length > 0) && (
        <div className="mt-1 space-y-0.5 text-[10.5px] text-muted-foreground">
          {suggestion.tutors.slice(0, 2).map((tutor) => {
            const evidence = (tutor.profileEvidence ?? []).slice(0, 2);
            if (evidence.length === 0) return null;
            return (
              <div key={`${tutor.tutorGroupId}-evidence`} className="truncate">
                {tutor.displayName}: {evidence.join(" · ")}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {suggestion.reasons.slice(0, 3).map((reason) => (
          <span key={reason} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {reason}
          </span>
        ))}
      </div>
    </div>
  );
}

function ParentDraft({
  messageId,
  conversationId,
  initialDraft,
  suggestions,
}: {
  messageId: string;
  conversationId: string;
  initialDraft: string;
  suggestions: SchedulerSuggestion[];
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [showReject, setShowReject] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [staffCorrection, setStaffCorrection] = useState("");

  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  const selectedTutorIds = Array.from(new Set(
    suggestions.flatMap((suggestion) => suggestion.tutors.map((tutor) => tutor.tutorGroupId)),
  ));

  const submitFeedback = async (action: "accept" | "edit" | "reject") => {
    setBusy(action === "reject" ? "reject" : "accept");
    setFeedbackError(null);
    setFeedbackStatus(null);
    try {
      const body = action === "reject"
        ? {
            action,
            conversationId,
            rejectedTutorIds: selectedTutorIds,
            rejectionReason,
            staffCorrection,
          }
        : {
            action,
            conversationId,
            selectedTutorIds,
            editedParentDraft: draft.trim() !== initialDraft.trim() ? draft : undefined,
          };
      await jsonOrThrow<{ feedback: unknown }>(
        await fetch(`/api/ai-scheduler/messages/${messageId}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      setFeedbackStatus(action === "reject" ? "Rejection saved" : action === "edit" ? "Edit saved" : "Accepted");
      if (action === "reject") {
        setShowReject(false);
      }
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : "Failed to save feedback");
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Parent reply
        <Button type="button" size="xs" variant="outline" onClick={copy} className="h-6 gap-1 text-[10px]">
          {copied ? <Check className="h-3 w-3" aria-hidden /> : <Clipboard className="h-3 w-3" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Textarea
        key={messageId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={6}
        className="min-h-[124px] max-h-[260px] resize-y overflow-y-auto bg-muted/30 text-xs leading-relaxed [field-sizing:fixed]"
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          onClick={() => submitFeedback(draft.trim() === initialDraft.trim() ? "accept" : "edit")}
          disabled={busy !== null || !draft.trim()}
          className="gap-1"
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          {busy === "accept" ? "Saving" : draft.trim() === initialDraft.trim() ? "Accept" : "Save edit"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => setShowReject((value) => !value)}
          disabled={busy !== null}
          className="gap-1"
        >
          <XCircle className="h-3.5 w-3.5" aria-hidden />
          Reject
        </Button>
        {feedbackStatus && <span className="text-[11px] text-available">{feedbackStatus}</span>}
      </div>
      {showReject && (
        <div className="mt-2 grid gap-1.5 rounded-md border border-border bg-muted/20 p-2">
          <Input
            value={rejectionReason}
            onChange={(event) => setRejectionReason(event.target.value)}
            placeholder="Why is this wrong?"
            className="h-8 text-xs"
          />
          <Textarea
            value={staffCorrection}
            onChange={(event) => setStaffCorrection(event.target.value)}
            placeholder="What should the scheduler have done?"
            rows={3}
            className="text-xs"
          />
          <div className="flex items-center justify-end">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => submitFeedback("reject")}
              disabled={busy !== null || !rejectionReason.trim() || !staffCorrection.trim()}
            >
              {busy === "reject" ? "Saving" : "Save rejection"}
            </Button>
          </div>
        </div>
      )}
      {feedbackError && (
        <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{feedbackError}</div>
      )}
    </div>
  );
}

function AvailabilitySummaryPanel({ summary }: { summary: SchedulerAvailabilitySummary }) {
  const searched = summary.searchedFilters
    .map((filters) => [filters.subject, filters.level, filters.curriculum].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
  const visibleTutors = summary.tutors.slice(0, 6);
  const remainingTutorCount = Math.max(0, summary.tutors.length - visibleTutors.length);

  return (
    <div className="mt-3 rounded-md border border-primary/15 bg-primary/5 p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
          {summary.tutors.length} tutors
        </Badge>
        <span>{summary.dateRange.startDate} to {summary.dateRange.endDate}</span>
        <span>{summary.durationMinutes} min</span>
        {searched && <span className="min-w-0 truncate">Checked {searched}</span>}
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {visibleTutors.map((tutor) => (
          <div key={tutor.tutorGroupId} className="rounded-md border border-border bg-background/80 p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-foreground">{tutor.displayName}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {tutor.matchedSubjects.join(" / ") || "Matched"}
                </div>
              </div>
              <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
                {tutor.windows.length}
              </Badge>
            </div>
            <div className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {compactAvailabilityWindows(tutor.windows)}
            </div>
            {tutor.profileEvidence && tutor.profileEvidence.length > 0 && (
              <div className="mt-1 truncate text-[10.5px] text-muted-foreground">
                {tutor.profileEvidence.slice(0, 2).join(" · ")}
              </div>
            )}
          </div>
        ))}
      </div>
      {remainingTutorCount > 0 && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          +{remainingTutorCount} more available tutor{remainingTutorCount === 1 ? "" : "s"} included in the parent draft.
        </div>
      )}
      {summary.needsReview.length > 0 && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {summary.needsReview.length} tutor{summary.needsReview.length === 1 ? "" : "s"} kept in Needs Review.
        </div>
      )}
    </div>
  );
}

function ConstraintLedgerPanel({ ledger }: { ledger: SchedulerConstraintLedgerItem[] }) {
  const visible = ledger.filter((item) => item.status !== "not_applicable");
  if (visible.length === 0) return null;

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/25 p-2.5">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-available" aria-hidden />
        Safety proof
      </div>
      <div className="grid gap-1.5 md:grid-cols-2">
        {visible.slice(0, 8).map((item) => (
          <div key={`${item.key}-${item.label}`} className="rounded-md border border-border bg-background/80 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[11px] font-medium text-foreground">{item.label}</span>
              <Badge
                variant={item.status === "proven" ? "secondary" : "outline"}
                className={cn(
                  "h-5 shrink-0 px-1.5 text-[9px]",
                  item.status === "needs_clarification" && "border-amber-400 text-amber-700 dark:text-amber-300",
                )}
              >
                {item.status === "proven" ? "Proven" : "Check"}
              </Badge>
            </div>
            <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
              {item.normalized ?? item.message}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineReviewPanel({
  review,
  onUpdated,
}: {
  review: LineSchedulerReview;
  onUpdated: (review: LineSchedulerReview) => void;
}) {
  const [draft, setDraft] = useState(review.finalText ?? review.proposedDraft);
  const [reason, setReason] = useState(review.rejectionReason ?? "");
  const [reasonCategory, setReasonCategory] = useState(review.reasonCategory ?? "wrong_availability");
  const [correction, setCorrection] = useState(review.staffCorrection ?? "");
  const [studentLinkOverride, setStudentLinkOverride] = useState(review.studentLinkOverride);
  const [studentLinks, setStudentLinks] = useState<LineContactStudentLink[]>([]);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [classificationStatus, setClassificationStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(review.finalText ?? review.proposedDraft);
    setReason(review.rejectionReason ?? "");
    setReasonCategory(review.reasonCategory ?? "wrong_availability");
    setCorrection(review.staffCorrection ?? "");
    setStudentLinkOverride(review.studentLinkOverride);
    setError(null);
    setClassificationStatus(null);
  }, [review]);

  useEffect(() => {
    let cancelled = false;
    setLinkError(null);
    fetch(`/api/line/contacts/${review.contactId}/student-links`)
      .then((response) => jsonOrThrow<{ links: LineContactStudentLink[] }>(response))
      .then((data) => {
        if (!cancelled) setStudentLinks(data.links);
      })
      .catch((err) => {
        if (!cancelled) setLinkError(err instanceof Error ? err.message : "Failed to load student links");
      });
    return () => {
      cancelled = true;
    };
  }, [review.contactId]);

  const patchReview = async (body: Record<string, unknown>, busyKey: string) => {
    setBusy(busyKey);
    setError(null);
    try {
      const data = await jsonOrThrow<{ review: LineSchedulerReview }>(
        await fetch(`/api/line/scheduler-reviews/${review.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      onUpdated(data.review);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update LINE review");
    } finally {
      setBusy(null);
    }
  };

  const patchStudentLink = async (linkId: string, action: "verify" | "reject") => {
    setBusy(`link-${linkId}`);
    setLinkError(null);
    try {
      const data = await jsonOrThrow<{ links: LineContactStudentLink[] }>(
        await fetch(`/api/line/contacts/${review.contactId}/student-links`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, linkId }),
        }),
      );
      setStudentLinks(data.links);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Failed to update student link");
    } finally {
      setBusy(null);
    }
  };

  const patchClassification = async (reviewedCategory: string) => {
    setBusy("classification");
    setClassificationStatus(null);
    try {
      const data = await jsonOrThrow<{
        feedback: { classificationReviewedCorrect: boolean };
      }>(
        await fetch(`/api/line/messages/${review.inboundMessageId}/classification-feedback`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewedCategory }),
        }),
      );
      setClassificationStatus(data.feedback.classificationReviewedCorrect ? "Marked correct" : "Correction logged");
    } catch (err) {
      setClassificationStatus(err instanceof Error ? err.message : "Failed to log classification feedback");
    } finally {
      setBusy(null);
    }
  };

  const locked = review.status !== "pending_review";
  const statusLabel = review.status.replace(/_/g, " ");
  const verifiedCount = studentLinks.filter((link) => link.status === "verified").length;
  const sendBlocked = !locked && verifiedCount === 0 && !studentLinkOverride;

  return (
    <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Inbox className="h-3.5 w-3.5 text-primary" aria-hidden />
            LINE review
            <Badge variant={locked ? "secondary" : "outline"} className="h-5 capitalize">
              {statusLabel}
            </Badge>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {review.contactDisplayName || review.lineUserId} · {review.classifierCategory.replace(/_/g, " ")}
            {typeof review.classifierConfidence === "number" ? ` · ${Math.round(review.classifierConfidence * 100)}%` : ""}
          </div>
          {review.classifierSummary && (
            <div className="mt-1 text-xs text-muted-foreground">{review.classifierSummary}</div>
          )}
        </div>
        {review.sendLineMessageId && (
          <Badge variant="secondary" className="h-5 text-[10px]">
            Sent
          </Badge>
        )}
      </div>

      <div className="mb-2 rounded-md border border-border bg-background/80 p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Student link
          </div>
          <Badge variant={verifiedCount > 0 ? "secondary" : "outline"} className="h-5 px-1.5 text-[9px]">
            {verifiedCount > 0 ? `${verifiedCount} verified` : "Needs check"}
          </Badge>
        </div>
        {studentLinks.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">No Wise student candidate found from this LINE label.</div>
        ) : (
          <div className="space-y-1">
            {studentLinks.map((link) => (
              <div key={link.id} className="flex items-center justify-between gap-2 rounded border border-border/70 px-2 py-1">
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-medium text-foreground">
                    {link.studentName}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {link.parentName || "Missing parent"} · {link.status}
                    {typeof link.confidence === "number" ? ` · ${Math.round(link.confidence * 100)}%` : ""}
                  </div>
                </div>
                {!locked && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant={link.status === "verified" ? "secondary" : "outline"}
                      onClick={() => patchStudentLink(link.id, "verify")}
                      disabled={busy !== null}
                      title="Verify student link"
                    >
                      <Check className="h-3 w-3" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant={link.status === "rejected" ? "secondary" : "outline"}
                      onClick={() => patchStudentLink(link.id, "reject")}
                      disabled={busy !== null}
                      title="Reject student link"
                    >
                      <XCircle className="h-3 w-3" aria-hidden />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {!locked && (
          <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={studentLinkOverride}
              onChange={(event) => setStudentLinkOverride(event.target.checked)}
              disabled={busy !== null}
              className="h-3.5 w-3.5"
            />
            New/unmatched student for this review
          </label>
        )}
        {linkError && <div className="mt-1 text-[11px] text-destructive">{linkError}</div>}
        {sendBlocked && (
          <div className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            Verify a student link or mark unmatched before sending to parent.
          </div>
        )}
      </div>

      {!locked && (
        <div className="mb-2 rounded-md border border-border bg-background/80 p-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Classification feedback
          </div>
          <div className="flex flex-wrap gap-1">
            {LINE_CLASSIFICATION_CATEGORIES.map((category) => (
              <Button
                key={category}
                type="button"
                size="sm"
                variant={category === review.classifierCategory ? "secondary" : "outline"}
                onClick={() => patchClassification(category)}
                disabled={busy !== null}
                className="h-7 px-2 text-[10px]"
              >
                {category.replace(/_/g, " ")}
              </Button>
            ))}
          </div>
          {classificationStatus && (
            <div className="mt-1 text-[11px] text-muted-foreground">{classificationStatus}</div>
          )}
        </div>
      )}

      <label className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Reply draft
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={5}
          disabled={locked || busy !== null}
          className="mt-1 min-h-[116px] resize-none bg-background text-xs leading-relaxed"
        />
      </label>

      {!locked && (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <label className="block text-[11px] font-medium text-muted-foreground">
            Reject category
            <select
              value={reasonCategory}
              onChange={(event) => setReasonCategory(event.target.value)}
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring/50"
            >
              {LINE_REJECTION_REASON_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="block text-[11px] font-medium text-muted-foreground">
            Reject reason
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What was wrong?"
              className="mt-1 text-xs"
            />
          </label>
          <label className="block text-[11px] font-medium text-muted-foreground md:col-span-2">
            Staff correction
            <Input
              value={correction}
              onChange={(event) => setCorrection(event.target.value)}
              placeholder="What should staff send/do?"
              className="mt-1 text-xs"
            />
          </label>
        </div>
      )}

      {error && (
        <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</div>
      )}

      {!locked ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            onClick={() => patchReview({
              action: "approve_send",
              finalText: draft,
              selectedTutorIds: review.selectedTutorIds,
              studentLinkOverride,
            }, "approve")}
            disabled={busy !== null || !draft.trim() || sendBlocked}
          >
            <SendHorizontal className="h-3.5 w-3.5" aria-hidden />
            {busy === "approve" ? "Sending" : "Approve & send"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => patchReview({
              action: "accept_no_send",
              finalText: draft,
              selectedTutorIds: review.selectedTutorIds,
              studentLinkOverride,
            }, "accept")}
            disabled={busy !== null}
          >
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            {busy === "accept" ? "Saving" : "Accept, already handled"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => patchReview({
              action: "reject",
              reasonCategory,
              rejectionReason: reason,
              staffCorrection: correction,
              rejectedTutorIds: review.selectedTutorIds,
            }, "reject")}
            disabled={busy !== null || !reasonCategory.trim() || !reason.trim() || !correction.trim()}
          >
            <XCircle className="h-3.5 w-3.5" aria-hidden />
            {busy === "reject" ? "Saving" : "Reject"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => patchReview({ action: "dismiss", rejectionReason: reason || undefined }, "dismiss")}
            disabled={busy !== null}
          >
            Dismiss
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Reviewed by {review.reviewedByName || "admin"}{review.reviewedAt ? ` · ${formatShortDate(review.reviewedAt)}` : ""}
        </div>
      )}
    </div>
  );
}

export function SchedulerWorkspace({ sessionUser, aiSchedulerEnabled, tutorList }: SchedulerWorkspaceProps) {
  const compare = useCompare();
  const [conversations, setConversations] = useState<SchedulerConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<SchedulerConversation | null>(null);
  const [messages, setMessages] = useState<SchedulerMessage[]>([]);
  const [pendingLineReviews, setPendingLineReviews] = useState<LineSchedulerReview[]>([]);
  const [selectedLineReviews, setSelectedLineReviews] = useState<LineSchedulerReview[]>([]);
  const [lineAnalytics, setLineAnalytics] = useState<LineSchedulerAnalytics | null>(null);
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [composer, setComposer] = useState("");
  const [details, setDetails] = useState<DetailsState>(emptyDetails);
  const [detailsDirty, setDetailsDirty] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rightWorkspace, setRightWorkspace] = useState<"compare" | "notes">("notes");
  const [compareFullscreen, setCompareFullscreen] = useState(false);
  const detailsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshLineReviews = async (conversationId = selectedId) => {
    const pendingParams = new URLSearchParams({ status: "pending_review", analytics: "true" });
    const pendingData = await jsonOrThrow<{
      reviews: LineSchedulerReview[];
      analytics: LineSchedulerAnalytics | null;
    }>(await fetch(`/api/line/scheduler-reviews?${pendingParams.toString()}`));
    setPendingLineReviews(pendingData.reviews);
    setLineAnalytics(pendingData.analytics);

    if (conversationId) {
      const selectedParams = new URLSearchParams({ conversationId });
      const selectedData = await jsonOrThrow<{ reviews: LineSchedulerReview[] }>(
        await fetch(`/api/line/scheduler-reviews?${selectedParams.toString()}`),
      );
      setSelectedLineReviews(selectedData.reviews);
    } else {
      setSelectedLineReviews([]);
    }
  };

  const replaceLineReview = (updated: LineSchedulerReview) => {
    setSelectedLineReviews((current) => current.map((review) => review.id === updated.id ? updated : review));
    setPendingLineReviews((current) => current.filter((review) => review.id !== updated.id));
    void refreshLineReviews(selectedId);
  };

  const loadConversations = async (nextSelectedId?: string | null) => {
    setLoadingList(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("scope", scope);
      if (includeArchived) params.set("includeArchived", "true");
      if (deferredQuery.trim()) params.set("q", deferredQuery.trim());
      const data = await jsonOrThrow<{ conversations: SchedulerConversation[] }>(
        await fetch(`/api/ai-scheduler/conversations?${params.toString()}`),
      );
      setConversations(data.conversations);
      const desiredId = nextSelectedId ?? selectedId;
      if (desiredId && data.conversations.some((conversation) => conversation.id === desiredId)) {
        setSelectedId(desiredId);
      } else {
        setSelectedId(data.conversations[0]?.id ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load conversations");
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    void loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, includeArchived, deferredQuery]);

  useEffect(() => {
    void refreshLineReviews();
    const interval = window.setInterval(() => {
      void refreshLineReviews();
    }, 60_000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelectedConversation(null);
      setMessages([]);
      setSelectedLineReviews([]);
      setDetails(emptyDetails());
      setDetailsDirty(false);
      return;
    }
    const controller = new AbortController();
    setLoadingConversation(true);
    setError(null);
    Promise.all([
      fetch(`/api/ai-scheduler/conversations/${selectedId}`, { signal: controller.signal })
        .then((response) => jsonOrThrow<{ conversation: SchedulerConversation; messages: SchedulerMessage[] }>(response)),
      fetch(`/api/line/scheduler-reviews?conversationId=${encodeURIComponent(selectedId)}`, { signal: controller.signal })
        .then((response) => jsonOrThrow<{ reviews: LineSchedulerReview[] }>(response)),
    ])
      .then(([conversationData, reviewData]) => {
        setSelectedConversation(conversationData.conversation);
        setMessages(conversationData.messages);
        setSelectedLineReviews(reviewData.reviews);
        setDetails(detailsFromConversation(conversationData.conversation));
        setDetailsDirty(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setError(err instanceof Error ? err.message : "Failed to load conversation");
        }
      })
      .finally(() => setLoadingConversation(false));
    return () => controller.abort();
  }, [selectedId]);

  useEffect(() => {
    if (!detailsDirty || !selectedConversation) return;
    if (detailsSaveTimer.current) window.clearTimeout(detailsSaveTimer.current);
    detailsSaveTimer.current = setTimeout(async () => {
      try {
        const data = await jsonOrThrow<{ conversation: SchedulerConversation }>(
          await fetch(`/api/ai-scheduler/conversations/${selectedConversation.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: details.title,
              customerParentName: details.customerParentName || null,
              customerStudentName: details.customerStudentName || null,
              customerContact: details.customerContact || null,
              notes: details.notes,
            }),
          }),
        );
        setSelectedConversation(data.conversation);
        setConversations((prev) => prev.map((item) => item.id === data.conversation.id ? data.conversation : item));
        setDetailsDirty(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save conversation");
      }
    }, 650);
    return () => {
      if (detailsSaveTimer.current) window.clearTimeout(detailsSaveTimer.current);
    };
  }, [details, detailsDirty, selectedConversation]);

  const updateDetail = <K extends keyof DetailsState>(key: K, value: DetailsState[K]) => {
    setDetails((current) => ({ ...current, [key]: value }));
    setDetailsDirty(true);
  };

  const createConversation = async () => {
    setError(null);
    try {
      const data = await jsonOrThrow<{ conversation: SchedulerConversation }>(
        await fetch("/api/ai-scheduler/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: UNTITLED }),
        }),
      );
      setConversations((prev) => [data.conversation, ...prev]);
      setSelectedId(data.conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create conversation");
    }
  };

  const archiveSelected = async () => {
    if (!selectedConversation) return;
    setError(null);
    try {
      const data = await jsonOrThrow<{ conversation: SchedulerConversation }>(
        await fetch(`/api/ai-scheduler/conversations/${selectedConversation.id}`, {
          method: "DELETE",
        }),
      );
      setSelectedConversation(data.conversation);
      await loadConversations(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive conversation");
    }
  };

  const focusCompareSuggestion = useCallback((suggestion: SchedulerSuggestion) => {
    const target = buildSchedulerCompareFocusTarget(suggestion, compare.weekStart);
    if (target.tutorIds.length === 0) return;

    setRightWorkspace("compare");
    void compare.replaceCompare(target.tutorIds, target.weekStart, {
      activeDay: target.activeDay,
    });
  }, [compare]);

  const focusLatestAssistantSuggestion = useCallback((nextMessages: SchedulerMessage[]) => {
    const latestAssistant = [...nextMessages].reverse().find((message) => message.role === "assistant");
    const suggestion = latestAssistant ? payloadFromMessage(latestAssistant)?.suggestions?.[0] : undefined;
    if (suggestion) {
      focusCompareSuggestion(suggestion);
    }
  }, [focusCompareSuggestion]);

  const ensureConversation = async (): Promise<SchedulerConversation> => {
    if (selectedConversation) return selectedConversation;
    const data = await jsonOrThrow<{ conversation: SchedulerConversation }>(
      await fetch("/api/ai-scheduler/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: UNTITLED }),
      }),
    );
    setConversations((prev) => [data.conversation, ...prev]);
    setSelectedId(data.conversation.id);
    setSelectedConversation(data.conversation);
    return data.conversation;
  };

  const sendMessage = async () => {
    const content = composer.trim();
    if (!content || sending || !aiSchedulerEnabled) return;
    setSending(true);
    setError(null);
    setComposer("");
    try {
      const conversation = await ensureConversation();
      const optimistic: SchedulerMessage = {
        id: `temp-${Date.now()}`,
        conversationId: conversation.id,
        role: "admin",
        content,
        structuredPayload: null,
        model: null,
        latencyMs: null,
        createdByEmail: sessionUser.email,
        createdByName: sessionUser.name,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);
      const data = await jsonOrThrow<{
        conversation: SchedulerConversation;
        messages: SchedulerMessage[];
      }>(
        await fetch(`/api/ai-scheduler/conversations/${conversation.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        }),
      );
      setMessages((prev) => [...prev.filter((message) => message.id !== optimistic.id), ...data.messages]);
      setSelectedConversation(data.conversation);
      setDetails(detailsFromConversation(data.conversation));
      setDetailsDirty(false);
      focusLatestAssistantSuggestion(data.messages);
      await loadConversations(data.conversation.id);
      await refreshLineReviews(data.conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      setComposer(content);
    } finally {
      setSending(false);
    }
  };

  const state = selectedConversation?.extractedState ?? {};
  const filters = state.filters ?? {};
  const businessRequirements = state.businessRequirements ?? {};
  const businessRequirementText = [
    businessRequirements.englishProficiency && businessRequirements.englishProficiency !== "unknown"
      ? `English ${businessRequirements.englishProficiency}`
      : undefined,
    ...(businessRequirements.strengthTags ?? []),
    ...(businessRequirements.curriculumExperience ?? []),
    ...(businessRequirements.schoolKeywords ?? []).map((keyword) => `School: ${keyword}`),
  ].filter(Boolean).join(", ");
  const questions = state.unresolvedQuestions ?? [];
  const assumptions = state.assumptions ?? [];

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
      <aside className="flex w-[280px] shrink-0 flex-col overflow-hidden border-r border-border/60 pr-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <h1 className="text-sm font-semibold text-foreground">Scheduler</h1>
            <p className="text-[11px] text-muted-foreground">Shared admin chats</p>
          </div>
          <Button type="button" size="icon-sm" onClick={createConversation} title="New conversation">
            <MessageSquarePlus className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="mb-2 flex items-center gap-1 rounded-md border border-input bg-background px-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="mb-2 flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant={scope === "all" ? "default" : "outline"}
            onClick={() => setScope("all")}
            className="flex-1"
          >
            All
          </Button>
          <Button
            type="button"
            size="xs"
            variant={scope === "mine" ? "default" : "outline"}
            onClick={() => setScope("mine")}
            className="flex-1"
          >
            Mine
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant={includeArchived ? "secondary" : "outline"}
            onClick={() => setIncludeArchived((value) => !value)}
            title="Toggle archived conversations"
          >
            <Archive className="h-3 w-3" aria-hidden />
          </Button>
        </div>
        <div className="mb-2 rounded-md border border-border bg-card/70 p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Inbox className="h-3.5 w-3.5" aria-hidden />
              LINE reviews
            </div>
            <Badge variant={pendingLineReviews.length > 0 ? "default" : "outline"} className="h-5 px-1.5 text-[10px]">
              {pendingLineReviews.length}
            </Badge>
          </div>
          {lineAnalytics && (
            <div className="mb-2 grid grid-cols-3 gap-1 text-center">
              <div className="rounded bg-background px-1 py-1">
                <div className="text-xs font-semibold">{lineAnalytics.classifiedMessages}</div>
                <div className="text-[9px] text-muted-foreground">Classified</div>
              </div>
              <div className="rounded bg-background px-1 py-1">
                <div className="text-xs font-semibold">{lineAnalytics.approvedSent + lineAnalytics.acceptedNoSend}</div>
                <div className="text-[9px] text-muted-foreground">Good</div>
              </div>
              <div className="rounded bg-background px-1 py-1">
                <div className="text-xs font-semibold">{Math.round(lineAnalytics.rejectionRate * 100)}%</div>
                <div className="text-[9px] text-muted-foreground">Reject</div>
              </div>
              <div className="rounded bg-background px-1 py-1">
                <div className="text-xs font-semibold">
                  {lineAnalytics.classificationAccuracy === null ? "-" : `${Math.round(lineAnalytics.classificationAccuracy * 100)}%`}
                </div>
                <div className="text-[9px] text-muted-foreground">Cls acc</div>
              </div>
              <div className="rounded bg-background px-1 py-1">
                <div className="text-xs font-semibold">{lineAnalytics.classificationFalsePositives}/{lineAnalytics.classificationFalseNegatives}</div>
                <div className="text-[9px] text-muted-foreground">FP/FN</div>
              </div>
              <div className="rounded bg-background px-1 py-1">
                <div className="text-xs font-semibold">{lineAnalytics.unverifiedLinkBacklog}</div>
                <div className="text-[9px] text-muted-foreground">Links</div>
              </div>
            </div>
          )}
          {pendingLineReviews.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">No pending LINE scheduling reviews.</div>
          ) : (
            <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
              {pendingLineReviews.map((review) => (
                <button
                  key={review.id}
                  type="button"
                  onClick={() => {
                    if (review.conversationId) setSelectedId(review.conversationId);
                  }}
                  disabled={!review.conversationId}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="truncate text-[11px] font-semibold text-foreground">
                    {review.contactDisplayName || review.lineUserId}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {review.classifierSummary || review.classifierCategory.replace(/_/g, " ")}
                  </div>
                </button>
              ))}
            </div>
          )}
          {lineAnalytics?.averageModelLatencyMs !== null && lineAnalytics?.averageModelLatencyMs !== undefined && (
            <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <BarChart3 className="h-3 w-3" aria-hidden />
              Avg model {Math.round(lineAnalytics.averageModelLatencyMs)}ms
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {loadingList && conversations.length === 0 ? (
            <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">Loading conversations...</div>
          ) : conversations.length === 0 ? (
            <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">No conversations yet.</div>
          ) : conversations.map((conversation) => {
            const active = conversation.id === selectedId;
            return (
              <button
                key={conversation.id}
                type="button"
                onClick={() => setSelectedId(conversation.id)}
                className={cn(
                  "w-full rounded-md border p-2 text-left transition-colors",
                  active ? "border-primary/40 bg-primary/10" : "border-border bg-background hover:bg-muted/60",
                )}
              >
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                    {conversation.title}
                  </div>
                  {conversation.status === "archived" && (
                    <Badge variant="outline" className="h-4 px-1 text-[9px]">Archived</Badge>
                  )}
                </div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">
                  {conversation.customerStudentName || conversation.customerParentName || "No customer label"}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span className="truncate">{conversation.createdByName || conversation.createdByEmail || "Unknown admin"}</span>
                  <span>{formatShortDate(conversation.lastMessageAt)}</span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <section
        className={cn(
          "min-w-0 flex-1 flex-col overflow-hidden",
          compareFullscreen ? "hidden" : "flex",
        )}
      >
        <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden />
              <h2 className="truncate text-sm font-semibold text-foreground">
                {selectedConversation?.title ?? "New scheduler chat"}
              </h2>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {selectedConversation
                ? `Updated ${formatDateTime(selectedConversation.lastMessageAt)}`
                : "Paste parent context and let the assistant collect details."}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" size="sm" variant="outline" onClick={() => void loadConversations(selectedId)}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Refresh
            </Button>
            {selectedConversation?.status === "active" && (
              <Button type="button" size="sm" variant="outline" onClick={archiveSelected}>
                <Archive className="h-3.5 w-3.5" aria-hidden />
                Archive
              </Button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</div>
        )}

        {!aiSchedulerEnabled && (
          <div className="mb-2 rounded-md border border-amber-300/40 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
            AI scheduler is not configured in this environment.
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-card/60 p-3">
          {loadingConversation ? (
            <div className="text-xs text-muted-foreground">Loading chat...</div>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-md text-center">
                <div className="text-sm font-semibold text-foreground">Start with the parent’s message</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  The assistant will extract requirements, search broad partials when needed, and keep the notes saved here.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((message) => {
                const payload = payloadFromMessage(message);
                const suggestions = payload?.suggestions ?? [];
                const availabilitySummary = payload?.availabilitySummary;
                const constraintLedger = payload?.constraintLedger ?? [];
                const parentDraft = payload?.parentMessageDraft;
                const isAdmin = message.role === "admin";
                const isParent = message.role === "parent";
                return (
                  <div
                    key={message.id}
                    className={cn(
                      "rounded-md border p-3",
                      isAdmin
                        ? "ml-auto max-w-[78%] border-primary/20 bg-primary/5"
                        : isParent
                          ? "mr-auto max-w-[84%] border-available/30 bg-available/8"
                          : "mr-auto max-w-[88%] border-border bg-background",
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <span>{isAdmin ? message.createdByName || "Admin" : isParent ? message.createdByName || "Parent via LINE" : "AI Scheduler"}</span>
                      <span>{formatShortDate(message.createdAt)}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{message.content}</div>
                    {payload?.error && (
                      <div className="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{payload.error}</div>
                    )}
                    {suggestions.length > 0 && (
                      <div className="mt-3 grid gap-2 lg:grid-cols-2">
                        {suggestions.slice(0, 4).map((suggestion) => (
                          <SuggestionCard
                            key={suggestion.id}
                            suggestion={suggestion}
                            onCompareSuggestion={focusCompareSuggestion}
                          />
                        ))}
                      </div>
                    )}
                    {payload?.questions && payload.questions.length > 0 && (
                      <div className="mt-2 rounded-md border border-amber-300/40 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                        {payload.questions[0]}
                      </div>
                    )}
                    {availabilitySummary && (
                      <AvailabilitySummaryPanel summary={availabilitySummary} />
                    )}
                    {constraintLedger.length > 0 && (
                      <ConstraintLedgerPanel ledger={constraintLedger} />
                    )}
                    {parentDraft && (
                      <ParentDraft
                        messageId={message.id}
                        conversationId={message.conversationId}
                        initialDraft={parentDraft}
                        suggestions={suggestions}
                      />
                    )}
                  </div>
                );
              })}
              {selectedLineReviews.length > 0 && (
                <div className="space-y-2">
                  {selectedLineReviews.map((review) => (
                    <LineReviewPanel
                      key={review.id}
                      review={review}
                      onUpdated={replaceLineReview}
                    />
                  ))}
                </div>
              )}
              {sending && (
                <div className="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
                  Searching Wise-backed availability...
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-2 shrink-0 rounded-md border border-border bg-background p-2">
          <Textarea
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void sendMessage();
              }
            }}
            disabled={sending || !aiSchedulerEnabled || selectedConversation?.status === "archived"}
            placeholder="Paste parent request or continue the conversation..."
            rows={3}
            className="min-h-[78px] resize-none border-0 px-1 py-1 text-sm shadow-none focus-visible:ring-0"
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <div className="text-[11px] text-muted-foreground">
              Shared with admins · {sessionUser.name}
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => void sendMessage()}
              disabled={!composer.trim() || sending || !aiSchedulerEnabled || selectedConversation?.status === "archived"}
            >
              <Send className="h-3.5 w-3.5" aria-hidden />
              {sending ? "Sending" : "Send"}
            </Button>
          </div>
        </div>
      </section>

      <aside
        className={cn(
          "flex min-w-0 flex-col overflow-hidden border-l border-border/60",
          compareFullscreen ? "flex-1 border-l-0 pl-0" : "min-w-[520px] basis-[48%] pl-3",
        )}
      >
        <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
          <div className="inline-flex rounded-md border border-border bg-background p-0.5">
            <button
              type="button"
              onClick={() => setRightWorkspace("compare")}
              className={cn(
                "h-7 rounded px-3 text-xs font-medium transition-colors",
                rightWorkspace === "compare"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              Compare
            </button>
            <button
              type="button"
              onClick={() => {
                setRightWorkspace("notes");
                setCompareFullscreen(false);
              }}
              className={cn(
                "h-7 rounded px-3 text-xs font-medium transition-colors",
                rightWorkspace === "notes"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              Notes
            </button>
          </div>
          <div className="min-w-0 text-right">
            <div className="truncate text-xs font-semibold text-foreground">
              {rightWorkspace === "compare" ? "Tutor Compare" : "Customer Notes"}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {rightWorkspace === "compare"
                ? "Focused from scheduler suggestions"
                : "Autosaved to this shared conversation"}
            </div>
          </div>
        </div>

        {rightWorkspace === "compare" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ComparePanel
              compare={compare}
              tutorList={tutorList}
              isFullscreen={compareFullscreen}
              onToggleFullscreen={() => setCompareFullscreen((value) => !value)}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <div className="space-y-2 rounded-md border border-border bg-card/70 p-2">
              <label className="block text-[11px] font-medium text-muted-foreground">
                Title
                <Input value={details.title} onChange={(event) => updateDetail("title", event.target.value)} className="mt-1 text-xs" />
              </label>
              <label className="block text-[11px] font-medium text-muted-foreground">
                Parent
                <Input value={details.customerParentName} onChange={(event) => updateDetail("customerParentName", event.target.value)} className="mt-1 text-xs" />
              </label>
              <label className="block text-[11px] font-medium text-muted-foreground">
                Student
                <Input value={details.customerStudentName} onChange={(event) => updateDetail("customerStudentName", event.target.value)} className="mt-1 text-xs" />
              </label>
              <label className="block text-[11px] font-medium text-muted-foreground">
                Contact
                <Input value={details.customerContact} onChange={(event) => updateDetail("customerContact", event.target.value)} className="mt-1 text-xs" />
              </label>
              <label className="block text-[11px] font-medium text-muted-foreground">
                Notes
                <Textarea
                  value={details.notes}
                  onChange={(event) => updateDetail("notes", event.target.value)}
                  rows={7}
                  className="mt-1 min-h-[150px] resize-none text-xs leading-relaxed"
                />
              </label>
              <div className="h-4 text-[10px] text-muted-foreground">
                {detailsDirty ? "Saving..." : selectedConversation ? "Saved" : ""}
              </div>
            </div>

            <div className="rounded-md border border-border bg-card/70 p-2">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Extracted Requirements
              </div>
              <div className="grid grid-cols-2 gap-2">
                <RequirementPill label="Type" value={state.searchMode === "one_time" ? "One-time" : "Recurring"} />
                <RequirementPill label="Day/date" value={state.date || (typeof state.dayOfWeek === "number" ? DAY_NAMES[state.dayOfWeek] : undefined)} />
                <RequirementPill label="Time" value={state.startTime && state.endTime ? `${state.startTime}-${state.endTime}` : undefined} />
                <RequirementPill label="Duration" value={state.durationMinutes ? `${state.durationMinutes} min` : "60 min default"} />
                <RequirementPill label="Mode" value={formatMode(state.mode)} />
                <RequirementPill label="Tutor" value={state.tutorNames?.join(", ")} />
                <RequirementPill label="Subject" value={filters.subject} />
                <RequirementPill label="Level" value={filters.level} />
                <RequirementPill label="Requested level" value={state.academicLevelResolution?.rawLevelLabel} />
                <RequirementPill label="Tutor context" value={businessRequirementText} />
              </div>
              {state.academicLevelResolution && (
                <div className="mt-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground">
                  {state.academicLevelResolution.message}
                </div>
              )}
            </div>

            {(questions.length > 0 || assumptions.length > 0 || (state.explicitUnknownFilters?.length ?? 0) > 0 || (state.explicitUnknownBusinessRequirements?.length ?? 0) > 0) && (
              <div className="rounded-md border border-border bg-card/70 p-2">
                {questions.length > 0 && (
                  <>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Open Questions</div>
                    <ul className="mt-1 space-y-1 text-xs text-foreground">
                      {questions.map((question) => <li key={question}>{question}</li>)}
                    </ul>
                  </>
                )}
                {assumptions.length > 0 && (
                  <>
                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Assumptions</div>
                    <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                      {assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
                    </ul>
                  </>
                )}
                {state.explicitUnknownFilters && state.explicitUnknownFilters.length > 0 && (
                  <>
                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Unmapped</div>
                    <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                      {state.explicitUnknownFilters.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </>
                )}
                {state.explicitUnknownBusinessRequirements && state.explicitUnknownBusinessRequirements.length > 0 && (
                  <>
                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Unmapped tutor context</div>
                    <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                      {state.explicitUnknownBusinessRequirements.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </>
                )}
              </div>
            )}

            <Link
              href="/search"
              className="inline-flex h-8 w-full items-center justify-center gap-1 rounded-md border border-border text-xs font-medium hover:bg-muted"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              Open manual search
            </Link>
          </div>
        )}
      </aside>
    </div>
  );
}

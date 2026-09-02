"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  FeedbackMutationRequest,
  FeedbackSessionRow,
  PostClassFeedbackPayload,
} from "@/types/post-class-feedback";
import {
  EmptyPanel,
  OutcomeBadge,
  SubmitterBadge,
  feedbackOutcome,
  formatBangkokDate,
  formatEligibilityReason,
} from "./feedback-ui";
import { SessionDetailDialog } from "./session-detail-dialog";

type OutcomeFilter = "all" | ReturnType<typeof feedbackOutcome>;
type ReminderFilter = "all" | FeedbackSessionRow["reminder"]["status"];

export interface OperationsFilters {
  query: string;
  outcome: OutcomeFilter;
  reminder: ReminderFilter;
  source: "all" | FeedbackSessionRow["sourceStatus"];
  submitter: "all" | FeedbackSessionRow["submittedBy"];
}

const PAGE_SIZE = 25;

export function filterFeedbackSessions(
  sessions: FeedbackSessionRow[],
  filters: OperationsFilters,
): FeedbackSessionRow[] {
  const needle = filters.query.trim().toLocaleLowerCase();
  return sessions.filter((session) => {
    if (filters.outcome !== "all" && feedbackOutcome(session) !== filters.outcome) return false;
    if (filters.reminder !== "all" && session.reminder.status !== filters.reminder) return false;
    if (filters.source !== "all" && session.sourceStatus !== filters.source) return false;
    if (filters.submitter !== "all" && session.submittedBy !== filters.submitter) return false;
    if (!needle) return true;
    return [
      session.tutorName,
      session.className,
      session.subject,
      session.wiseSessionId,
      formatEligibilityReason(session.eligibilityReason),
      ...session.students,
    ].some((value) => value.toLocaleLowerCase().includes(needle));
  });
}

function NativeFilter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        className="h-8 min-w-32 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

function CharacterMeter({ session }: { session: FeedbackSessionRow }) {
  if (!session.eligible) return <span className="text-xs text-muted-foreground">Not assessed</span>;
  const count = session.combinedCharacterCount;
  const complete = count >= 300;
  const percent = Math.min(100, (count / 300) * 100);
  return (
    <div className="min-w-24">
      <div className={cn("text-xs font-medium tabular-nums", complete ? "text-emerald-700" : "text-amber-700")}>
        {count.toLocaleString()} / 300
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", complete ? "bg-emerald-500" : "bg-amber-500")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function ReminderCell({ session }: { session: FeedbackSessionRow }) {
  if (!session.eligible) return <span className="text-muted-foreground">—</span>;
  const { reminder } = session;
  if (reminder.status === "none") return <span className="text-muted-foreground">—</span>;
  return (
    <div className={cn("text-xs", reminder.status === "failed" ? "text-red-700" : "text-muted-foreground")}>
      <div className="capitalize">{reminder.status}</div>
      <div>{reminder.lastKind ? reminder.lastKind.replaceAll("_", " ") : null}</div>
    </div>
  );
}

function SessionQueue({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: FeedbackSessionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = sessions.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  if (sessions.length === 0) {
    return <EmptyPanel title="No sessions match" detail="Adjust the search or filters to see more feedback obligations." />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 border-b bg-card text-[11px] text-muted-foreground">
            <tr>
              <th className="w-8 px-3 py-2.5"><span className="sr-only">Selected</span></th>
              <th className="px-2 py-2.5 font-medium">Tutor</th>
              <th className="px-2 py-2.5 font-medium">Session / students</th>
              <th className="px-2 py-2.5 font-medium">Deadline</th>
              <th className="px-2 py-2.5 font-medium">Characters</th>
              <th className="px-2 py-2.5 font-medium">Submitted by</th>
              <th className="px-2 py-2.5 font-medium">Outcome / eligibility</th>
              <th className="px-2 py-2.5 font-medium">Reminder</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((session) => {
              const selected = session.id === selectedId;
              return (
                <tr
                  key={session.id}
                  aria-selected={selected}
                  aria-label={`Open ${session.className || session.subject} feedback detail`}
                  className={cn(
                    "cursor-pointer border-b transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selected && "bg-sky-50/80 shadow-[inset_3px_0_0_0_var(--color-primary)] dark:bg-sky-950/30",
                  )}
                  onClick={() => onSelect(session.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(session.id);
                    }
                  }}
                  tabIndex={0}
                >
                  <td className="px-3 py-2.5">
                    <span className={cn(
                      "block size-3.5 rounded-full border",
                      selected ? "border-primary bg-primary ring-2 ring-sky-100" : "border-muted-foreground/50",
                    )} />
                  </td>
                  <td className="px-2 py-2.5">
                    <div className="max-w-40 truncate font-medium">{session.tutorName}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{session.tutorKey}</div>
                  </td>
                  <td className="px-2 py-2.5">
                    <div className="max-w-56 truncate font-medium">{session.className || session.subject}</div>
                    <div className="max-w-56 truncate text-[11px] text-muted-foreground">{session.students.join(", ") || "No student name"}</div>
                  </td>
                  <td className={cn("px-2 py-2.5 tabular-nums", feedbackOutcome(session) === "missing" && "text-red-700")}>
                    {formatBangkokDate(session.deadlineAt, true)}
                  </td>
                  <td className="px-2 py-2.5"><CharacterMeter session={session} /></td>
                  <td className="px-2 py-2.5"><SubmitterBadge submitter={session.submittedBy} /></td>
                  <td className="px-2 py-2.5">
                    <OutcomeBadge session={session} />
                    {!session.eligible ? (
                      <div className="mt-1 max-w-44 text-[10px] leading-snug text-muted-foreground">{formatEligibilityReason(session.eligibilityReason)}</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2.5"><ReminderCell session={session} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
        <span>Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, sessions.length)} of {sessions.length}</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            <ChevronLeft aria-hidden="true" /><span className="sr-only">Previous page</span>
          </Button>
          <span className="min-w-16 text-center tabular-nums">{safePage} / {pageCount}</span>
          <Button variant="outline" size="icon-sm" disabled={safePage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>
            <ChevronRight aria-hidden="true" /><span className="sr-only">Next page</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function OperationsTab({
  payload,
  submitting,
  onMutation,
}: {
  payload: PostClassFeedbackPayload;
  submitting: boolean;
  onMutation: (request: FeedbackMutationRequest) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [reminder, setReminder] = useState<ReminderFilter>("all");
  const [source, setSource] = useState<OperationsFilters["source"]>("all");
  const [submitter, setSubmitter] = useState<OperationsFilters["submitter"]>("all");

  const sessions = useMemo(() => filterFeedbackSessions(payload.sessions, {
    query: deferredQuery,
    outcome,
    reminder,
    source,
    submitter,
  }), [deferredQuery, outcome, payload.sessions, reminder, source, submitter]);
  const selected = payload.sessions.find((session) => session.id === selectedId) ?? null;

  async function handleMutation(request: FeedbackMutationRequest) {
    await onMutation(request);
    setDetailRefreshToken((value) => value + 1);
  }

  return (
    <>
      <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm lg:h-[calc(100vh-20rem)] lg:min-h-[620px] lg:max-h-[720px]">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <label className="relative min-w-52 flex-1">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input className="pl-8" placeholder="Search tutor, student, class, Wise ID, or eligibility…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <NativeFilter label="Outcome" value={outcome} onChange={(value) => setOutcome(value as OutcomeFilter)}>
            <option value="all">All outcomes</option>
            <option value="missing">Missing</option>
            <option value="late">Late</option>
            <option value="on_time">On time</option>
            <option value="timing_unknown">Timing unknown</option>
            <option value="not_due">Not due</option>
            <option value="source_paused">Source paused</option>
            <option value="excluded">Excluded</option>
          </NativeFilter>
          <NativeFilter label="Reminder" value={reminder} onChange={(value) => setReminder(value as ReminderFilter)}>
            <option value="all">All reminders</option>
            <option value="pending">Pending</option>
            <option value="sending">Sending</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="none">None</option>
          </NativeFilter>
          <NativeFilter label="Source" value={source} onChange={(value) => setSource(value as OperationsFilters["source"])}>
            <option value="all">All sources</option>
            <option value="ready">Ready</option>
            <option value="unavailable">Unavailable</option>
            <option value="form_drift">Form drift</option>
            <option value="identity_review">Identity review</option>
          </NativeFilter>
          <NativeFilter label="Submitted by" value={submitter} onChange={(value) => setSubmitter(value as OperationsFilters["submitter"])}>
            <option value="all">Any submitter</option>
            <option value="tutor">Tutor</option>
            <option value="admin">Admin on behalf</option>
            <option value="auto">Auto-submitted</option>
            <option value="none">No submission</option>
          </NativeFilter>
          <span className="w-full text-[11px] text-muted-foreground sm:w-auto">Select a row to load exact Wise evidence.</span>
        </div>
        <SessionQueue sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      <SessionDetailDialog
        session={selected}
        capabilities={payload.capabilities}
        submitting={submitting}
        refreshToken={detailRefreshToken}
        onOpenChange={(open) => { if (!open) setSelectedId(null); }}
        onMutation={handleMutation}
      />
    </>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import { buildInbox, filterInbox } from "@/lib/feedback-autowriter/inbox";
import type { AutowriterReview, AutowriterReviewUnavailable } from "@/lib/feedback-autowriter/review-data";
import type { AutowriterTrends, TrendRangeDays } from "@/lib/feedback-autowriter/trends";
import { cn } from "@/lib/utils";
import { ClassesLog } from "./classes-log";
import { clock, longDate } from "./format";
import { HealthRail } from "./health-rail";
import { Inbox } from "./inbox";
import { ItemDrawer, type DrawerTarget } from "./item-drawer";
import { SystemDetails } from "./system-details";
import { SystemLine } from "./system-line";
import { TrendCharts } from "./trend-charts";
import { TutorFilterChip, TutorTable } from "./tutor-table";

// ----------------------------------------------------------------------------
// The page's shell: the three payloads and their polling, the range and the
// tutor filter, the drawer, and the layout (mockup A): the system line, the
// to-do list beside the health rail, the trends, the tutors, the details.
// ----------------------------------------------------------------------------

/** The all-tutors key of the trends route (`ALL_TUTORS`). */
const ALL_TUTORS = "*";
const DASHBOARD_POLL_MS = 60_000;
const REVIEW_POLL_MS = 5 * 60_000;

function isDashboard(value: unknown): value is AutowriterDashboard {
  return typeof value === "object" && value !== null
    && "totals" in value && "control" in value && "recent" in value && "holds" in value && "system" in value;
}

function isReview(value: unknown): value is AutowriterReview {
  return typeof value === "object" && value !== null && (value as { available?: unknown }).available === true
    && "gate" in value && "queue" in value && "daily" in value;
}

function isUnavailable(value: unknown): value is AutowriterReviewUnavailable {
  return typeof value === "object" && value !== null && (value as { available?: unknown }).available === false;
}

function isTrends(value: unknown): value is AutowriterTrends {
  return typeof value === "object" && value !== null && "range" in value && "days" in value && "totals" in value;
}

function errorOf(json: unknown, status: number): string {
  const error = (json as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : `HTTP ${status}`;
}

export function FeedbackAutowriterDashboard({ initialData, canControl, initialReview = null, initialTrends = null }: {
  initialData: AutowriterDashboard;
  /** The owner: reviews, acknowledges, pauses and switches tutors. Every other admin reads. */
  canControl: boolean;
  /** The review data, or why it is unavailable (migration 0101 not applied, or a load failure). */
  initialReview?: AutowriterReview | AutowriterReviewUnavailable | null;
  /** The trend series of the last 14 days for all tutors; null when they could not load. */
  initialTrends?: AutowriterTrends | null;
}) {
  const [data, setData] = useState(initialData);
  const [review, setReview] = useState<AutowriterReview | AutowriterReviewUnavailable | null>(initialReview);
  const [trends, setTrends] = useState<AutowriterTrends | null>(initialTrends);
  const [rangeDays, setRangeDays] = useState<TrendRangeDays>(initialTrends?.range.days ?? 14);
  const [tutorKey, setTutorKey] = useState<string | null>(null);
  const [target, setTarget] = useState<DrawerTarget | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [trendsLoading, setTrendsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestSequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const trendsSequence = useRef(0);
  const trendsControllerRef = useRef<AbortController | null>(null);
  const windowDays = initialData.windowDays;

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch(`/api/feedback-autowriter?days=${windowDays}`, { cache: "no-store", signal: controller.signal });
      const json: unknown = await response.json().catch(() => null);
      if (sequence !== requestSequence.current) return;
      if (!response.ok || !isDashboard(json)) {
        setError(errorOf(json, response.status));
        return;
      }
      setData(json);
      setError(null);
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError("Could not refresh the dashboard.");
    } finally {
      if (sequence === requestSequence.current) setRefreshing(false);
    }
  }, [windowDays]);

  const loadReview = useCallback(async () => {
    try {
      const response = await fetch("/api/feedback-autowriter/review", { cache: "no-store" });
      const json: unknown = await response.json().catch(() => null);
      if (response.ok && (isUnavailable(json) || isReview(json))) {
        setReview(json);
        return;
      }
      setError(errorOf(json, response.status));
    } catch {
      setError("Could not refresh the review data.");
    }
  }, []);

  const loadTrends = useCallback(async (days: TrendRangeDays, tutor: string | null) => {
    const sequence = ++trendsSequence.current;
    trendsControllerRef.current?.abort();
    const controller = new AbortController();
    trendsControllerRef.current = controller;
    setTrendsLoading(true);
    try {
      const query = `days=${days}&tutor=${encodeURIComponent(tutor ?? ALL_TUTORS)}`;
      const response = await fetch(`/api/feedback-autowriter/trends?${query}`, { cache: "no-store", signal: controller.signal });
      const json: unknown = await response.json().catch(() => null);
      if (sequence !== trendsSequence.current) return;
      // Charts of another range or tutor would be mislabelled: a failed load shows the message instead.
      setTrends(response.ok && isTrends(json) ? json : null);
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      if (sequence === trendsSequence.current) setTrends(null);
    } finally {
      if (sequence === trendsSequence.current) setTrendsLoading(false);
    }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => void load(), DASHBOARD_POLL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    const interval = window.setInterval(() => void loadReview(), REVIEW_POLL_MS);
    return () => window.clearInterval(interval);
  }, [loadReview]);

  /** Everything the page shows, again: after an action, and on Refresh. */
  const reloadAll = useCallback(async () => {
    await Promise.all([load(), loadReview(), loadTrends(rangeDays, tutorKey)]);
  }, [load, loadReview, loadTrends, rangeDays, tutorKey]);

  const changeRange = (days: TrendRangeDays) => {
    setRangeDays(days);
    void loadTrends(days, tutorKey);
  };

  const selectTutor = (key: string | null) => {
    setTutorKey(key);
    void loadTrends(rangeDays, key);
  };

  const sendControl = async (body: Record<string, unknown>, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/feedback-autowriter/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => null) as { error?: unknown; requeued?: number } | null;
      if (!response.ok) {
        setError(errorOf(json, response.status));
        return;
      }
      setNote(json?.requeued ? `Saved. ${json.requeued} shadow draft(s) queued for posting.` : "Saved.");
      await load();
    } catch {
      setError("Could not reach the control route.");
    } finally {
      setBusy(false);
    }
  };

  const loaded = review?.available ? review : null;
  const unavailableReason = review && !review.available ? review.reason : null;
  // The payload's own clock: the same on the server and in the browser, and a minute old at most.
  const now = useMemo(() => new Date(data.generatedAt), [data.generatedAt]);
  const inbox = useMemo(() => buildInbox(data, loaded, { now }), [data, loaded, now]);
  const shown = useMemo(() => filterInbox(inbox, tutorKey), [inbox, tutorKey]);
  const filteredTo = tutorKey ? data.tutors.find((tutor) => tutor.tutorKey === tutorKey)?.displayName ?? tutorKey : null;
  const halted = Boolean(data.control.haltedAt);
  const headline = halted ? "Posting is halted. That needs you first."
    : inbox.length === 0 ? "Nothing needs you. Back to teaching."
      : "A little attention. Then back to teaching.";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto scroll-smooth">
      <div className="mx-auto w-full max-w-[1440px] pb-10 lg:px-6">
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b pt-1.5 pb-4">
          <div className="flex items-center gap-10">
            <div className="flex items-center gap-2.5">
              <span aria-hidden className="grid size-[30px] place-items-center rounded-lg border border-sky-200 bg-sky-50 text-sky-600 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300">
                <Sparkles className="size-4" strokeWidth={1.6} />
              </span>
              <h1 className="text-[15px] font-[650] tracking-[-0.03em]">Feedback Autowriter</h1>
            </div>
            <nav aria-label="On this page" className="hidden items-center gap-7 text-xs text-muted-foreground md:flex">
              <a className="hover:text-foreground" href="#autowriter-overview">Overview</a>
              <a className="hover:text-foreground" href="#autowriter-trends">Trends</a>
              <a className="hover:text-foreground" href="#autowriter-tutors">Tutors</a>
              <a className="hover:text-foreground" href="#autowriter-details">Details</a>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Updated {clock(data.generatedAt)}</span>
            <Button size="sm" variant="outline" className="h-7 rounded-md px-2.5 text-[11px] font-[550]" onClick={() => void reloadAll()} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </header>

        <div className="mt-3">
          <SystemLine dashboard={data} lastRun={loaded ? loaded.lastRun : undefined} canControl={canControl} busy={busy}
            onControl={(body, confirmText) => void sendControl(body, confirmText)} />
        </div>
        {error || note ? (
          <div role="status" className={cn("mt-3 rounded-md border px-3 py-2 text-xs", error ? "border-red-300 text-red-700" : "border-available/30 text-available")}>
            {error ?? note}
          </div>
        ) : null}

        <section id="autowriter-overview" className="mt-7 mb-[23px] flex scroll-mt-4 flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[25px] leading-tight font-[650] tracking-[-0.035em]">{headline}</p>
            <p className="mt-[7px] text-xs text-muted-foreground">
              {longDate(data.today.date)} <span aria-hidden className="mx-1.5 text-muted-foreground/50">/</span> All times Bangkok · Online 1:1 pilot.
              In-person classes stay with the tutor and are not shown here.
            </p>
          </div>
          {tutorKey && filteredTo ? <TutorFilterChip name={filteredTo} onClear={() => selectTutor(null)} /> : null}
        </section>

        <div className="grid items-stretch gap-5 lg:grid-cols-3">
          <Inbox className="lg:col-span-2" items={shown} dashboard={data} review={loaded} now={now} filteredTo={filteredTo}
            reviewUnavailable={loaded === null} onOpen={setTarget} />
          <HealthRail dashboard={data} review={loaded} unavailableReason={unavailableReason} />
        </div>

        <TrendCharts trends={trends} review={loaded} unavailableReason={unavailableReason} rangeDays={rangeDays} onRangeChange={changeRange}
          loading={trendsLoading} filteredTo={filteredTo} />

        <TutorTable dashboard={data} review={loaded} now={now} selectedTutorKey={tutorKey} onSelect={selectTutor} canControl={canControl} busy={busy}
          onControl={(body, confirmText) => void sendControl(body, confirmText)} />

        <section id="autowriter-details" aria-labelledby="autowriter-details-title" className="scroll-mt-4">
          <div className="mt-7 mb-[13px] flex flex-wrap items-baseline gap-x-2.5">
            <h2 id="autowriter-details-title" className="text-[15px] font-[650] tracking-[-0.02em]">Details</h2>
            <span className="text-[11px] text-muted-foreground">Every class and the exact numbers · closed until you open them</span>
          </div>
          <div className="space-y-3">
            <ClassesLog dashboard={data} review={loaded} tutorKey={tutorKey} onTutorChange={selectTutor} onOpen={setTarget} />
            <SystemDetails dashboard={data} review={loaded} onOpen={setTarget} />
          </div>
        </section>
      </div>

      <ItemDrawer target={target} dashboard={data} review={loaded} now={now} canControl={canControl} onChanged={reloadAll} onOpen={setTarget}
        onClose={() => setTarget(null)} />
    </div>
  );
}

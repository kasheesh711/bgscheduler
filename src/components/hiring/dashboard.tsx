"use client";

import Link from "next/link";

import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Instrument_Serif } from "next/font/google";
import { signIn } from "next-auth/react";
import { isRoleView, nickname } from "@/lib/hiring/role-views";
import { headName } from "@/lib/hiring/run-sheet";
import { GOOGLE_FREEBUSY_SCOPE, GOOGLE_SCOPES, type HiringConfig, type Stage, type Subject } from "@/lib/hiring/model";
import { assessmentRows } from "@/lib/hiring/assessment-view";
import { buildInsights, readyToInvite } from "@/lib/hiring/insights";
import { dedupePriority, headDaysNotice } from "@/lib/hiring/rules";
import { candidateExtras, holdNote } from "@/lib/hiring/status";
import { campaignNames } from "@/lib/hiring/seek-view";
import type { dashboard } from "@/lib/hiring/service";
import { HIRING_REPORTS, HIRING_VIEWS as VIEWS, hiringReportHref, restoreHiringScroll, saveHiringScroll } from "./hiring-report-nav";
import { CandidateInspector } from "./candidate-inspector";
import { CandidateTable, focusCandidateResults } from "./candidate-table";
import { EvidenceChart, LimitMeters, ScoreChart, SubjectChart } from "./pipeline-charts";
import { AssessmentScreen } from "./assessment-screen";
import { OperationsRail, WorkerBanner } from "./operations-rail";
import { AdminScreen, HeadsScreen, HrScreen, HiringReviewScreen, TodayCalls } from "./role-screens";
import { PreScreenScreen } from "./prescreen-screen";
import { CallsScreen } from "./calls-screen";
import { CapacityScreen } from "./capacity-screen";
import { OverviewAnalytics } from "./overview-analytics";
import type { CapacityReport } from "@/lib/hiring/capacity";
import { DemoBar, useDemoState, type DemoView } from "./demo-bar";
import { demoFetchInstalled, installDemoFetch } from "@/lib/hiring/demo";
import { RunSheetScreen } from "./run-sheet-screen";
import { SeekScreen } from "./seek-screen";
import { SetupPanel } from "./setup-panel";
import { TabSkeleton } from "./tab-skeleton";
import css from "./dashboard.module.css";
import nav from "./pipeline-nav.module.css";

const serif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
});

export type HiringData = Awaited<ReturnType<typeof dashboard>> & {
  reviewAccess?: { hr: boolean; gift: boolean };
  /** The head who is signed in, so /hiring opens on their own Heads screen. Null for other staff. */
  viewerHead?: string | null;
  /** The head who gives the final sign-off (Gift). Their Heads screen lists the final reviews too. */
  finalReviewer?: string | null;
  google: { connected: boolean; email: string; lastError: string | null; callCalendar: "readable" | "reconnect" | "unreadable" };
};
export type HiringCandidate = HiringData["candidates"][number];
export type PreScreenFilter = "all" | "Queued" | "Sent" | "Replied" | "No reply" | "Visit booked";
export type CandidateFilter = {
  stage: Stage | "all" | "ready";
  prescreen: PreScreenFilter;
  bucket: number | null;
  subject: Subject | null;
  /** Only these candidates, such as the stuck ones from the pipeline board. */
  ids?: string[];
  /** What `ids` are, for the filter line ("Stuck" when absent). */
  label?: string;
  timingEvidence?: Record<string, string>;
};
export type Command = (body: unknown, onReload?: (data: HiringData | null) => void, onError?: (message: string, status?: number) => void) => Promise<boolean>;
export const NO_FILTER: CandidateFilter = { stage: "all", prescreen: "all", bucket: null, subject: null };

export type HiringView = keyof typeof VIEWS;
// Kevin, 24 Nov 2026: there is no HR team now. SEEK intake and HR calls are retired from the tabs, and the HR role screen
// has no button. The screens stay in the code, and `?view=seek`, `?view=calls` and `?view=hr` still open them: Gift's
// review link uses `?view=hr`.
const STEPS = ["prescreen", "assessment", "mock", "review", "offer"] as const;
const WORKSPACE = ["overview", "capacity", "visitday"] as const;
const MORE_TOOLS = ["setup", "admin", "heads"] as const;
const TOOL_HINTS = { setup: "Scores, limits and messages", admin: "Prepare rooms and papers", heads: "Mock teaching and decisions" } as const;
const REPORT_HINTS = { "current-funnel": "Stage waits and follow-up", "paper-results": "Scores and cutoffs", "ats-outcomes": "Invitation scores and outcomes" } as const;

function closeToolsMenu(menu: HTMLDetailsElement) {
  menu.open = false;
  menu.querySelector("summary")?.focus({ preventScroll: true });
}

function dismissToolsMenu(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key !== "Escape" || !event.currentTarget.open) return;
  event.preventDefault();
  event.stopPropagation();
  closeToolsMenu(event.currentTarget);
}
function ToolsMenu({ label, children, className, panelClass, review }: {
  label: ReactNode; children: ReactNode; className: string; panelClass: string; review?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const keyboard = useRef(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const menu = ref.current;
    if (!open || !menu) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target)) {
        if (menu.contains(document.activeElement)) closeToolsMenu(menu);
        else menu.open = false;
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return <details ref={ref} className={className} data-review={review ? "" : undefined}
    onKeyDown={dismissToolsMenu}
    onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }}
    onToggle={(event) => {
      const menu = event.currentTarget;
      setOpen(menu.open);
      if (menu.open && keyboard.current) close.current?.focus({ preventScroll: true });
      keyboard.current = false;
    }}>
    <summary onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") keyboard.current = true;
    }}>{label}</summary>
    <div className={panelClass}>
      <button ref={close} type="button" className={nav.closeTools} onClick={() => {
        if (ref.current) closeToolsMenu(ref.current);
      }}>Close menu <kbd>Esc</kbd></button>
      {children}
    </div>
  </details>;
}

/** One line under the tabs, so a new user can name what each tab is for. */
const PURPOSE: Record<Exclude<HiringView, "hr" | "heads" | "offer" | "prescreen">, string> = {
  overview: "Where every candidate stands, and who is ready for the next step.",
  capacity: "Which subjects need new tutors first, from busy-hours use and new students.",
  seek: "Check applications from SEEK and their ATS scores.",
  calls: "HR speaks to the candidate and records the call outcome and notes.",
  visitday: "See arrival times, papers to print and the tutors assigned to mock teaching.",
  assessment: "",
  mock: "The tutor gets the graded paper and résumé before the mock. After the rubric, Yes goes to the final review and No queues a rejection email.",
  review: "Kevin adds the behavioral assessment and sends the packet to Gift for approval or rejection.",
  setup: "Scores, limits, heads and messages. A change applies to every tab.",
  admin: "Who comes when, the paper to print, and where to upload the completed paper.",
};
/** The browser remembers a role screen, so /hiring opens on it the next time. */
const ROLE_KEY = "hiring-role-view";
function remember(name: string | null) {
  try {
    if (name) window.localStorage.setItem(ROLE_KEY, name);
    else window.localStorage.removeItem(ROLE_KEY);
  } catch {
    // Storage can be blocked. The link still opens the screen.
  }
}

function subscribeToReviewLink(change: () => void) {
  window.addEventListener("hashchange", change);
  window.addEventListener("popstate", change);
  return () => {
    window.removeEventListener("hashchange", change);
    window.removeEventListener("popstate", change);
  };
}

/**
 * `head`: the signed-in head, known before the data loads, so a head never sees the full dashboard first.
 * `fullAccess`: the signed-in admin has no page limit, so as a head they keep the way to the full dashboard.
 */
export function HiringDashboard({ head = null, fullAccess = false }: { head?: string | null; fullAccess?: boolean } = {}) {
  const [data, setData] = useState<HiringData | null>(null);
  const [config, setConfig] = useState<HiringConfig | null>(null);
  const [configRevision, setConfigRevision] = useState(0);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const search = useSearchParams();
  const param = search.get("view");
  // ?head=Ek: staff open that head's screen as the head sees it.
  const headParam = search.get("head");
  // Demo mode (?demo=1): a made-up candidate, and every hiring request is answered in the browser. See demo.ts.
  const demo = search.get("demo") === "1";
  // Before any child effect can send a request. The call does nothing after the first time.
  if (demo) installDemoFetch();
  // A menu link can leave demo mode with no page load. The real page must never read demo answers, so load it again.
  useEffect(() => {
    if (!demo && demoFetchInstalled()) window.location.reload();
  }, [demo]);
  const demoStep = useDemoState();
  const [briefOpen, setBriefOpen] = useState(false);
  const [newReportTab, setNewReportTab] = useState(false);
  const hash = useSyncExternalStore(subscribeToReviewLink, () => window.location.hash, () => null);
  const reviewLink = param === "hr" && hash ? /^#review-(.+)$/.exec(hash)?.[1] : undefined;
  const giftOnly = !!data?.reviewAccess?.gift && !data.reviewAccess.hr;
  const linkedReview = data?.reviewAccess?.gift ? reviewLink : undefined;
  // Gift's review email link opens her Heads screen with that review open, when she is a head; else the review screen.
  const view: HiringView = giftOnly && linkedReview ? ((data?.viewerHead ?? head) ? "heads" : "review") : param && Object.hasOwn(VIEWS, param) ? (param as HiringView) : (data?.viewerHead ?? head ?? headParam) ? "heads" : "overview";
  const giftReview = view === "review" && giftOnly;
  const offer = view === "offer";
  const prescreen = view === "prescreen";
  const compactQueue = offer || prescreen;
  const offerLoadFailed = offer && (data ? data.offers == null : !!error);
  const loaded = !!data;
  const [overviewOpened, setOverviewOpened] = useState(false);
  useEffect(() => {
    if (loaded && view === "overview") setOverviewOpened(true);
  }, [loaded, view]);
  const [messageKey, setMessageKey] = useState<string | null>();
  // Next.js keeps useSearchParams in step with pushState, and this does not reload the page.
  const setView = (name: HiringView, keepRole = false) => {
    if (name !== "setup") setMessageKey(undefined);
    // Leaving a role screen for the full dashboard forgets it. Opening one remembers it.
    if (!keepRole && !demo) remember(isRoleView(name) ? name : null);
    if (name !== view) window.history.pushState(null, "", `?view=${name}${demo ? "&demo=1" : ""}`);
  };
  const role = isRoleView(view);
  useEffect(() => {
    // The demo must not change the screen that the real /hiring opens on.
    if (demo || hash === null || (reviewLink && (!loaded || giftOnly))) return;
    if (isRoleView(param)) return remember(param);
    // A signed-in head always opens on their own list, never on a role screen the browser saved.
    if (param || head || headParam) return;
    try {
      const saved = window.localStorage.getItem(ROLE_KEY);
      if (isRoleView(saved)) window.history.replaceState(null, "", `?view=${saved}`);
    } catch {
      // As in remember().
    }
  }, [demo, param, hash, reviewLink, loaded, giftOnly, head, headParam]);
  const [selected, setSelected] = useState<string | null>(search.get("candidate"));
  const [recordAttempt, setRecordAttempt] = useState(0);
  const [fetchedRecord, setFetchedRecord] = useState<{ id: string; data: HiringData; attempt: number; candidate: HiringCandidate | null } | null>(null);
  const [assessmentVisit, setAssessmentVisit] = useState<string | null>(null);
  // The candidate whose résumé viewer is open. It loads the file only on request.
  const [resumeFor, setResumeFor] = useState<string | null>(null);
  const [filter, setFilter] = useState<CandidateFilter>(NO_FILTER);
  const [previousResults, setPreviousResults] = useState<{ filter: CandidateFilter; opener: HTMLElement | null } | null>(null);
  // Read once by the Capacity tab; the Overview forecast compares with its hire-now numbers.
  const [capacity, setCapacity] = useState<CapacityReport | null>(null);
  // Head ticks not saved yet. They live here, not in the setup panel, so a tab switch does not drop them.
  const [dayDrafts, setDayDrafts] = useState<Record<string, boolean[]>>({});

  const configLoaded = useRef(false);
  async function load(keepConfig = false): Promise<HiringData> {
    const response = await fetch("/api/hiring", { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    setData(value);
    // A candidate decision must not discard setup edits that are not yet saved.
    if (!keepConfig || !configLoaded.current) {
      configLoaded.current = true;
      // The server refuses a subject listed twice, so the draft drops the repeat and a save can repair it.
      setConfig({ ...value.config, subjectPriority: dedupePriority(value.config.subjectPriority) });
      // A save must carry the revision these edits started from, so a stale save gets a 409.
      setConfigRevision(value.revision);
    }
    return value;
  }
  const reload = async () => { await load(true); };
  // In demo mode a new step is a new payload.
  useEffect(() => {
    // One quiet retry before an error: a short outage then never shows (critic review, round 22).
    // After a short wait, so a waking database or a cold start is covered too (critic review, round 23).
    load(true).catch(() => new Promise((resolve) => setTimeout(resolve, 1500)).then(() => load(true))).catch((e) => setError(e.message));
  }, [demoStep]);
  const command: Command = async (body, onReload, onError) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/hiring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok && onError) {
        const value = await response.json().catch(() => null);
        onError(typeof value?.error === "string" ? value.error : "", response.status);
        return false;
      }
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      const action = (body as { action: string }).action;
      if (action === "call_notes") {
        const { id } = body as { id: string };
        const notes = value.notes as NonNullable<NonNullable<HiringCandidate["callReview"]>["notes"]>;
        setData((current) => current && {
          ...current,
          candidates: current.candidates.map((candidate) => candidate.id === id
            ? { ...candidate, callReview: { good: null, tries: [], ...candidate.callReview, notes } }
            : candidate),
        });
        return true;
      }
      let saved = "Saved.";
      if (action === "head_days") {
        // The server checked the revision before it saved, so the new one belongs to this draft. A head with no
        // attendance record also has a new fallback week, which the draft must carry or the next save would undo it.
        // This comes before the reload, so a failed reload does not leave the old revision.
        const key = (body as { key: string }).key;
        setConfigRevision(value.revision);
        if (value.fallbackWeek)
          setConfig((c) =>
            c && { ...c, interviewers: c.interviewers.map((i) => (i.canonicalKey === key ? { ...i, fallbackWeek: value.fallbackWeek } : i)) },
          );
        saved = headDaysNotice(value.affectedVisits === undefined ? 0 : value.affectedVisits);
      }
      if (onReload) {
        onReload(await load(true).catch(() => null));
        return true;
      }
      setNotice(saved);
      // The save is done. If only the reload fails, say so, and do not call the save a failure.
      await load(action !== "settings").catch(() => setError("Saved, but the page could not refresh. Reload this page."));
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save.";
      if (onError) onError("");
      else setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  async function connect() {
    // The Google sign-in leaves the page, so demo mode does not start it.
    if (demo) return setNotice("This part is not in the demo.");
    setBusy(true);
    setError("");
    try {
      if (!config) return;
      await signIn(
        "google",
        { callbackUrl: "/hiring" },
        {
          prompt: "consent",
          access_type: "offline",
          include_granted_scopes: "true",
          login_hint: config.connectedEmail,
          scope: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/drive.file",
            ...GOOGLE_SCOPES,
            // Lets Hiring read free and busy time on the people@ calendar for the HR call list.
            GOOGLE_FREEBUSY_SCOPE,
          ].join(" "),
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect.");
      setBusy(false);
    }
  }

  const { observedAt, ready } = useMemo(() => ({
    observedAt: new Date(),
    ready: new Set(data?.candidates.filter((c) => readyToInvite(c, data.config)).map((c) => c.id) ?? []),
  }), [data]);
  const showOverview = view === "overview" || overviewOpened;
  const needsInsights = showOverview || view === "setup";
  const insights = useMemo(
    () => data && needsInsights ? buildInsights(data, observedAt, ready.size) : null,
    [data, needsInsights, observedAt, ready],
  );
  const extras = useMemo(
    () =>
      data
        ? candidateExtras(
            data.candidates,
            data.outbox,
            data.bookings,
            ready,
            new Date(),
            new Set(Object.keys(data.holds).filter((id) => data.holds[id].funnel === "onsite")),
          )
        : new Map(),
    [data, ready],
  );
  const clashes = useMemo(() => new Set(data?.visitClashes.candidateIds ?? []), [data]);
  const holds = useMemo(
    () =>
      new Map(
        data?.candidates.flatMap((c) => {
          const note = holdNote(c, data.holds[c.id], data.config);
          return note ? [[c.id, note] as const] : [];
        }) ?? [],
      ),
    [data],
  );
  function showTableFilter(next: CandidateFilter) {
    setFilter(next);
    focusCandidateResults();
  }

  const localCandidate = data?.candidates.find((c) => c.id === selected) ?? data?.assessmentCandidates?.find((c) => c.id === selected);
  const recordId = view === "overview" && !localCandidate ? selected : null;
  useEffect(() => {
    if (!recordId || !data) return;
    const request = new AbortController();
    async function readRecord(id: string, snapshot: HiringData) {
      let candidate: HiringCandidate | null = null;
      try {
        const response = await fetch(`/api/hiring?candidateId=${encodeURIComponent(id)}&record=1`, { cache: "no-store", signal: request.signal });
        if (response.ok) ({ candidate } = await response.json());
      } catch {
        // A failed read stays in the panel with a retry.
      }
      if (!request.signal.aborted) setFetchedRecord({ id, data: snapshot, attempt: recordAttempt, candidate });
    }
    void readRecord(recordId, data);
    return () => request.abort();
  }, [data, recordAttempt, recordId]);
  const sameRecord = fetchedRecord?.id === selected ? fetchedRecord : null;
  const recordPending = !!recordId && (sameRecord?.data !== data || sameRecord?.attempt !== recordAttempt);
  const candidate = localCandidate ?? sameRecord?.candidate;
  // Next.js commits pushState in a transition. In one transition, the panel mounts visible, so it can take focus.
  const openRecord = (id: string) =>
    startTransition(() => {
      setSelected(id);
      setView("overview");
    });
  const openEmailLog = (key: string | null) => {
    setMessageKey(key);
    setView("setup");
  };
  const step = STEPS.findIndex((name) => name === view) + 1;
  const surface = useRef<HTMLDivElement>(null);
  const switchView = (name: HiringView) => {
    if (name !== view && surface.current) surface.current.scrollTop = 0;
    setView(name);
  };
  const toolsLayout = view === "review" ? "review" : compactQueue ? "compact" : undefined;
  const reportFrom = param && Object.hasOwn(VIEWS, param) ? view : "dashboard";
  const scrollKey = `workspace:${reportFrom}`;
  useLayoutEffect(() => {
    if (loaded && !demo) return restoreHiringScroll(scrollKey, surface.current);
  }, [loaded, demo, scrollKey]);
  const personalHead = data?.viewerHead ?? head;
  const paperChecksDue = fullAccess && personalHead && data
    ? data.paperChecks.filter((check) => check.head === personalHead && !check.done && check.path).length
    : null;
  const personalTask = paperChecksDue === null ? "Your mock teaching and decisions" : paperChecksDue === 0
    ? "No papers to re-mark" : `${paperChecksDue} ${paperChecksDue === 1 ? "paper" : "papers"} to re-mark`;
  const chooseWorkspace = (event: MouseEvent<HTMLAnchorElement>, name: HiringView) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const menu = event.currentTarget.closest("details");
    if (menu) closeToolsMenu(menu);
    switchView(name);
  };
  const workspaceLink = (name: HiringView, label: string, hint?: string, descriptionId?: string) => (
    <a key={name} href={`/hiring?view=${name}${demo ? "&demo=1" : ""}`} aria-label={label}
      aria-current={view === name ? "page" : undefined} aria-describedby={descriptionId} onClick={(event) => chooseWorkspace(event, name)}>
      {view === name && <span className={nav.activeMark} aria-hidden="true">✓</span>}
      <span>{label}{hint && <small id={descriptionId}>{hint}</small>}</span>
    </a>
  );
  const workspace = <div className={nav.toolGroup} role="group" aria-label="Workspace">
    <span className={nav.groupLabel} aria-hidden="true">Workspace</span>
    {WORKSPACE.map((name) => workspaceLink(name, VIEWS[name]))}
  </div>;
  const reportLinks = (phone: boolean) => (
    <div className={`${nav.toolGroup} ${nav.reportGroup}`} role="group" aria-label="Reports">
      <span className={nav.groupLabel}>Hiring reports</span>
      {(["current-funnel", "paper-results", "ats-outcomes"] as const).map((report) => {
        const descriptionId = `hiring-${phone ? "phone" : "desktop"}-${report}-task`;
        return <Link key={report} href={hiringReportHref(report, reportFrom)} prefetch={false} scroll={false}
          aria-label={HIRING_REPORTS[report]} aria-describedby={descriptionId}
          target={newReportTab ? "_blank" : undefined} rel={newReportTab ? "noopener" : undefined}
          onNavigate={() => saveHiringScroll(scrollKey, surface.current)}>
          <span>{HIRING_REPORTS[report]}<small id={descriptionId} className={phone ? "sr-only" : undefined}>{REPORT_HINTS[report]}</small></span>
        </Link>;
      })}
    </div>
  );
  const staffTools = (phone: boolean) => <>
    {MORE_TOOLS.map((name) => workspaceLink(name, name === "heads" && personalHead ? "My list" : VIEWS[name],
      name === "heads" && personalHead ? personalTask : TOOL_HINTS[name], `hiring-${phone ? "phone" : "desktop"}-${name}-task`))}
    {!demo && <label className={nav.reportPreference}>
      <input type="checkbox" checked={newReportTab} onChange={(event) => setNewReportTab(event.target.checked)} />
      <span>Open reports in new tabs<small>Keep unsaved setup changes open</small></span>
    </label>}
    {!demo && <a href="/hiring?demo=1" target="_blank" rel="noopener" className={nav.practice}
      aria-label="Practice demo, opens in a new tab" aria-describedby={phone ? "hiring-phone-practice-data" : "hiring-desktop-practice-data"}>
      <span>Practice demo <span aria-hidden="true">↗</span><small id={phone ? "hiring-phone-practice-data" : "hiring-desktop-practice-data"}>Sample data</small></span>
    </a>}
  </>;
  const tools = (
    <nav className={nav.tools} aria-label="Hiring tools">
      {workspace}
      {!demo && reportLinks(false)}
      <ToolsMenu className={nav.moreTools} panelClass={nav.moreItems}
        label={view === "setup" ? <>More tools <span className={nav.activeTool}>· {VIEWS.setup}</span></> : "More tools"}>
        {staffTools(false)}
      </ToolsMenu>
    </nav>
  );
  const workflow = (
    <nav className={nav.workflow} aria-label="Hiring steps">
      <ol className={nav.steps} role="list">
        {STEPS.map((name, index) => (
          <li key={name}>
            <button type="button" data-review={name === "review" ? "" : undefined} aria-pressed={view === name} onClick={() => switchView(name)}>
              <span aria-hidden="true">{index + 1}</span>
              {VIEWS[name]}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );

  const paused = data && [
    !data.config.enabled && "Automation paused",
    !data.config.deliveryEnabled && "Messages paused",
  ].filter(Boolean).join(" · ");

  if ((param === "hr" && hash === null) || (reviewLink && !loaded && !error)) return <TabSkeleton label="Loading hiring…" />;

  return (
    <div ref={surface} data-workspace className={`${css.surface} ${serif.variable}`} data-heads-review={view === "heads" || view === "review" ? "" : undefined} data-offer={offer ? "" : undefined} data-prescreen={prescreen ? "" : undefined}>
      {demo && <DemoBar onStep={(name: DemoView) => setView(name, true)} briefOpen={briefOpen} setBriefOpen={setBriefOpen} />}
      <header className={css.topbar} data-compact={view === "hr" || view === "heads" || giftReview || compactQueue ? "" : undefined} data-heads={view === "heads" ? "" : undefined}>
        <div>
          <h1 className={css.title}>
            {giftReview ? VIEWS[view] : <>Tutor <em>hiring</em></>}
          </h1>
          {/* Always one line, so the tabs below do not move down when the data arrives. */}
          {!giftReview && !compactQueue && <p className={role ? css.subtitle : `${css.subtitle} ${css.statusSubtitle}`}>
            {role ? (
              view === "heads" && data?.viewerHead ? nickname(headName(data.viewerHead, data.tutors)) : view === "heads" && head ? "My list" : VIEWS[view]
            ) : data ? (
              <>
                SEEK {campaignNames(data.config.seekJobs)} · Threshold {data.config.profileThreshold}/100 ·
                Automation {data.config.enabled ? "on" : "paused"} · Messages{" "}
                {data.config.deliveryEnabled ? "on" : "paused"}
              </>
            ) : (
              "\u00a0"
            )}
          </p>}
          {!role && !giftReview && paused && <p className={compactQueue ? css.subtitle : css.mobileStatus}>{paused}</p>}
          {view !== "heads" && !compactQueue && data?.reviewAccess?.hr && <Link className="mt-2 inline-block text-sm underline underline-offset-4" href="/hiring/onboarding">Tutor onboarding and Experts access</Link>}
        </div>
        <div role="status" className={css.notice}>
          {/* Rules and setup shows these beside its Save button, where they are in view. */}
          {view === "setup" || prescreen ? "" : notice}
        </div>
        {role ? (
          // Heads see only their own list (Kevin, 24 Nov 2026). Staff, and a head with no page limit (Kevin, 25 Nov 2026),
          // keep the way to the full dashboard.
          view === "heads" && (data?.viewerHead ?? head) && !fullAccess ? null : <div className={css.viewSwitch}>
            <button type="button" onClick={() => setView("overview")}>
              Full dashboard
            </button>
          </div>
        ) : (
          <>
            {/* Gift's phone screen has no step menu. */}
            {giftReview && <div className={`${css.viewSwitch} ${css.phoneOnly}`}>
              <button type="button" onClick={() => setView("overview")}>
                Full dashboard
              </button>
            </div>}
          </>
        )}
      </header>
      {!role && <header className={`${nav.toolsBar} ${demo || view === "setup" ? "" : nav.stickyTools}`} data-layout={toolsLayout} data-empty-mobile={giftReview || (view === "review" && !loaded) ? "" : undefined}>
        <div className={nav.desktop}>{tools}</div>
        {!giftReview && (view !== "review" || loaded) && <div className={nav.mobileBar}>
          {!demo && <nav className={nav.phoneReports} aria-label="Hiring reports">{reportLinks(true)}</nav>}
          <ToolsMenu className={`${nav.mobile} ${css.stepMenu}`} panelClass={nav.phonePanel} review={view === "review"}
            label={<span className={nav.mobileLabel}>Tools and steps<small><span aria-hidden="true">✓ </span>{step ? `${step} ${VIEWS[view]}` : VIEWS[view]}</small></span>}>
            <nav className={nav.tools} aria-label="Hiring tools">
              {workspace}
              <div className={nav.phoneStaff} role="group" aria-label="More tools">
                <span className={nav.groupLabel} aria-hidden="true">More tools</span>
                {staffTools(true)}
              </div>
            </nav>
            {workflow}
          </ToolsMenu>
        </div>}
      </header>}
      {!role && <div className={`${nav.desktop} ${nav.workflowBar}`} data-layout={toolsLayout}>{workflow}</div>}
      {view !== "hr" && view !== "heads" && view !== "offer" && view !== "prescreen" && !giftReview && PURPOSE[view] && (
        <p className={view === "overview" ? `${css.purpose} ${css.overviewPurpose}` : css.purpose}>
          {PURPOSE[view]}
          {view === "overview" && data && <button type="button" className={css.findCandidate} onClick={() => {
            const input = document.getElementById("hiring-candidate-search");
            input?.focus({ preventScroll: true });
            input?.scrollIntoView({ block: "center", inline: "nearest" });
          }}>Find candidate</button>}
        </p>
      )}
      {/* A head's failed first load has its own message and retry below. */}
      {error && view !== "setup" && !prescreen && !offerLoadFailed && !(view === "heads" && !data) && (
        <p role="alert" className={css.alert}>
          {error}
        </p>
      )}
      {!role && data?.workerError && (
        <p role="alert" className={css.alert}>
          {data.workerError}
        </p>
      )}
      {!role && data && <WorkerBanner enabled={data.config.enabled} workerAt={data.workerAt} />}
      {!role && view !== "setup" && data && data.configProblems.length > 0 && (
        <p role="alert" className={css.alert}>
          The saved rules have a problem, so the worker has stopped. Open Rules and setup. {data.configProblems.join(" ")}
        </p>
      )}
      {/* The assessment calendar explains its own clashes and old data. */}
      {view !== "hr" && data && (clashes.size > 0 || data.visitClashes.stale) && (
        <p role="alert" className={css.alert}>
          {clashes.size > 0
            ? `${clashes.size} booked visit${clashes.size === 1 ? "" : "s"} now clash${clashes.size === 1 ? "es" : ""} with a Wise class, leave or sit-in. The app did not move ${clashes.size === 1 ? "it" : "them"}. Staff must act. See the calendar under Paper test.`
            : "Wise data is old or missing, so visit clashes may not show. Check the calendar under Paper test."}
        </p>
      )}
      {/* Outside the main load: this tab reads its own endpoint, so it opens at once and survives a failed load. */}
      <div hidden={view !== "capacity"} className={css.viewPane}>
        <CapacityScreen active={view === "capacity"} onReport={setCapacity} />
      </div>
      {offerLoadFailed || (prescreen && !data && error) ? (
        <div className={css.loading}>
          <p role="alert" className={css.offerLoadAlert}>{prescreen ? "Could not load pre-screen." : "Could not load offers."}</p>
          <button type="button" className={`${css.primary} ${css.retry} ${css.offerRetry}`} aria-disabled={retrying || undefined} onClick={async () => {
            if (retrying) return;
            setRetrying(true);
            try {
              await load(true);
              setError("");
              window.requestAnimationFrame(() => document.getElementById(prescreen ? "prescreen-queue" : "approved-offers")?.focus());
            } catch (error) {
              setError(error instanceof Error ? error.message : "Could not load the list.");
            } finally {
              setRetrying(false);
            }
          }}>Try again</button>
          <p role="status">{retrying ? (prescreen ? "Loading pre-screen…" : "Loading offers…") : ""}</p>
        </div>
      ) : !data || !config ? (
        error ? (
          view === "heads" ? (
            // A head cannot check the setup, so the list offers a retry and names who to ask (Sol review, round 18).
            // The button stays while it retries, so focus is not lost; on success focus moves to the list (Sol review, round 20).
            <div className={css.loading}>
              <p role="alert">Could not load your hiring list.</p>
              <button type="button" className={`${css.primary} ${css.retry}`} aria-disabled={retrying || undefined} onClick={() => {
                if (retrying) return;
                setRetrying(true);
                load(true).then(() => {
                  setError("");
                  // The list, or the open area when an empty list hides it on a laptop (Sol review, round 21).
                  window.requestAnimationFrame(() => {
                    const list = document.getElementById("hiring-list");
                    (list && list.offsetParent !== null ? list : document.getElementById("open-item"))?.focus();
                  });
                }).catch((e) => setError(e.message)).finally(() => setRetrying(false));
              }}>Try again</button>
              <p role="status">{retrying ? "Loading your hiring list…" : "If it fails again, ask BeGifted admin."}</p>
            </div>
          ) : (
            <p role="status" className={css.loading} hidden={view === "capacity"}>
              Check the hiring setup and reload this page.
            </p>
          )
        ) : (
          <TabSkeleton label={view === "heads" ? "Loading your hiring list…" : `Loading hiring: ${VIEWS[view]}…`} hidden={view === "capacity"} />
        )
      ) : (
        <>
        {view === "setup" && (
          <SetupPanel
            data={data}
            config={config}
            revision={configRevision}
            setConfig={setConfig}
            busy={busy}
            connect={connect}
            command={command}
            dayDrafts={dayDrafts}
            setDayDrafts={setDayDrafts}
            error={error}
            notice={notice}
          />
        )}
        {/* Moved from the Overview (25 Nov 2026): send limits and system state, beside the rules that set them. */}
        {view === "setup" && insights && (
          <div className={css.layout}>
            <div className={css.main}>
              <LimitMeters usage={data.usage} headMocks={data.headMocks} config={data.config} tutors={data.tutors} />
            </div>
            <OperationsRail data={data} insights={insights} busy={busy} connect={connect} onSelect={openRecord}
              messageKey={messageKey} />
          </div>
        )}
        {/* Hidden, not unmounted, for the same reason: a tab switch keeps the filters and the open résumé. */}
        <div hidden={view !== "seek"} className={css.viewPane}>
          <SeekScreen
            data={data}
            extras={extras}
            holds={holds}
            onOpenRecord={openRecord}
            command={command}
            busy={busy}
          />
        </div>
        <div hidden={view !== "calls"} className={css.viewPane}>
          {view === "calls" && <TodayCalls data={data} command={command} busy={busy} />}
          <CallsScreen data={data} extras={extras} holds={holds} onOpenRecord={openRecord} command={command} busy={busy} />
        </div>
        {prescreen && <PreScreenScreen data={data} extras={extras} command={command} busy={busy}
          reload={() => load(true)} onOpenEmailLog={openEmailLog} onOpenOverview={() => setView("overview")} />}
        {view === "hr" && <HrScreen data={data} command={command} busy={busy} linkedReview={linkedReview} onOpenResults={() => setView("assessment", true)} />}
        {view === "admin" && <AdminScreen data={data} reload={reload} onOpenResults={(id) => {
          setAssessmentVisit(id);
          setView("assessment", true);
        }} />}
        {(view === "heads" || view === "mock") && <HeadsScreen data={data} head={view === "heads" ? data.viewerHead : undefined} open={linkedReview} reload={reload} />}
        {(view === "review" || view === "offer") && (
          <HiringReviewScreen key={view} data={data} offers={view === "offer"} linkedReview={linkedReview} reload={reload}
            onOpenEmailLog={openEmailLog}
            onFinalReview={() => setView("review")} onOpenResults={(id) => {
              const rows = assessmentRows(data.bookings, data.papers, data.mocks).filter((row) => row.candidateId === id);
              setAssessmentVisit((rows.find((row) => row.mockAt) ?? rows[0])?.key ?? null);
              setView("assessment");
            }} />
        )}
        <div hidden={view !== "visitday"} className={css.viewPane}>
          <RunSheetScreen data={data} />
        </div>
        <div hidden={view !== "assessment"} className={css.viewPane}>
          <AssessmentScreen data={data} selectedVisit={assessmentVisit} onSelectVisit={setAssessmentVisit} onOpenRecord={openRecord} command={command} reload={reload} busy={busy} active={view === "assessment"} />
        </div>
        {/* Keep the Overview state after its first visit, including its search, sort and open résumé. */}
        {showOverview && insights && <div className={css.layout} hidden={view !== "overview"}>
          <div className={css.main}>
            <OverviewAnalytics
              data={data}
              now={observedAt}
              capacity={capacity}
              onOpen={setSelected}
              onShow={(ids, label, opener, timingEvidence) => {
                // An empty list shows nobody, so a zero count never opens the whole table.
                setPreviousResults({
                  filter: filter.ids && previousResults ? previousResults.filter : filter,
                  opener: opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
                });
                showTableFilter({ ...NO_FILTER, ids: [...ids], label, timingEvidence });
              }}
            />
            {/* The table is the main work surface, so it sits right under the meters. The charts follow and read the same filter. */}
            <CandidateTable
              candidates={data.candidates}
              funnelData={data}
              insights={insights}
              ready={ready}
              extras={extras}
              holds={holds}
              clashes={clashes}
              weights={data.config.profileWeights}
              threshold={data.config.profileThreshold}
              filter={filter}
              setFilter={setFilter}
              onReturnFromFinding={filter.ids && previousResults ? () => {
                setFilter(previousResults.filter);
                setPreviousResults(null);
                previousResults.opener?.focus();
              } : undefined}
              selected={selected}
              onSelect={setSelected}
              onOpenResume={(id) => {
                setSelected(id);
                setResumeFor(id);
              }}
            />
            <div className={css.charts}>
              <ScoreChart
                insights={insights}
                threshold={data.config.profileThreshold}
                filter={filter}
                setFilter={showTableFilter}
              />
              <EvidenceChart insights={insights} />
              <SubjectChart insights={insights} filter={filter} setFilter={showTableFilter} />
            </div>
          </div>
          {candidate ? (
            <CandidateInspector
              key={candidate.id}
              candidate={candidate}
              extras={extras.get(candidate.id)}
              hold={holds.get(candidate.id)}
              seekJobId={data.config.seekJobs[0].jobId}
              weights={data.config.profileWeights}
              preWeights={data.config.preScreenWeights}
              busy={busy || recordPending}
              error={error}
              notice={notice}
              command={command}
              onClose={() => {
                setSelected(null);
                setResumeFor(null);
              }}
              resumeOpen={resumeFor === candidate.id}
              onResumeToggle={(open) => setResumeFor(open ? candidate.id : null)}
              retentionMonths={data.config.resumeRetentionMonths}
            />
          ) : recordId ? (
            <aside className={`${css.inspector} ${css.seekPanel}`} aria-label="Candidate record">
              <div className={css.inspectorHead}>
                <h2 className={css.inspectorName}>Candidate record</h2>
                <button className={css.inlineLink} type="button" onClick={() => setSelected(null)}>Close</button>
              </div>
              <div className={css.inspectorBody}>
                {recordPending ? <p role="status">Loading candidate record…</p> : <>
                  <p role="alert">Could not load the candidate record.</p>
                  <button className={css.secondary} type="button" onClick={() => setRecordAttempt((attempt) => attempt + 1)}>Try again</button>
                </>}
              </div>
            </aside>
          ) : null}
        </div>}
        </>
      )}
    </div>
  );
}

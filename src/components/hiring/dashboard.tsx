"use client";

import Link from "next/link";

import { startTransition, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Instrument_Serif } from "next/font/google";
import { signIn } from "next-auth/react";
import { isRoleView } from "@/lib/hiring/role-views";
import { GOOGLE_FREEBUSY_SCOPE, GOOGLE_SCOPES, type HiringConfig, type Stage, type Subject } from "@/lib/hiring/model";
import { assessmentRows } from "@/lib/hiring/assessment-view";
import { buildInsights, readyToInvite } from "@/lib/hiring/insights";
import { dedupePriority, headDaysNotice } from "@/lib/hiring/rules";
import { candidateExtras, holdNote } from "@/lib/hiring/status";
import { campaignNames } from "@/lib/hiring/seek-view";
import type { dashboard } from "@/lib/hiring/service";
import { CandidateInspector } from "./candidate-inspector";
import { CandidateTable, matchesFilter } from "./candidate-table";
import { AveragePentagon, EvidenceChart, KpiStrip, LimitMeters, ScoreChart, StageChart, SubjectChart } from "./pipeline-charts";
import { AssessmentScreen } from "./assessment-screen";
import { OperationsRail, WorkerBanner } from "./operations-rail";
import { AdminScreen, HeadsScreen, HrScreen, HiringReviewScreen, TodayCalls } from "./role-screens";
import { PreScreenScreen } from "./prescreen-screen";
import { CallsScreen } from "./calls-screen";
import { CapacityScreen } from "./capacity-screen";
import { FunnelPanel } from "./funnel-panel";
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
};
export type Command = (body: unknown) => Promise<boolean>;
export const NO_FILTER: CandidateFilter = { stage: "all", prescreen: "all", bucket: null, subject: null };

const VIEWS = {
  overview: "Overview",
  capacity: "Capacity",
  seek: "SEEK intake",
  calls: "HR calls",
  prescreen: "Pre-screen form",
  visitday: "Visit schedule",
  assessment: "Paper test",
  mock: "Mock teaching",
  review: "Final review",
  offer: "Offer & signing",
  setup: "Rules and setup",
  // The simple screens, one for each role. Each has its own link: /hiring?view=hr, admin or heads.
  hr: "HR",
  admin: "Admin",
  heads: "Heads",
};
export type HiringView = keyof typeof VIEWS;
const STEPS = ["seek", "calls", "prescreen", "assessment", "mock", "review", "offer"] as const;
const TOOLS = ["overview", "capacity", "visitday", "setup", "hr", "admin", "heads"] as const;
/** One line under the tabs, so a new user can name what each tab is for. */
const PURPOSE: Record<HiringView, string> = {
  overview: "Where every candidate stands, and who is ready for the next step.",
  capacity: "Which subjects need new tutors first, from busy-hours use and new students.",
  seek: "Check applications from SEEK and their ATS scores.",
  calls: "HR speaks to the candidate and records the call outcome and notes.",
  prescreen: "Review the candidate’s form and invite them to sit the paper test.",
  visitday: "See arrival times, papers to print and the tutors assigned to mock teaching.",
  assessment: "Admin uploads the scanned paper for grading. The candidate waits until you confirm a pass and send the mock invitation.",
  mock: "The tutor gets the graded paper and résumé before the mock. After the rubric, Yes goes to HR and No queues a rejection email.",
  review: "HR adds the behavioral assessment and sends the packet to Gift for approval or rejection.",
  offer: "After approval, the candidate receives an offer letter and can book a 30-minute signing with HR on site.",
  setup: "Scores, limits, heads and messages. A change applies to every tab.",
  hr: "Your calls this week, who to call next, and the decisions the heads sent.",
  admin: "Who comes when, the paper to print, and where to upload the completed paper.",
  heads: "See your mock bookings, mark the rubric and record your recommendation.",
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

export function HiringDashboard() {
  const [data, setData] = useState<HiringData | null>(null);
  const [config, setConfig] = useState<HiringConfig | null>(null);
  const [configRevision, setConfigRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const param = useSearchParams().get("view");
  const view: HiringView = param && Object.hasOwn(VIEWS, param) ? (param as HiringView) : "overview";
  // Next.js keeps useSearchParams in step with pushState, and this does not reload the page.
  const setView = (name: HiringView, keepRole = false) => {
    // Leaving a role screen for the full dashboard forgets it. Opening one remembers it.
    if (!keepRole) remember(isRoleView(name) ? name : null);
    if (name !== view) window.history.pushState(null, "", `?view=${name}`);
  };
  const role = isRoleView(view);
  useEffect(() => {
    if (isRoleView(param)) return remember(param);
    if (param) return;
    try {
      const saved = window.localStorage.getItem(ROLE_KEY);
      if (isRoleView(saved)) window.history.replaceState(null, "", `?view=${saved}`);
    } catch {
      // As in remember().
    }
  }, [param]);
  const [selected, setSelected] = useState<string | null>(null);
  const [assessmentVisit, setAssessmentVisit] = useState<string | null>(null);
  // The candidate whose résumé viewer is open. It loads the file only on request.
  const [resumeFor, setResumeFor] = useState<string | null>(null);
  const [filter, setFilter] = useState<CandidateFilter>(NO_FILTER);
  // Head ticks not saved yet. They live here, not in the setup panel, so a tab switch does not drop them.
  const [dayDrafts, setDayDrafts] = useState<Record<string, boolean[]>>({});

  async function load(keepConfig = false) {
    const response = await fetch("/api/hiring", { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    setData(value);
    // A candidate decision must not discard setup edits that are not yet saved.
    if (!keepConfig) {
      // The server refuses a subject listed twice, so the draft drops the repeat and a save can repair it.
      setConfig({ ...value.config, subjectPriority: dedupePriority(value.config.subjectPriority) });
      // A save must carry the revision these edits started from, so a stale save gets a 409.
      setConfigRevision(value.revision);
    }
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  const command: Command = async (body) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/hiring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
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
      setNotice(saved);
      // The save is done. If only the reload fails, say so, and do not call the save a failure.
      await load(action !== "settings").catch(() => setError("Saved, but the page could not refresh. Reload this page."));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  async function connect() {
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

  const insights = useMemo(() => (data ? buildInsights(data) : null), [data]);
  const ready = useMemo(
    () =>
      new Set(
        data?.candidates.filter((c) => readyToInvite(c, data.config)).map((c) => c.id) ?? [],
      ),
    [data],
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
  const shown = useMemo(
    () => data?.candidates.filter((c) => matchesFilter(c, filter, ready, extras)) ?? [],
    [data, filter, ready, extras],
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
  const candidate = data?.candidates.find((c) => c.id === selected);
  // Next.js commits pushState in a transition. In one transition, the panel mounts visible, so it can take focus.
  const openRecord = (id: string) =>
    startTransition(() => {
      setSelected(id);
      setView("overview");
    });
  const step = STEPS.findIndex((name) => name === view) + 1;
  const navigation = (
    <>
      <nav className={nav.tools} aria-label="Hiring tools">
        {TOOLS.map((name) => (
          <button key={name} type="button" aria-pressed={view === name} onClick={() => setView(name)}>
            {VIEWS[name]}
          </button>
        ))}
      </nav>
      <nav className={nav.workflow} aria-label="Hiring steps">
        <ol className={nav.steps} role="list">
          {STEPS.map((name, index) => (
            <li key={name}>
              <button type="button" aria-pressed={view === name} onClick={() => setView(name)}>
                <span aria-hidden="true">{index + 1}</span>
                {VIEWS[name]}
              </button>
            </li>
          ))}
        </ol>
      </nav>
    </>
  );

  const paused = data && [
    !data.config.enabled && "Automation paused",
    !data.config.deliveryEnabled && "Messages paused",
  ].filter(Boolean).join(" · ");

  return (
    <div className={`${css.surface} ${serif.variable}`}>
      <header className={css.topbar} data-compact={view === "hr" ? "" : undefined}>
        <div>
          <h1 className={css.title}>
            Tutor <em>hiring</em>
          </h1>
          {/* Always one line, so the tabs below do not move down when the data arrives. */}
          <p className={role ? css.subtitle : `${css.subtitle} ${css.statusSubtitle}`}>
            {role ? (
              VIEWS[view]
            ) : data ? (
              <>
                SEEK {campaignNames(data.config.seekJobs)} · Threshold {data.config.profileThreshold}/100 ·
                Automation {data.config.enabled ? "on" : "paused"} · Messages{" "}
                {data.config.deliveryEnabled ? "on" : "paused"}
              </>
            ) : (
              "\u00a0"
            )}
          </p>
          {!role && paused && <p className={css.mobileStatus}>{paused}</p>}
          {data?.reviewAccess?.hr && <Link className="mt-2 inline-block text-sm underline underline-offset-4" href="/hiring/onboarding">Tutor onboarding and Experts access</Link>}
        </div>
        <div role="status" className={css.notice}>
          {/* Rules and setup shows these beside its Save button, where they are in view. */}
          {view === "setup" ? "" : notice}
        </div>
        {role ? (
          <div className={css.viewSwitch}>
            <button type="button" onClick={() => setView("overview")}>
              Full dashboard
            </button>
          </div>
        ) : (
          <>
            <div className={nav.desktop}>{navigation}</div>
            <details
              className={nav.mobile}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !event.currentTarget.open) return;
                event.preventDefault();
                event.currentTarget.open = false;
                event.currentTarget.querySelector("summary")?.focus();
              }}
              onClick={(event) => {
                if (!(event.target instanceof Element) || !event.target.closest("button")) return;
                event.currentTarget.open = false;
                event.currentTarget.querySelector("summary")?.focus();
              }}
            >
              <summary>{step ? `${step} ${VIEWS[view]}` : VIEWS[view]}</summary>
              {navigation}
            </details>
          </>
        )}
      </header>
      {view !== "hr" && <p className={css.purpose}>{PURPOSE[view]}</p>}
      {error && view !== "setup" && (
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
        <CapacityScreen active={view === "capacity"} />
      </div>
      {!data || !config || !insights ? (
        error ? (
          <p role="status" className={css.loading} hidden={view === "capacity"}>
            Check the hiring setup and reload this page.
          </p>
        ) : (
          <TabSkeleton label={`Loading hiring: ${VIEWS[view]}…`} hidden={view === "capacity"} />
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
        <div hidden={view !== "prescreen"} className={css.viewPane}>
          <PreScreenScreen data={data} extras={extras} holds={holds} command={command} busy={busy} error={error} notice={notice} />
        </div>
        {view === "hr" && <HrScreen data={data} command={command} busy={busy} onOpenResults={() => setView("assessment", true)} />}
        {view === "admin" && <AdminScreen data={data} reload={() => load(true)} onOpenResults={(id) => {
          setAssessmentVisit(id);
          setView("assessment", true);
        }} />}
        {(view === "heads" || view === "mock") && <HeadsScreen data={data} />}
        {(view === "review" || view === "offer") && (
          <HiringReviewScreen key={view} data={data} offers={view === "offer"} reload={() => load(true)} onOpenResults={(id) => {
            const rows = assessmentRows(data.bookings, data.papers, data.mocks).filter((row) => row.candidateId === id);
            setAssessmentVisit((rows.find((row) => row.mockAt) ?? rows[0])?.key ?? null);
            setView("assessment");
          }} />
        )}
        <div hidden={view !== "visitday"} className={css.viewPane}>
          <RunSheetScreen data={data} />
        </div>
        <div hidden={view !== "assessment"} className={css.viewPane}>
          <AssessmentScreen data={data} selectedVisit={assessmentVisit} onSelectVisit={setAssessmentVisit} onOpenRecord={openRecord} command={command} reload={() => load(true)} busy={busy} />
        </div>
        <div className={css.layout} hidden={view !== "overview"}>
          <div className={css.main}>
            <KpiStrip
              insights={insights}
              threshold={data.config.profileThreshold}
              onShowReady={() => setFilter({ ...NO_FILTER, stage: "ready" })}
            />
            <FunnelPanel
              data={data}
              campaigns={data.config.seekJobs}
              onShowStuck={(stage, ids) => setFilter({ ...NO_FILTER, stage, ids })}
            />
            <LimitMeters usage={data.usage} headMocks={data.headMocks} config={data.config} tutors={data.tutors} />
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
              selected={selected}
              onSelect={setSelected}
              onOpenResume={(id) => {
                setSelected(id);
                setResumeFor(id);
              }}
            />
            <div className={css.charts}>
              <StageChart insights={insights} filter={filter} setFilter={setFilter} />
              <ScoreChart
                insights={insights}
                threshold={data.config.profileThreshold}
                filter={filter}
                setFilter={setFilter}
              />
              <EvidenceChart insights={insights} />
              <SubjectChart insights={insights} filter={filter} setFilter={setFilter} />
              <AveragePentagon candidates={shown} />
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
              busy={busy}
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
          ) : (
            <OperationsRail
              data={data}
              insights={insights}
              busy={busy}
              connect={connect}
              onSelect={setSelected}
            />
          )}
        </div>
        </>
      )}
    </div>
  );
}

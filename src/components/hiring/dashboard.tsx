"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Instrument_Serif } from "next/font/google";
import { signIn } from "next-auth/react";
import { GOOGLE_SCOPES, type HiringConfig, type Stage, type Subject } from "@/lib/hiring/model";
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
import { PreScreenScreen } from "./prescreen-screen";
import { CallsScreen } from "./calls-screen";
import { SeekScreen } from "./seek-screen";
import { SetupPanel } from "./setup-panel";
import css from "./dashboard.module.css";

const serif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
});

export type HiringData = Awaited<ReturnType<typeof dashboard>> & {
  google: { connected: boolean; email: string; lastError: string | null };
};
export type HiringCandidate = HiringData["candidates"][number];
export type PreScreenFilter = "all" | "Queued" | "Sent" | "Replied" | "No reply" | "Visit booked";
export type CandidateFilter = {
  stage: Stage | "all" | "ready";
  prescreen: PreScreenFilter;
  bucket: number | null;
  subject: Subject | null;
};
export type Command = (body: unknown) => Promise<boolean>;
export const NO_FILTER: CandidateFilter = { stage: "all", prescreen: "all", bucket: null, subject: null };

const VIEWS = {
  overview: "Overview",
  seek: "1 Seek intake",
  calls: "2 Calls",
  prescreen: "3 Pre-screen",
  assessment: "4 Mock and paper",
  setup: "Rules and setup",
};
export type HiringView = keyof typeof VIEWS;

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
  const setView = (name: HiringView) => {
    if (name !== view) window.history.pushState(null, "", `?view=${name}`);
  };
  const [selected, setSelected] = useState<string | null>(null);
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

  return (
    <div className={`${css.surface} ${serif.variable}`}>
      <header className={css.topbar}>
        <div>
          <h1 className={css.title}>
            Tutor <em>hiring</em>
          </h1>
          {data && (
            <p className={css.subtitle}>
              SEEK {campaignNames(data.config.seekJobs)} · Threshold {data.config.profileThreshold}/100 ·
              Automation {data.config.enabled ? "on" : "paused"} · Messages{" "}
              {data.config.deliveryEnabled ? "on" : "paused"}
            </p>
          )}
        </div>
        <div role="status" className={css.notice}>
          {/* Rules and setup shows these beside its Save button, where they are in view. */}
          {view === "setup" ? "" : notice}
        </div>
        <div className={css.viewSwitch} role="group" aria-label="Hiring views">
          {(Object.keys(VIEWS) as HiringView[]).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={view === name}
              onClick={() => setView(name)}
            >
              {VIEWS[name]}
            </button>
          ))}
        </div>
      </header>
      {error && view !== "setup" && (
        <p role="alert" className={css.alert}>
          {error}
        </p>
      )}
      {data?.workerError && (
        <p role="alert" className={css.alert}>
          {data.workerError}
        </p>
      )}
      {data && <WorkerBanner enabled={data.config.enabled} workerAt={data.workerAt} />}
      {view !== "setup" && data && data.configProblems.length > 0 && (
        <p role="alert" className={css.alert}>
          The saved rules have a problem, so the worker has stopped. Open Rules and setup. {data.configProblems.join(" ")}
        </p>
      )}
      {/* The Mock and paper calendar explains its own clashes and old data. */}
      {data && (clashes.size > 0 || data.visitClashes.stale) && (
        <p role="alert" className={css.alert}>
          {clashes.size > 0
            ? `${clashes.size} booked visit${clashes.size === 1 ? "" : "s"} now clash${clashes.size === 1 ? "es" : ""} with a Wise class, leave or sit-in. The app did not move ${clashes.size === 1 ? "it" : "them"}. Staff must act. See the calendar in 4 Mock and paper.`
            : "Wise data is old or missing, so visit clashes may not show. Check the calendar in 4 Mock and paper."}
        </p>
      )}
      {!data || !config || !insights ? (
        <p role="status" className={css.loading}>
          {error ? "Check the hiring setup and reload this page." : "Loading hiring…"}
        </p>
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
          <CallsScreen data={data} extras={extras} holds={holds} onOpenRecord={openRecord} command={command} busy={busy} />
        </div>
        <div hidden={view !== "prescreen"} className={css.viewPane}>
          <PreScreenScreen data={data} extras={extras} holds={holds} command={command} busy={busy} error={error} notice={notice} />
        </div>
        <div hidden={view !== "assessment"} className={css.viewPane}>
          <AssessmentScreen data={data} onOpenRecord={openRecord} command={command} reload={() => load(true)} busy={busy} />
        </div>
        <div className={css.layout} hidden={view !== "overview"}>
          <div className={css.main}>
            <KpiStrip
              insights={insights}
              threshold={data.config.profileThreshold}
              onShowReady={() => setFilter({ ...NO_FILTER, stage: "ready" })}
            />
            <LimitMeters usage={data.usage} headMocks={data.headMocks} config={data.config} tutors={data.tutors} />
            {/* The table is the main work surface, so it sits right under the meters. The charts follow and read the same filter. */}
            <CandidateTable
              candidates={data.candidates}
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

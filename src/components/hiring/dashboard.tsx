"use client";

import { useEffect, useMemo, useState } from "react";
import { Instrument_Serif } from "next/font/google";
import { signIn } from "next-auth/react";
import { GOOGLE_SCOPES, type HiringConfig, type Stage, type Subject } from "@/lib/hiring/model";
import { buildInsights, readyToInvite } from "@/lib/hiring/insights";
import type { dashboard } from "@/lib/hiring/service";
import { CandidateInspector } from "./candidate-inspector";
import { CandidateTable } from "./candidate-table";
import { EvidenceChart, KpiStrip, ScoreChart, StageChart, SubjectChart } from "./pipeline-charts";
import { OperationsRail } from "./operations-rail";
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
export type CandidateFilter = {
  stage: Stage | "all" | "ready";
  bucket: number | null;
  subject: Subject | null;
};
export type Command = (body: unknown) => Promise<boolean>;
export const NO_FILTER: CandidateFilter = { stage: "all", bucket: null, subject: null };

export function HiringDashboard() {
  const [data, setData] = useState<HiringData | null>(null);
  const [config, setConfig] = useState<HiringConfig | null>(null);
  const [configRevision, setConfigRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"pipeline" | "setup">("pipeline");
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<CandidateFilter>(NO_FILTER);

  async function load(keepConfig = false) {
    const response = await fetch("/api/hiring", { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    setData(value);
    // A candidate decision must not discard setup edits that are not yet saved.
    if (!keepConfig) {
      setConfig(value.config);
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
      await load((body as { action: string }).action !== "settings");
      setNotice("Saved.");
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
  const candidate = data?.candidates.find((c) => c.id === selected);

  return (
    <div className={`${css.surface} ${serif.variable}`}>
      <header className={css.topbar}>
        <div>
          <h1 className={css.title}>
            Tutor <em>hiring</em>
          </h1>
          {data && (
            <p className={css.subtitle}>
              SEEK job {data.config.seekJobId} · Threshold {data.config.profileThreshold}/100 ·
              Automation {data.config.enabled ? "on" : "paused"} · Messages{" "}
              {data.config.deliveryEnabled ? "on" : "paused"}
            </p>
          )}
        </div>
        <div role="status" className={css.notice}>
          {notice}
        </div>
        <div className={css.viewSwitch} role="group" aria-label="Hiring views">
          {(["pipeline", "setup"] as const).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={view === name}
              onClick={() => setView(name)}
            >
              {name === "pipeline" ? "Pipeline" : "Rules and setup"}
            </button>
          ))}
        </div>
      </header>
      {error && (
        <p role="alert" className={css.alert}>
          {error}
        </p>
      )}
      {data?.workerError && (
        <p role="alert" className={css.alert}>
          {data.workerError}
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
          />
        )}
        {/* Hidden, not unmounted: a switch to setup keeps a drafted reason and table filters. */}
        <div className={css.layout} hidden={view === "setup"}>
          <div className={css.main}>
            <KpiStrip
              insights={insights}
              threshold={data.config.profileThreshold}
              onShowReady={() => setFilter({ ...NO_FILTER, stage: "ready" })}
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
            </div>
            <CandidateTable
              candidates={data.candidates}
              insights={insights}
              ready={ready}
              weights={data.config.profileWeights}
              threshold={data.config.profileThreshold}
              filter={filter}
              setFilter={setFilter}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
          {candidate ? (
            <CandidateInspector
              key={candidate.id}
              candidate={candidate}
              weights={data.config.profileWeights}
              busy={busy}
              error={error}
              notice={notice}
              command={command}
              onClose={() => setSelected(null)}
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

"use client";

import { Fragment, useLayoutEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import type { AutowriterReview } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import { Tag, TONE_TEXT, Upper } from "./atoms";
import { when } from "./format";
import { effortsLabel, modelLabel } from "./model-labels";

// ----------------------------------------------------------------------------
// The system line: what the autowriter runs with right now, in one slim row,
// with the owner's Controls menu; and, directly under it, the halt banner.
// ----------------------------------------------------------------------------

type Mode = AutowriterDashboard["control"]["mode"];

const MODE_TONE: Record<Mode, { text: string; dot: string }> = {
  live: { text: TONE_TEXT.green, dot: "bg-available" },
  shadow: { text: TONE_TEXT.blue, dot: "bg-sky-500" },
  off: { text: "text-muted-foreground", dot: "bg-muted-foreground/50" },
};

const MODE_BUTTON: Record<Mode, string> = { live: "Go live", shadow: "Shadow", off: "Turn off" };

/** Sends one owner action to `POST /api/feedback-autowriter/control` after the confirmation it is given. */
export type ControlHandler = (body: Record<string, unknown>, confirmText: string) => void;

const RESUME_CONFIRM = "Resume posting? Check the class named in the halt reason first.";

/** The owner's switches: the other modes, and Pause or Resume. */
function ControlsMenu({ control, busy, onControl }: { control: AutowriterDashboard["control"]; busy: boolean; onControl: ControlHandler }) {
  const [open, setOpen] = useState(false);
  // A menu left open must not come back open when the page is shown again after a navigation.
  useLayoutEffect(() => () => setOpen(false), []);
  const act = (body: Record<string, unknown>, confirmText: string) => {
    setOpen(false);
    onControl(body, confirmText);
  };
  const pause = () => {
    setOpen(false);
    const reason = window.prompt("Why pause the autowriter?");
    if (!reason?.trim()) return;
    onControl({ action: "pause", reason: reason.trim() }, "Pause all feedback posting now?");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(props) => (
          <Button {...props} variant="outline" size="xs" className="h-6 gap-1 rounded-md px-2 text-[11px] font-[550]">
            Controls <ChevronDown aria-hidden className="size-3" />
          </Button>
        )}
      />
      <PopoverContent align="end" className="w-64 gap-3 p-3">
        <div className="space-y-2">
          <Upper className="block">Mode</Upper>
          <div className="flex flex-wrap gap-2">
            {(["shadow", "live", "off"] as const).filter((mode) => mode !== control.mode).map((mode) => (
              <Button key={mode} size="sm" variant={mode === "live" ? "default" : "outline"} disabled={busy}
                onClick={() => act({ action: "mode", mode },
                  mode === "live"
                    ? "Switch to LIVE? The autowriter will post feedback to Wise for roster tutors."
                    : `Switch to ${mode.toUpperCase()}? No feedback will be posted to Wise.`)}>
                {MODE_BUTTON[mode]}
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-2 border-t pt-3">
          <Upper className="block">Posting</Upper>
          {control.haltedAt
            ? <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "resume" }, RESUME_CONFIRM)}>Resume</Button>
            : <Button size="sm" variant="destructive" disabled={busy} onClick={pause}>Pause</Button>}
        </div>
        {control.updatedBy ? (
          <p className="border-t pt-2 text-[10px] text-muted-foreground">Last changed by {control.updatedBy} · {when(control.updatedAt)}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function SystemLine({ dashboard, lastRun, canControl, busy, onControl }: {
  dashboard: Pick<AutowriterDashboard, "control" | "system" | "webhooks">;
  /** The review job's last run; null when it never ran, undefined while the review data is unavailable. */
  lastRun: AutowriterReview["lastRun"] | undefined;
  canControl: boolean;
  busy: boolean;
  onControl: ControlHandler;
}) {
  const { control, system, webhooks } = dashboard;
  const halted = Boolean(control.haltedAt);
  const tone = MODE_TONE[control.mode];
  const lastChange = control.updatedBy ? `Last changed by ${control.updatedBy} · ${when(control.updatedAt)}` : null;
  const facts: Array<{ key: string; content: ReactNode; title?: string }> = [
    { key: "writer", content: <>Writer {modelLabel(system.writer.model)} ({system.writer.effort})</>, title: system.writer.model },
    { key: "fallback", content: <>Fallback {modelLabel(system.fallbackWriter.model)} ({system.fallbackWriter.effort})</>, title: system.fallbackWriter.model },
    { key: "judge", content: <>Judge {modelLabel(system.judge.model)} ({effortsLabel(system.judge.efforts)})</>, title: system.judge.model },
    { key: "transcript-first", content: <>Transcript first: {system.transcriptFirst ? "on" : "off"}</> },
    { key: "second-pass", content: <>Second pass: {system.secondPass ? "on" : "off"}</> },
    {
      key: "versions", content: <>Prompt v{system.promptVersion} · Judge v{system.judgeVersion}</>,
      title: system.commit ? `Commit ${system.commit}` : undefined,
    },
    {
      key: "review-run",
      content: lastRun === undefined ? <>Last review run: unknown</>
        : lastRun === null ? <>Review job has not run yet</>
          : <>Last review run {when(lastRun.startedAt)} · {lastRun.status}</>,
      title: lastRun?.errorSummary ?? undefined,
    },
    { key: "webhook", content: <>Last Wise webhook {when(webhooks.lastReceivedAt)}</> },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-[9px] gap-y-1.5 text-[10px] text-muted-foreground" aria-label="System">
        {/* Who last changed the mode, for everyone (the owner's menu says it too). */}
        <span className={cn("flex items-center gap-[5px] font-semibold", tone.text)} title={lastChange ?? undefined}>
          <span aria-hidden className={cn("size-1.5 rounded-full", tone.dot)} />
          Mode {control.mode.toUpperCase()}
        </span>
        {halted ? <Tag tone="red">Halted</Tag> : null}
        {facts.map((fact) => (
          <Fragment key={fact.key}>
            <span aria-hidden>·</span>
            <span title={fact.title}>{fact.content}</span>
          </Fragment>
        ))}
        {canControl ? <span className="ml-auto"><ControlsMenu control={control} busy={busy} onControl={onControl} /></span> : null}
      </div>
      {halted ? (
        <div role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          <span><strong>Posting is halted</strong> since {when(control.haltedAt)} — {control.haltReason ?? "no reason recorded"}</span>
          {canControl ? (
            <Button size="sm" variant="outline" disabled={busy} className="border-red-300 bg-transparent text-red-800 hover:bg-red-100 hover:text-red-900 dark:text-red-200"
              onClick={() => onControl({ action: "resume" }, RESUME_CONFIRM)}>
              Resume
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

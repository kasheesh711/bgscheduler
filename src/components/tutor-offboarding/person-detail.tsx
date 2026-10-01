"use client";

import { useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HISTORY_START } from "@/lib/tutor-offboarding/calibration";
import type { OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { Tag, Upper } from "./atoms";
import { BAND_LABEL, formatDay, formatDayYear } from "./format";
import { accountLabel, LikelihoodBar } from "./person-row";

const SHEET = "top-0 right-0 left-auto flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-l p-0 data-open:zoom-in-100 data-closed:zoom-out-100 sm:max-w-[560px]";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function removalCheck(row: OffboardingPersonRow): string {
  if (row.score.exclusion) return `Not removable: ${row.score.exclusion.text}`;
  if (row.score.removableBlockedBy) return `Not removable yet: ${row.score.removableBlockedBy}`;
  return "Passes every removal check";
}

/** The evidence behind one person's score: reasons, sources, what is next, and each Wise account. */
export function PersonDetail({ row }: { row: OffboardingPersonRow }) {
  const { signals, score } = row;
  const none = `none since ${formatDay(HISTORY_START.toISOString())}`;
  const when = (iso: string | null, fallback: string) => (iso ? formatDayYear(iso) : fallback);
  return (
    <div className="space-y-5 text-sm">
      <section>
        <Upper>Likelihood no longer with us</Upper>
        <div className="mt-2 flex items-center gap-3"><LikelihoodBar value={score.likelihood} /><Tag>{BAND_LABEL[score.band]}</Tag></div>
        <ul className="mt-3 space-y-1.5">
          {score.reasons.map((reason) => (
            <li key={reason.code} className="flex gap-2">
              <span aria-hidden className={reason.direction === "toward_gone" ? "text-amber-600" : "text-available"}>
                {reason.direction === "toward_gone" ? "▲" : "▼"}
              </span>
              {reason.text}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">{removalCheck(row)}</p>
      </section>
      <section>
        <Upper>Last class, by source</Upper>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Class attendance</dt><dd>{when(signals.lastTaughtBySource.ledger, none)}</dd>
          <dt className="text-muted-foreground">Past classes</dt><dd>{when(signals.lastTaughtBySource.pastBlocks, none)}</dd>
          <dt className="text-muted-foreground">Class feedback</dt><dd>{when(signals.lastTaughtBySource.postClass, none)}</dd>
        </dl>
      </section>
      <section>
        <Upper>Now and next</Upper>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Upcoming classes</dt>
          <dd>{signals.upcomingSessions === 0 || !signals.nextSessionAt ? "None" : `${signals.upcomingSessions} (next ${formatDayYear(signals.nextSessionAt)})`}</dd>
          <dt className="text-muted-foreground">Leave</dt>
          <dd>{signals.upcomingLeaveUntil ? `Until ${formatDayYear(signals.upcomingLeaveUntil)}` : "None"}</dd>
          <dt className="text-muted-foreground">Last teacher action in Wise</dt><dd>{when(signals.lastTeacherActionAt, "None on record")}</dd>
          <dt className="text-muted-foreground">Last admin action in Wise</dt><dd>{when(signals.lastAdminActionAt, "None on record")}</dd>
        </dl>
      </section>
      <section>
        <Upper>Wise accounts</Upper>
        <ul className="mt-2 space-y-2">
          {signals.accounts.map((account) => (
            <li key={account.wiseTeacherId} className="rounded-md border px-3 py-2 text-xs">
              <div className="font-medium">{account.displayName}</div>
              <div className="text-muted-foreground">{accountLabel(account)}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Tag>{account.relation ?? "Role unknown"}</Tag>
                <Tag>{account.joinedOn ? `Joined ${formatDayYear(account.joinedOn)}` : "Joined date unknown"}</Tag>
                <Tag>{account.courseCount === null ? "Courses unknown" : plural(account.courseCount, "course")}</Tag>
                <Tag>{account.activated === null ? "Login unknown" : account.activated ? "Login activated" : "Never logged in"}</Tag>
                <Tag>{account.availabilityKnown ? plural(account.workingHourWindows, "working-hour window") : "Working hours unknown"}</Tag>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function PersonDrawer({ row, onClose }: { row: OffboardingPersonRow | null; onClose: () => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={row !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent initialFocus={bodyRef} className={SHEET}>
        <DialogHeader className="shrink-0 gap-1 border-b px-5 py-4 pr-12">
          <DialogTitle className="text-[15px] font-semibold tracking-tight">{row?.signals.displayName ?? ""}</DialogTitle>
          <DialogDescription className="text-xs">The evidence behind the score. Nothing here changes Wise.</DialogDescription>
        </DialogHeader>
        <div ref={bodyRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 outline-none">
          {row ? <PersonDetail row={row} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

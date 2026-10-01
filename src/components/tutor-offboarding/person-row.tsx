"use client";

import { Button } from "@/components/ui/button";
import type { OffboardingAccount, OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { cn } from "@/lib/utils";
import { Tag } from "./atoms";
import { TerminationBadge } from "./termination-evidence";

export function LikelihoodBar({ value }: { value: number }) {
  const tone = value >= 90 ? "bg-conflict" : value >= 70 ? "bg-amber-500" : "bg-muted-foreground/50";
  return (
    <span className="flex items-center gap-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label="Likelihood no longer with us">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full rounded-full", tone)} style={{ width: `${value}%` }} />
      </span>
      <span className="text-xs font-semibold tabular-nums">{value}%</span>
    </span>
  );
}

export function accountLabel(account: OffboardingAccount): string {
  return `${account.isOnlineVariant ? "Online" : "Onsite"}${account.email ? ` · ${account.email}` : ""}`;
}

export function PersonRow({ row, onOpen, onKeep }: { row: OffboardingPersonRow; onOpen: () => void; onKeep: () => void }) {
  const { signals, score } = row;
  return (
    <li className="flex flex-col items-start gap-3 border-t sm:flex-row sm:gap-4 px-5 py-3.5 first:border-t-0">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <span className="flex flex-wrap items-center gap-3">
          <span className="truncate text-[13px] font-semibold">{signals.displayName}</span>
          <TerminationBadge row={row} />
          <LikelihoodBar value={score.likelihood} />
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">{score.reasons[0]?.text}</span>
        <span className="mt-2 flex flex-wrap gap-1">
          {score.reasons.slice(1).map((reason) => (
            <Tag key={reason.code} className="max-w-full whitespace-normal break-words" tone={reason.direction === "toward_gone" ? "amber" : "green"}>{reason.text}</Tag>
          ))}
          {signals.accounts.map((account) => <Tag key={account.wiseTeacherId} className="max-w-full whitespace-normal [overflow-wrap:anywhere]">{accountLabel(account)}</Tag>)}
        </span>
      </button>
      <Button type="button" size="sm" variant="outline" onClick={onKeep}>Still with us</Button>
    </li>
  );
}

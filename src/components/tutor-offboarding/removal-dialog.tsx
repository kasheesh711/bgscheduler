"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { RemovalAccount, RemovalAccountStatus, RemovalApplyInput, RemovalRunDetail } from "@/lib/tutor-offboarding/removal-types";
import { Tag } from "./atoms";
import { formatDayYear } from "./format";

export const REMOVAL_STATUS_LABEL: Record<RemovalAccountStatus, string> = {
  planned: "Ready for removal", skipped: "Skipped", sending: "Sending · check status", sent: "Sent · awaiting verification",
  rejected: "Wise rejected the request", unknown: "Outcome unknown", verified: "Removal verified", not_removed: "Still in Wise",
  manual_required: "Remove by hand in Wise", removed_manually: "Manual removal verified", restored: "Re-added · local access restored",
};

export function removalAccountEmail(account: RemovalAccount): string | null {
  const user = account.accountSnapshot.userId;
  return typeof user === "object" && user !== null && typeof user.email === "string" ? user.email : null;
}

/** OFF-08/OFF-10/OFF-11: consent is for this saved, unexpired plan and exact account count. */
export function canConfirmRemoval(run: RemovalRunDetail, reason: string, count: string, confirmed: boolean, canRemove: boolean, now: Date): boolean {
  const planned = run.accounts.filter((account) => account.plan === "remove");
  return run.status === "previewed" && Date.parse(run.previewExpiresAt) > now.getTime() && !!run.previewToken &&
    run.accountCount > 0 && planned.length === run.accountCount && confirmed && canRemove &&
    reason.trim().length >= 10 && reason.trim().length <= 500 && count.trim() === String(run.accountCount);
}

export function RemovalAccounts({ accounts }: { accounts: RemovalAccount[] }) {
  return (
    <ul className="space-y-2" aria-label="Account removal plan and outcomes">
      {accounts.map((account) => (
        <li key={account.id} className="rounded-md border px-3 py-2 text-xs [overflow-wrap:anywhere]">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span className="font-medium">{`${account.displayName} · ${account.isOnlineVariant ? "Online" : "Onsite"}`}</span>
            <Tag tone={account.status === "verified" || account.status === "removed_manually" ? "green" : ["unknown", "rejected", "not_removed"].includes(account.status) ? "red" : "neutral"} className="max-w-full whitespace-normal">{REMOVAL_STATUS_LABEL[account.status]}</Tag>
          </div>
          <p className="mt-1 text-muted-foreground">{removalAccountEmail(account) ?? "Email not recorded"}</p>
          {account.skipReason ? <p className="mt-1 text-amber-800 dark:text-amber-200">{account.skipReason}</p> : null}
          {account.errorMessage ? <p className="mt-1 text-conflict">{account.errorMessage}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function RemovalRunContent({ run, canRemove, busy, uncertain, error, message, onApply, onRefresh, onReconcile, now }: {
  run: RemovalRunDetail; canRemove: boolean; busy: boolean; uncertain: boolean; error: string | null; message?: string | null;
  onApply: (input: RemovalApplyInput) => void; onRefresh: () => void; onReconcile: () => void; now?: Date;
}) {
  const [reason, setReason] = useState("");
  const [count, setCount] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    if (now) return;
    const timer = setInterval(() => setClock(new Date()), 1_000);
    return () => clearInterval(timer);
  }, [now]);
  const current = now ?? clock;
  const expired = run.status === "expired" || !Number.isFinite(Date.parse(run.previewExpiresAt)) || Date.parse(run.previewExpiresAt) <= current.getTime();
  const preview = run.status === "previewed" || run.status === "expired";
  const skipped = run.accounts.filter((account) => account.plan === "skip").length;
  const permitted = canConfirmRemoval(run, reason, count, confirmed, canRemove, current);
  const pending = run.accounts.some((account) => ["sending", "sent", "unknown", "rejected", "manual_required", "not_removed"].includes(account.status));
  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-muted/30 px-3 py-3 text-sm">
        <p className="font-semibold">{run.mode === "manual" ? "Manual mode" : "Live removal"}</p>
        <p className="mt-1 text-xs text-muted-foreground">{run.mode === "manual" ? "This saves a checklist. You remove the listed accounts yourself in Wise, then check their status here." : "Confirming this plan sends removal requests to Wise. It removes all listed accounts for each selected tutor."}</p>
      </div>
      <p className="text-sm font-medium">{`${run.tutorCount} ${run.tutorCount === 1 ? "tutor" : "tutors"} · ${run.accountCount} Wise ${run.accountCount === 1 ? "account" : "accounts"} ${preview ? "to remove" : "in this plan"}${skipped ? ` · ${skipped} skipped` : ""}`}</p>
      {!preview ? <p className="text-sm font-medium">{run.status === "applying" ? "This run is in progress. Check its status before taking another action." : run.status === "applied_with_errors" ? "Some accounts still need attention." : run.mode === "manual" ? "Manual checklist saved." : "Removal run finished. Review every account's outcome below."}</p> : null}
      {preview && expired ? <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">This preview has expired. Close it and create a fresh preview.</p> : null}
      {preview && run.accountCount === 0 ? <p className="text-sm text-muted-foreground">Every account was skipped. Nothing will be removed.</p> : null}
      <RemovalAccounts accounts={run.accounts} />
      {run.reason ? <p className="text-xs [overflow-wrap:anywhere]">{`Reason: ${run.reason}`}</p> : null}
      {error ? <p role="alert" className="text-sm text-conflict">{error}</p> : null}
      {message ? <p role="status" className="text-sm">{message}</p> : null}
      {uncertain ? <p className="text-sm text-amber-800 dark:text-amber-200">The request did not finish. Refresh this run’s status before taking another action. An uncertain outcome is checked against Wise.</p> : null}
      {preview && !expired && !uncertain && run.accountCount > 0 ? (
        <div className="space-y-3 border-t pt-4">
          {!canRemove ? <p className="text-xs text-amber-800 dark:text-amber-200">The owner must allow you to remove tutors.</p> : null}
          <label className="block space-y-1.5 text-xs font-medium">
            Reason for removal (at least 10 characters)
            <Textarea value={reason} disabled={busy} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Confirmed departure with the tutor" />
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            {`Type ${run.accountCount} to confirm the Wise account count`}
            <Input type="text" inputMode="numeric" value={count} disabled={busy} onChange={(event) => setCount(event.target.value)} autoComplete="off" />
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
            I have reviewed every account and want to proceed with this plan.
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{`Preview created ${formatDayYear(run.createdAt)}. Valid for 15 minutes.`}</p>
            <Button type="button" variant={run.mode === "live" ? "destructive" : "default"} disabled={busy || !permitted} onClick={() => onApply({ previewToken: run.previewToken, confirmed: true, reason: reason.trim(), accountCount: run.accountCount })}>
              {busy ? "Processing…" : run.mode === "manual" ? "Save manual checklist" : "Remove accounts from Wise"}
            </Button>
          </div>
        </div>
      ) : null}
      {(!preview || uncertain) ? (
        <div className="space-y-2 border-t pt-3">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRefresh}>Refresh run status</Button>
            {(pending || run.status === "applying") ? <Button type="button" variant="outline" size="sm" disabled={busy || !canRemove} onClick={onReconcile}>Check Wise status</Button> : null}
          </div>
          {!canRemove && pending ? <p className="text-xs text-amber-800 dark:text-amber-200">The owner must allow you to check live Wise status. You can still refresh this run’s saved status.</p> : null}
          <p className="text-xs text-muted-foreground">Checking status never sends another removal. Keep unknown accounts here until their outcome is confirmed.</p>
        </div>
      ) : null}
    </div>
  );
}

export function RemovalDialog({ run, onClose, ...props }: Omit<Parameters<typeof RemovalRunContent>[0], "run"> & { run: RemovalRunDetail | null; onClose: () => void }) {
  return (
    <Dialog open={run !== null} onOpenChange={(open) => { if (!open && !props.busy) onClose(); }}>
      <DialogContent showCloseButton={!props.busy} className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-[660px]">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
          <DialogTitle>{run?.status === "previewed" ? "Review removal plan" : "Removal run"}</DialogTitle>
          <DialogDescription>Review the mode, every account, and the recorded outcome.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4">
          {run ? <RemovalRunContent key={run.id} run={run} {...props} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

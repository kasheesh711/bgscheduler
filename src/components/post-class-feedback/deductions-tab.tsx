"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Banknote, CalendarRange, RotateCcw, Search, ShieldCheck, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { CsvExportButton } from "@/components/sales-dashboard/csv-export-button";
import { cn } from "@/lib/utils";
import type { CsvColumn } from "@/lib/sales-dashboard/csv";
import type {
  FeedbackDeductionRow,
  FeedbackDeductionStatus,
  FeedbackMutationRequest,
  FeedbackWaiverCategory,
  PostClassFeedbackPayload,
} from "@/types/post-class-feedback";
import { DeductionBadge, EmptyPanel, KpiCell, formatBangkokDate, formatBangkokMonth, formatMoney } from "./feedback-ui";

type DialogAction = "approve" | "waive" | "reopen" | "reinstate" | "move" | "process" | "reverse";

const WAIVER_OPTIONS: Array<{ value: FeedbackWaiverCategory; label: string }> = [
  { value: "wise_system_outage", label: "Wise / system outage" },
  { value: "incorrect_session_tutor_data", label: "Incorrect session or tutor data" },
  { value: "pre_approved_exception", label: "Pre-approved exception" },
  { value: "tutor_emergency", label: "Tutor emergency" },
  { value: "duplicate_system_error", label: "Duplicate / system error" },
  { value: "class_cancelled", label: "Class cancelled" },
  { value: "other", label: "Other" },
];

const ACTION_LABELS: Record<DialogAction, string> = {
  approve: "Approve deduction",
  waive: "Waive violation",
  reopen: "Reopen review",
  reinstate: "Reinstate deduction",
  move: "Move processing month",
  process: "Mark processed",
  reverse: "Record reversal",
};

/**
 * CSV columns for the deductions export: the on-screen table order first,
 * then decision/processing metadata, then stable identifiers. Timestamps are
 * pre-formatted to Bangkok wall time — the dto ships ISO strings, and letting
 * `csvValue` emit them raw would hand a Thai finance recipient UTC instants.
 * Amount stays a raw number so spreadsheets can sum the column.
 */
export const DEDUCTION_EXPORT_COLUMNS: CsvColumn<FeedbackDeductionRow>[] = [
  { key: "tutor", header: "Tutor", value: (row) => row.tutorName },
  { key: "sessionEndAt", header: "Session end (Bangkok)", value: (row) => (row.sessionEndAt ? formatBangkokDate(row.sessionEndAt, true) : "") },
  { key: "className", header: "Class", value: (row) => row.className },
  { key: "students", header: "Students", value: (row) => row.students },
  { key: "reason", header: "Reason", value: (row) => row.reason },
  { key: "amount", header: "Amount (THB)", value: (row) => row.amount },
  { key: "status", header: "Status", value: (row) => row.status },
  { key: "ledgerVerified", header: "Ledger verified", value: (row) => (row.payoutVerifiedWritten ? "yes" : "no") },
  { key: "processingMonth", header: "Processing month", value: (row) => row.processingMonth },
  { key: "referenceNote", header: "Processing reference", value: (row) => row.referenceNote },
  { key: "waiverCategory", header: "Waiver category", value: (row) => row.waiverCategory },
  { key: "decisionNote", header: "Decision note", value: (row) => row.decisionNote },
  { key: "decisionByEmail", header: "Decision by", value: (row) => row.decisionByEmail },
  { key: "decisionAt", header: "Decision at (Bangkok)", value: (row) => (row.decisionAt ? formatBangkokDate(row.decisionAt, true) : "") },
  { key: "processedByEmail", header: "Processed by", value: (row) => row.processedByEmail },
  { key: "processedAt", header: "Processed at (Bangkok)", value: (row) => (row.processedAt ? formatBangkokDate(row.processedAt, true) : "") },
  { key: "wiseSessionId", header: "Wise session", value: (row) => row.wiseSessionId },
  { key: "deductionId", header: "Deduction ID", value: (row) => row.id },
];

function rowSearchText(row: FeedbackDeductionRow): string {
  return [row.tutorName, row.className, ...row.students, row.reason, row.processingMonth ?? ""]
    .join(" ")
    .toLocaleLowerCase();
}

export function canProcessFeedbackDeduction(row: FeedbackDeductionRow): boolean {
  return row.status === "approved" && row.payoutVerifiedWritten;
}

export function DeductionsTab({
  payload,
  submitting,
  onMutation,
  startDate,
  endDate,
}: {
  payload: PostClassFeedbackPayload;
  submitting: boolean;
  onMutation: (request: FeedbackMutationRequest) => Promise<void>;
  startDate: string;
  endDate: string;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [status, setStatus] = useState<"all" | FeedbackDeductionStatus>("all");
  const [activeRow, setActiveRow] = useState<FeedbackDeductionRow | null>(null);
  const [action, setAction] = useState<DialogAction | null>(null);
  const [note, setNote] = useState("");
  const [referenceNote, setReferenceNote] = useState("");
  const [waiverCategory, setWaiverCategory] = useState<FeedbackWaiverCategory>("wise_system_outage");
  const firstOpenMonth = payload.financePeriods.find((period) => period.status === "open")?.month ?? "";
  const [processingMonth, setProcessingMonth] = useState(firstOpenMonth);

  const rows = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    return payload.deductions
      .filter((row) => {
        if (status !== "all" && row.status !== status) return false;
        return !needle || rowSearchText(row).includes(needle);
      })
      // Live decisions feed: undecided rows first (oldest class first, so the
      // longest-waiting review tops the queue), then decided rows newest
      // decision first.
      .toSorted((left, right) => {
        const leftPending = left.status === "pending_review";
        const rightPending = right.status === "pending_review";
        if (leftPending !== rightPending) return leftPending ? -1 : 1;
        if (leftPending) return left.sessionEndAt.localeCompare(right.sessionEndAt);
        return (right.decisionAt ?? right.updatedAt).localeCompare(left.decisionAt ?? left.updatedAt);
      });
  }, [deferredQuery, payload.deductions, status]);

  const statusCount = (target: FeedbackDeductionStatus) => payload.deductions.filter((row) => row.status === target).length;
  const approvedAmount = payload.deductions
    .filter((row) => row.status === "approved")
    .reduce((sum, row) => sum + row.amount, 0);
  const processedAmount = payload.deductions
    .filter((row) => row.status === "processed")
    .reduce((sum, row) => sum + row.amount, 0);

  function openDialog(row: FeedbackDeductionRow, nextAction: DialogAction) {
    setActiveRow(row);
    setAction(nextAction);
    setNote("");
    setReferenceNote(row.referenceNote ?? "");
    const rowMonthIsOpen = payload.financePeriods.some((period) =>
      period.status === "open" && period.month === row.processingMonth);
    const nextMonth = nextAction === "move"
      ? payload.financePeriods.find((period) =>
        period.status === "open" && period.month > (row.processingMonth ?? ""))?.month ?? ""
      : nextAction === "reverse"
        ? firstOpenMonth
        : rowMonthIsOpen ? row.processingMonth! : firstOpenMonth;
    setProcessingMonth(nextMonth);
  }

  async function submitAction() {
    if (!activeRow || !action || (noteRequired && !note.trim())) return;
    if (action === "approve" || action === "waive" || action === "reopen" || action === "reinstate") {
      await onMutation({
        endpoint: "/api/post-class-feedback/review",
        body: {
          deductionId: activeRow.id,
          action,
          note: note.trim(),
          ...(action === "waive" ? { waiverCategory } : {}),
          expectedVersion: activeRow.version,
          idempotencyKey: crypto.randomUUID(),
        },
      });
    } else {
      await onMutation({
        endpoint: "/api/post-class-feedback/finance",
        body: {
          deductionId: activeRow.id,
          action,
          processingMonth,
          referenceNote: referenceNote.trim(),
          reason: note.trim(),
          expectedVersion: activeRow.version,
          idempotencyKey: crypto.randomUUID(),
        },
      });
    }
    setActiveRow(null);
    setAction(null);
  }

  const financeAction = action === "move" || action === "process" || action === "reverse";
  const referenceRequired = action === "process" || action === "reverse";
  const noteRequired = action === "waive" || action === "reopen" || action === "reinstate" || action === "move" || action === "reverse";
  const selectableFinancePeriods = payload.financePeriods.filter((period) =>
    period.status === "open" && (
      action !== "move" || period.month > (activeRow?.processingMonth ?? "")
    ));
  const confirmDisabled = submitting
    || (noteRequired && !note.trim())
    || (financeAction && !processingMonth)
    || (referenceRequired && !referenceNote.trim());

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card shadow-sm md:grid-cols-3 xl:grid-cols-5">
        <KpiCell label="Pending review" value={statusCount("pending_review").toLocaleString()} detail="Individual decisions only" icon={<ShieldCheck className="size-3.5" />} />
        <KpiCell label="Approved" value={statusCount("approved").toLocaleString()} detail={formatMoney(approvedAmount)} tone="warning" icon={<Banknote className="size-3.5" />} />
        <KpiCell label="Processed" value={statusCount("processed").toLocaleString()} detail={formatMoney(processedAmount)} tone="good" icon={<WalletCards className="size-3.5" />} />
        <KpiCell label="Waived" value={statusCount("waived").toLocaleString()} detail="Adjusted compliant" icon={<RotateCcw className="size-3.5" />} />
        <KpiCell label="Open finance periods" value={payload.financePeriods.filter((period) => period.status === "open").length.toLocaleString()} detail="Bangkok calendar months" icon={<CalendarRange className="size-3.5" />} />
      </div>

      <Card className="gap-0 rounded-xl py-0 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <label className="relative min-w-56 flex-1">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search tutor, student, class, or reason…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <select
            aria-label="Deduction status"
            className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm"
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="all">All states</option>
            <option value="pending_review">Pending review</option>
            <option value="approved">Approved</option>
            <option value="waived">Waived</option>
            <option value="processed">Processed</option>
            <option value="reversed">Reversed</option>
          </select>
          <CsvExportButton
            filename={`feedback-deductions-${startDate}-to-${endDate}.csv`}
            rows={rows}
            columns={DEDUCTION_EXPORT_COLUMNS}
            disabled={rows.length === 0}
            title="Download the filtered deduction rows with decision metadata"
          />
        </div>

        {rows.length === 0 ? (
          <EmptyPanel title="No deductions match" detail="There are no deduction records for the selected filters and date range." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Tutor / session</TableHead>
                <TableHead>Class / students</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Decided</TableHead>
                <TableHead>Processing month</TableHead>
                <TableHead className="pr-4 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium">{row.tutorName}</div>
                    <div className="text-[11px] text-muted-foreground">{formatBangkokDate(row.sessionEndAt, true)}</div>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-52 truncate font-medium">{row.className}</div>
                    <div className="max-w-52 truncate text-[11px] text-muted-foreground">{row.students.join(", ")}</div>
                  </TableCell>
                  <TableCell><div className="max-w-60 whitespace-normal text-xs text-muted-foreground">{row.reason}</div></TableCell>
                  <TableCell className="font-semibold tabular-nums">{formatMoney(row.amount)}</TableCell>
                  <TableCell><DeductionBadge status={row.status} /></TableCell>
                  <TableCell>
                    {row.decisionByEmail ? (
                      <>
                        <div className="max-w-44 truncate text-xs">{row.decisionByEmail}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {row.decisionAt ? formatBangkokDate(row.decisionAt, true) : ""}
                        </div>
                      </>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">Awaiting review</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div>{formatBangkokMonth(row.processingMonth)}</div>
                    {row.status === "approved" ? (
                      <div className={cn(
                        "text-[11px]",
                        row.payoutLedgerState === "written" ? "text-emerald-700" : "text-amber-700",
                      )}>
                        {row.payoutLedgerState === "written" ? "Ledger verified" : "Publish required"}
                      </div>
                    ) : row.status === "waived" && row.payoutLedgerState !== "none" ? (
                      <div className="text-[11px] text-muted-foreground">
                        {row.payoutLedgerState === "removed" ? "Row removed from ledger" : "Netting pending"}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1.5">
                      {row.status === "pending_review" ? (
                        <>
                          <Button size="xs" disabled={!payload.capabilities.reviewer || submitting} onClick={() => openDialog(row, "approve")}>Approve</Button>
                          <Button size="xs" variant="outline" disabled={!payload.capabilities.reviewer || submitting} onClick={() => openDialog(row, "waive")}>Waive</Button>
                        </>
                      ) : row.status === "approved" ? (
                        <>
                          <Button
                            size="xs"
                            disabled={!payload.capabilities.finance || submitting || !canProcessFeedbackDeduction(row)}
                            title={row.payoutVerifiedWritten
                              ? "Mark the verified payout deduction as processed"
                              : "Publish and verify the payout deduction first"}
                            onClick={() => openDialog(row, "process")}
                          >
                            Process
                          </Button>
                          <Button size="xs" variant="outline" disabled={!payload.capabilities.finance || submitting || row.payoutVerifiedWritten} onClick={() => openDialog(row, "move")}>Move</Button>
                          <Button size="xs" variant="ghost" disabled={!payload.capabilities.reviewer || submitting || row.payoutVerifiedWritten} onClick={() => openDialog(row, "reopen")}>Reopen</Button>
                          <Button size="xs" variant="ghost" disabled={!payload.capabilities.reviewer || submitting} onClick={() => openDialog(row, "waive")}>Waive</Button>
                        </>
                      ) : row.status === "processed" ? (
                        <Button size="xs" variant="outline" disabled={!payload.capabilities.finance || submitting} onClick={() => openDialog(row, "reverse")}>Reverse</Button>
                      ) : row.status === "waived" ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={!payload.capabilities.reviewer || submitting}
                          title="Re-charge: allowed only when the original ledger row was removed"
                          onClick={() => openDialog(row, "reinstate")}
                        >
                          Reinstate
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Immutable</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={activeRow !== null && action !== null} onOpenChange={(open) => { if (!open) { setActiveRow(null); setAction(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{action ? ACTION_LABELS[action] : "Deduction action"}</DialogTitle>
            <DialogDescription>
              {activeRow ? `${activeRow.tutorName} · ${activeRow.className} · ${formatMoney(activeRow.amount)}` : ""} Every action is individually audited.
            </DialogDescription>
          </DialogHeader>
          {action === "waive" ? (
            <label className="grid gap-1.5 text-xs font-medium">
              Waiver category
              <select className="h-8 rounded-lg border border-input bg-background px-2 text-sm" value={waiverCategory} onChange={(event) => setWaiverCategory(event.target.value as FeedbackWaiverCategory)}>
                {WAIVER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          ) : null}
          {financeAction ? (
            <>
              <label className="grid gap-1.5 text-xs font-medium">
                Open processing month
                <select className="h-8 rounded-lg border border-input bg-background px-2 text-sm" value={processingMonth} onChange={(event) => setProcessingMonth(event.target.value)}>
                  <option value="">Select an open month</option>
                  {selectableFinancePeriods.map((period) => (
                    <option key={period.month} value={period.month}>{formatBangkokMonth(period.month)}</option>
                  ))}
                </select>
              </label>
              {referenceRequired ? (
                <label className="grid gap-1.5 text-xs font-medium">
                  Payroll / processing reference
                  <Input value={referenceNote} onChange={(event) => setReferenceNote(event.target.value)} placeholder="Payroll batch, payslip, or ledger reference" />
                </label>
              ) : null}
            </>
          ) : null}
          <label className="grid gap-1.5 text-xs font-medium">
            {noteRequired ? "Required audit reason" : "Audit note (optional)"}
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Explain why this action is appropriate…" />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActiveRow(null); setAction(null); }}>Cancel</Button>
            <Button disabled={confirmDisabled} onClick={() => void submitAction()}>{submitting ? "Saving…" : "Confirm action"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

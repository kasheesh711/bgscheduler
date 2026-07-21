"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CalendarCheck,
  Check,
  CirclePlay,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import type {
  FeedbackAdminAccessRow,
  FeedbackCapability,
  FeedbackEnforcementMode,
  FeedbackFinancePeriod,
  FeedbackTutorEmailRow,
  PostClassFeedbackPayload,
} from "@/types/post-class-feedback";
import { HealthMark, formatBangkokDate, formatBangkokMonth } from "./feedback-ui";

export type SettingsRequest = (
  endpoint: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
) => Promise<void>;

function bangkokDateInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  return `${map.get("year")}-${map.get("month")}-${map.get("day")}`;
}

function LaunchControl({ payload, submitting, onRequest }: {
  payload: PostClassFeedbackPayload;
  submitting: boolean;
  onRequest: SettingsRequest;
}) {
  const [effectiveDate, setEffectiveDate] = useState(bangkokDateInput(payload.settings.effectiveAt));
  const [activateOpen, setActivateOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [shadowReviewOpen, setShadowReviewOpen] = useState(false);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillStart, setBackfillStart] = useState("");
  const [backfillEnd, setBackfillEnd] = useState("");
  const [backfillCap, setBackfillCap] = useState("50");
  const settings = payload.settings;
  const canManage = payload.capabilities.accessManager;
  const shadowReviewComplete = payload.setup.items.find((item) => item.key === "shadow_review")?.complete ?? false;
  const collectionSyncLabel = settings.mode === "shadow"
    ? "Run shadow sync"
    : settings.mode === "live"
      ? "Run live collection sync"
      : "Run paused collection sync";

  async function updateMode(mode: FeedbackEnforcementMode) {
    await onRequest("/api/post-class-feedback/settings", "PATCH", {
      mode,
      ...(mode === "live" && !settings.effectiveAt ? { effectiveAt: effectiveDate } : {}),
      expectedVersion: settings.version,
    });
    setActivateOpen(false);
    setPauseOpen(false);
  }

  return (
    <Card className="gap-0 rounded-xl py-0 shadow-sm">
      <div className="border-b px-4 py-3">
        <h2 className="font-heading text-sm font-semibold">1. Launch control</h2>
      </div>
      <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-[0.7fr_1fr_1fr_1.25fr_auto]">
        <div>
          <div className="text-[11px] font-medium text-muted-foreground">Enforcement mode</div>
          <Badge variant="outline" className={cn(
            "mt-2 uppercase",
            settings.mode === "live" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : settings.mode === "paused" ? "border-red-200 bg-red-50 text-red-800" : "border-sky-200 bg-sky-50 text-sky-800",
          )}>{settings.mode}</Badge>
        </div>
        <div className="border-l pl-4">
          <div className="text-[11px] font-medium text-muted-foreground">Source health</div>
          <div className="mt-2"><HealthMark healthy={settings.sourceHealth === "healthy"} label={settings.sourceHealth} /></div>
          <div className="mt-1 text-[11px] text-muted-foreground">Synced {formatBangkokDate(settings.sourceLastSyncedAt, true)}</div>
        </div>
        <div className="border-l pl-4">
          <div className="text-[11px] font-medium text-muted-foreground">Form mapping</div>
          <div className="mt-2"><HealthMark healthy={settings.formMappingHealth === "healthy"} label={settings.formMappingHealth.replaceAll("_", " ")} /></div>
          <div className="mt-1 text-[11px] text-muted-foreground">Policy {settings.policyVersion}</div>
        </div>
        <label className="border-l pl-4 text-[11px] font-medium text-muted-foreground">
          Prospective effective date
          <Input className="mt-2" type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} disabled={!canManage || Boolean(settings.effectiveAt)} />
          <span className="mt-1 block">Bangkok time (UTC+7)</span>
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <Button variant="outline" disabled={!canManage || submitting} onClick={() => void onRequest("/api/post-class-feedback/sync", "POST", {})}>
            <RefreshCw />{collectionSyncLabel}
          </Button>
          <Button variant="outline" disabled={!canManage || submitting} onClick={() => setBackfillOpen(true)}>
            <CalendarCheck />Backfill range
          </Button>
          <Button variant="outline" disabled={!canManage || submitting || shadowReviewComplete} onClick={() => setShadowReviewOpen(true)}>
            <Check />{shadowReviewComplete ? "Shadow review confirmed" : "Confirm shadow review"}
          </Button>
          {settings.mode === "paused" ? (
            <Button
              variant="outline"
              disabled={!canManage || submitting || settings.formMappingHealth !== "healthy"}
              onClick={() => void updateMode("shadow")}
            >
              Resume in shadow
            </Button>
          ) : null}
          {settings.mode !== "live" ? (
            <Button disabled={!canManage || !effectiveDate || submitting || !payload.setup.items.filter((item) => item.key !== "activation").every((item) => item.complete)} onClick={() => setActivateOpen(true)}>
              <CirclePlay />Activate live
            </Button>
          ) : (
            <Button variant="destructive" disabled={!canManage || submitting} onClick={() => setPauseOpen(true)}>Pause enforcement</Button>
          )}
        </div>
      </div>
      <div className="grid gap-3 border-t p-4 md:grid-cols-2">
        <div className="flex gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
          <CalendarCheck className="size-4 shrink-0" />
          Activation is prospective and cannot be backdated. Sessions before the effective date remain outside enforcement.
        </div>
        <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="size-4 shrink-0" />
          Review shadow results, mapping, email coverage, and role coverage before going live.
        </div>
      </div>

      <Dialog open={activateOpen} onOpenChange={setActivateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activate live enforcement?</DialogTitle>
            <DialogDescription>Only sessions ending on or after {effectiveDate || "the effective date"} can create reminders and review candidates. This cannot be backdated.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActivateOpen(false)}>Cancel</Button>
            <Button disabled={submitting} onClick={() => void updateMode("live")}>Activate prospectively</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={shadowReviewOpen} onOpenChange={setShadowReviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm shadow review?</DialogTitle>
            <DialogDescription>Confirm only after inspecting the collected sessions, compliance outcomes, source issues, and reminder-email coverage. This confirmation is audited and is required before live activation.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShadowReviewOpen(false)}>Cancel</Button>
            <Button disabled={submitting} onClick={() => void onRequest("/api/post-class-feedback/shadow-review", "POST", {
              expectedVersion: settings.version,
            }).then(() => setShadowReviewOpen(false))}>
              Confirm reviewed
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={backfillOpen} onOpenChange={setBackfillOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Backfill a Bangkok date range</DialogTitle>
            <DialogDescription>
              Reconcile canonical Wise session detail for a bounded historical range. Enforcement windows still apply, so this cannot create retroactive live obligations.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium">
              Start date
              <Input type="date" value={backfillStart} onChange={(event) => setBackfillStart(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              End date
              <Input type="date" min={backfillStart} value={backfillEnd} onChange={(event) => setBackfillEnd(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium sm:col-span-2">
              Detail-call cap (1–50)
              <Input type="number" min={1} max={50} step={1} value={backfillCap} onChange={(event) => setBackfillCap(event.target.value)} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBackfillOpen(false)}>Cancel</Button>
            <Button
              disabled={submitting || !backfillStart || !backfillEnd || backfillEnd < backfillStart || !Number.isInteger(Number(backfillCap)) || Number(backfillCap) < 1 || Number(backfillCap) > 50}
              onClick={() => void onRequest("/api/post-class-feedback/sync", "POST", {
                startDate: backfillStart,
                endDate: backfillEnd,
                detailCap: Number(backfillCap),
              }).then(() => setBackfillOpen(false))}
            >
              Run backfill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={pauseOpen} onOpenChange={setPauseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pause enforcement?</DialogTitle>
            <DialogDescription>Collection continues, but new reminders and deduction candidates stop until live enforcement is activated again.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPauseOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={submitting} onClick={() => void updateMode("paused")}>Pause</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const CAPABILITIES: Array<{ key: FeedbackCapability; label: string; prop: "viewer" | "reviewer" | "finance" | "accessManager" }> = [
  { key: "viewer", label: "Viewer", prop: "viewer" },
  { key: "reviewer", label: "Reviewer", prop: "reviewer" },
  { key: "finance", label: "Finance", prop: "finance" },
  { key: "access_manager", label: "Access manager", prop: "accessManager" },
];

function AccessRoles({ admins, canManage, submitting, onRequest }: {
  admins: FeedbackAdminAccessRow[];
  canManage: boolean;
  submitting: boolean;
  onRequest: SettingsRequest;
}) {
  return (
    <Card className="gap-0 rounded-xl py-0 shadow-sm">
      <div className="border-b px-4 py-3">
        <h2 className="font-heading text-sm font-semibold">2. Access roles</h2>
        <p className="mt-1 text-xs text-muted-foreground">Roles are additive and limited to existing allowlisted admins. Server checks apply on every request.</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Admin</TableHead>
            {CAPABILITIES.map((capability) => <TableHead key={capability.key} className="text-center">{capability.label}</TableHead>)}
            <TableHead className="pr-4">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {admins.map((admin) => (
            <TableRow key={admin.email}>
              <TableCell className="pl-4">
                <div className="font-medium">{admin.name || admin.email}</div>
                {admin.name ? <div className="text-[11px] text-muted-foreground">{admin.email}</div> : null}
              </TableCell>
              {CAPABILITIES.map((capability) => (
                <TableCell key={capability.key} className="text-center">
                  <input
                    aria-label={`${capability.label} access for ${admin.email}`}
                    type="checkbox"
                    checked={admin[capability.prop]}
                    disabled={!canManage || submitting}
                    onChange={(event) => void onRequest("/api/post-class-feedback/access", "PATCH", {
                      email: admin.email,
                      capability: capability.key,
                      enabled: event.target.checked,
                      expectedVersion: admin.version,
                    })}
                    className="size-4 accent-sky-600"
                  />
                </TableCell>
              ))}
              <TableCell className="pr-4 text-xs text-muted-foreground">{formatBangkokDate(admin.updatedAt, true)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function TutorEmailEditor({ row, canManage, submitting, onRequest }: {
  row: FeedbackTutorEmailRow;
  canManage: boolean;
  submitting: boolean;
  onRequest: SettingsRequest;
}) {
  const [email, setEmail] = useState(row.primaryEmail ?? "");
  const changed = email.trim() !== (row.primaryEmail ?? "");
  const statusTone = row.status === "primary" || row.status === "fallback" ? "text-emerald-700" : row.status === "missing" ? "text-red-700" : "text-amber-700";
  return (
    <TableRow>
      <TableCell className="pl-4 font-medium">{row.tutorName}</TableCell>
      <TableCell><div className="max-w-64 whitespace-normal text-xs text-muted-foreground">{row.wiseEmails.join(", ") || "No Wise email"}</div></TableCell>
      <TableCell>
        <div className="flex min-w-64 gap-1.5">
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={!canManage} placeholder="Primary reminder email" />
          <Button size="icon-sm" variant="outline" disabled={!canManage || !changed || submitting} onClick={() => void onRequest("/api/post-class-feedback/tutor-emails", "PATCH", {
            tutorKey: row.tutorKey,
            primaryEmail: email.trim() || null,
            expectedVersion: row.version,
          })}>
            <Save /><span className="sr-only">Save email for {row.tutorName}</span>
          </Button>
        </div>
      </TableCell>
      <TableCell><span className={cn("text-xs capitalize", statusTone)}>{row.status}</span></TableCell>
      <TableCell className="pr-4 text-xs text-amber-700">{row.warning || "—"}</TableCell>
    </TableRow>
  );
}

function TutorEmails({ rows, canManage, submitting, onRequest }: {
  rows: FeedbackTutorEmailRow[];
  canManage: boolean;
  submitting: boolean;
  onRequest: SettingsRequest;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => !needle || [row.tutorName, row.primaryEmail ?? "", ...row.wiseEmails].some((value) => value.toLocaleLowerCase().includes(needle)));
  return (
    <Card className="gap-0 rounded-xl py-0 shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="mr-auto">
          <h2 className="font-heading text-sm font-semibold">3. Tutor reminder emails</h2>
          <p className="mt-1 text-xs text-muted-foreground">Primary email wins; one unambiguous Wise email is the only allowed fallback.</p>
        </div>
        <Input className="w-64" placeholder="Search tutor or email…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <Table>
        <TableHeader><TableRow><TableHead className="pl-4">Canonical tutor</TableHead><TableHead>Wise emails linked</TableHead><TableHead>Primary email</TableHead><TableHead>Status</TableHead><TableHead className="pr-4">Warning</TableHead></TableRow></TableHeader>
        <TableBody>{filtered.map((row) => <TutorEmailEditor key={`${row.tutorKey}:${row.version}`} row={row} canManage={canManage} submitting={submitting} onRequest={onRequest} />)}</TableBody>
      </Table>
    </Card>
  );
}

function FormMapping({ payload, submitting, onRequest }: {
  payload: PostClassFeedbackPayload;
  submitting: boolean;
  onRequest: SettingsRequest;
}) {
  const [mapping, setMapping] = useState(payload.settings.mapping);
  const canManage = payload.capabilities.accessManager;
  return (
    <Card className="gap-0 rounded-xl py-0 shadow-sm">
      <div className="border-b px-4 py-3">
        <h2 className="font-heading text-sm font-semibold">4. Wise form mapping</h2>
        <p className="mt-1 text-xs text-muted-foreground">Required mappings are fail-closed. Ambiguity pauses enforcement globally while raw evidence continues to sync.</p>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        {([
          ["topics", "Topics covered", true],
          ["performance", "Student performance", true],
          ["improvement", "Need more work on", true],
          ["homework", "Homework / due date", false],
        ] as const).map(([key, label, required]) => (
          <label key={key} className="grid gap-1.5 text-xs font-medium">
            <span>{label} {required ? <span className="text-red-600">*</span> : <span className="font-normal text-muted-foreground">optional</span>}</span>
            <Input value={mapping[key] ?? ""} onChange={(event) => setMapping((current) => ({ ...current, [key]: event.target.value || null }))} disabled={!canManage} placeholder="Exact Wise question text" />
          </label>
        ))}
      </div>
      <div className="flex justify-end border-t px-4 py-3">
        <Button disabled={!canManage || submitting || !mapping.topics || !mapping.performance || !mapping.improvement} onClick={() => void onRequest("/api/post-class-feedback/settings", "PATCH", { mapping, expectedVersion: payload.settings.version })}>
          <Save />Save mapping
        </Button>
      </div>
    </Card>
  );
}

function DigestRecipients({ payload, submitting, onRequest }: {
  payload: PostClassFeedbackPayload;
  submitting: boolean;
  onRequest: SettingsRequest;
}) {
  const [selected, setSelected] = useState(() => new Set(payload.settings.digestRecipientEmails));
  const [testRecipient, setTestRecipient] = useState(payload.settings.digestRecipientEmails[0] ?? "");
  const canManage = payload.capabilities.accessManager;
  return (
    <Card className="gap-0 rounded-xl py-0 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="mr-auto">
          <h2 className="font-heading text-sm font-semibold">5. Admin digest recipients</h2>
          <p className="mt-1 text-xs text-muted-foreground">Daily at 08:00 Bangkok with violations, source issues, and final reminder failures.</p>
        </div>
        <Input className="w-56" type="email" value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} placeholder="Test recipient" disabled={!canManage} />
        <Button variant="outline" disabled={!canManage || !testRecipient.trim() || submitting} onClick={() => void onRequest("/api/post-class-feedback/test-email", "POST", { recipientEmail: testRecipient.trim() })}>
          <Send />Send test
        </Button>
      </div>
      <div className="divide-y">
        {payload.admins.map((admin) => (
          <label key={admin.email} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/30">
            <input
              type="checkbox"
              className="size-4 accent-sky-600"
              checked={selected.has(admin.email)}
              disabled={!canManage}
              onChange={(event) => setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(admin.email); else next.delete(admin.email);
                return next;
              })}
            />
            <span className="font-medium">{admin.name || admin.email}</span>
            {admin.name ? <span className="text-xs text-muted-foreground">{admin.email}</span> : null}
          </label>
        ))}
      </div>
      <div className="flex justify-end border-t px-4 py-3">
        <Button disabled={!canManage || submitting || selected.size === 0} onClick={() => void onRequest("/api/post-class-feedback/settings", "PATCH", {
          digestRecipientEmails: Array.from(selected),
          expectedVersion: payload.settings.version,
        })}><Save />Save recipients</Button>
      </div>
    </Card>
  );
}

function FinancePeriods({ payload, submitting, onRequest }: {
  payload: PostClassFeedbackPayload;
  submitting: boolean;
  onRequest: SettingsRequest;
}) {
  const [dialog, setDialog] = useState<{ period: FeedbackFinancePeriod; action: "close" | "reopen" } | null>(null);
  const [reason, setReason] = useState("");
  const [newMonth, setNewMonth] = useState("");
  const canManage = payload.capabilities.finance;
  const monthAlreadyExists = payload.financePeriods.some((period) => period.month === newMonth);

  async function submit() {
    if (!dialog || (dialog.action === "reopen" && !reason.trim())) return;
    await onRequest("/api/post-class-feedback/finance-periods", "POST", {
      month: dialog.period.month,
      action: dialog.action,
      reason: reason.trim() || undefined,
      expectedVersion: dialog.period.version,
      idempotencyKey: crypto.randomUUID(),
    });
    setDialog(null);
    setReason("");
  }

  async function openPeriod() {
    await onRequest("/api/post-class-feedback/finance-periods", "POST", {
      month: newMonth,
      action: "open",
      idempotencyKey: crypto.randomUUID(),
    });
    setNewMonth("");
  }

  return (
    <Card className="gap-0 rounded-xl py-0 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="mr-auto">
          <h2 className="font-heading text-sm font-semibold">6. Finance periods</h2>
          <p className="mt-1 text-xs text-muted-foreground">Bangkok calendar months. A month cannot close with approved unprocessed items.</p>
        </div>
        <Input className="w-40" type="month" value={newMonth} onChange={(event) => setNewMonth(event.target.value)} disabled={!canManage} aria-label="New finance period month" />
        <Button
          variant="outline"
          disabled={!canManage || submitting || !/^\d{4}-\d{2}$/.test(newMonth) || monthAlreadyExists}
          onClick={() => void openPeriod()}
        >
          Open period
        </Button>
      </div>
      <Table>
        <TableHeader><TableRow><TableHead className="pl-4">Month</TableHead><TableHead>Status</TableHead><TableHead>Approved unprocessed</TableHead><TableHead>Updated</TableHead><TableHead className="pr-4 text-right">Action</TableHead></TableRow></TableHeader>
        <TableBody>
          {payload.financePeriods.map((period) => (
            <TableRow key={period.month}>
              <TableCell className="pl-4 font-medium">{formatBangkokMonth(period.month)}</TableCell>
              <TableCell><Badge variant="outline" className={period.status === "open" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "bg-muted"}>{period.status}</Badge></TableCell>
              <TableCell className="tabular-nums">{period.approvedUnprocessed}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{formatBangkokDate(period.updatedAt, true)}</TableCell>
              <TableCell className="pr-4 text-right">
                <Button variant="outline" size="xs" disabled={!canManage || submitting || (period.status === "open" && period.approvedUnprocessed > 0)} onClick={() => setDialog({ period, action: period.status === "open" ? "close" : "reopen" })}>
                  {period.status === "open" ? "Close month" : "Reopen month"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{dialog?.action === "close" ? "Close" : "Reopen"} {formatBangkokMonth(dialog?.period.month ?? null)}?</DialogTitle><DialogDescription>This status change is retained in the immutable configuration audit.</DialogDescription></DialogHeader>
          <label className="grid gap-1.5 text-xs font-medium">{dialog?.action === "reopen" ? "Required reason" : "Audit note (optional)"}<Textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={submitting || (dialog?.action === "reopen" && !reason.trim())} onClick={() => void submit()}>Confirm</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function SetupChecklist({ payload }: { payload: PostClassFeedbackPayload }) {
  return (
    <Card className="sticky top-0 gap-0 rounded-xl py-0 shadow-sm">
      <div className="border-b px-4 py-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-sky-600" />
          <h2 className="font-heading text-sm font-semibold">Setup checklist</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Finish these controls before live enforcement.</p>
      </div>
      <div className="divide-y">
        {payload.setup.items.map((item, index) => (
          <div key={item.key} className="flex gap-3 px-4 py-3">
            <span className={cn(
              "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
              item.complete ? "bg-emerald-500 text-white" : "bg-sky-600 text-white",
            )}>
              {item.complete ? <Check className="size-3.5" /> : index + 1}
            </span>
            <div>
              <div className="text-xs font-semibold">{item.label}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{item.detail}</div>
            </div>
          </div>
        ))}
      </div>
      <div className={cn("m-4 rounded-lg border p-3 text-xs", payload.setup.complete ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-sky-200 bg-sky-50 text-sky-900")}>
        {payload.setup.complete ? "Setup complete. Live activation is available to an access manager." : "Setup remains available here after launch for ongoing role, email, mapping, and finance maintenance."}
      </div>
    </Card>
  );
}

export function SettingsTab({
  payload,
  submitting,
  onRequest,
}: {
  payload: PostClassFeedbackPayload;
  submitting: boolean;
  onRequest: SettingsRequest;
}) {
  return (
    <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-3">
        <LaunchControl payload={payload} submitting={submitting} onRequest={onRequest} />
        <AccessRoles admins={payload.admins} canManage={payload.capabilities.accessManager} submitting={submitting} onRequest={onRequest} />
        <TutorEmails rows={payload.tutorEmails} canManage={payload.capabilities.accessManager} submitting={submitting} onRequest={onRequest} />
        <FormMapping payload={payload} submitting={submitting} onRequest={onRequest} />
        <DigestRecipients payload={payload} submitting={submitting} onRequest={onRequest} />
        <FinancePeriods payload={payload} submitting={submitting} onRequest={onRequest} />
      </div>
      <SetupChecklist payload={payload} />
    </div>
  );
}

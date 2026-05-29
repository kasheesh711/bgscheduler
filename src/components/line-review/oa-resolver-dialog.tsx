"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LineOaResolverRun, LineOaResolverRow, LineOaResolverRowStatus } from "./types";
import { formatDateTime, jsonFetch } from "./utils";

const STORAGE_KEY = "line-oa-resolver-run-id";

function statusLabel(status: LineOaResolverRowStatus): string {
  if (status === "no_match") return "No match";
  if (status === "needs_manual_code") return "Needs code";
  if (status === "ambiguous") return "Multi-candidate";
  return status[0].toUpperCase() + status.slice(1);
}

function statusVariant(status: LineOaResolverRowStatus): "default" | "outline" | "destructive" | "secondary" {
  if (status === "matched" || status === "committed") return "default";
  if (status === "error" || status === "needs_manual_code") return "destructive";
  if (status === "ambiguous" || status === "no_match") return "secondary";
  return "outline";
}

function CountChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-background px-2.5 py-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-semibold leading-none text-foreground">{value}</div>
    </div>
  );
}

interface ResolverCandidateContact {
  lineChatUrl: string;
  lineUserId: string;
  lineOaAccountId: string;
  chatTitle: string | null;
  adminNoteRaw: string | null;
  relationshipRole: string | null;
  candidateRank: number | null;
  siblingFanout?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function candidateContacts(row: LineOaResolverRow): ResolverCandidateContact[] {
  const rawCandidates = Array.isArray(row.evidence?.candidateContacts)
    ? row.evidence.candidateContacts
    : [];
  const candidates = rawCandidates
    .map(asRecord)
    .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate))
    .map((candidate, index) => ({
      lineChatUrl: asString(candidate.lineChatUrl) ?? "",
      lineUserId: asString(candidate.lineUserId) ?? "",
      lineOaAccountId: asString(candidate.lineOaAccountId) ?? "",
      chatTitle: asString(candidate.chatTitle),
      adminNoteRaw: asString(candidate.adminNoteRaw),
      relationshipRole: asString(candidate.relationshipRole),
      candidateRank: typeof candidate.candidateRank === "number" ? candidate.candidateRank : index + 1,
      siblingFanout: candidate.siblingFanout === true,
    }))
    .filter((candidate) => candidate.lineChatUrl && candidate.lineUserId);

  if (candidates.length > 0) return candidates;
  if (!row.lineChatUrl || !row.lineUserId) return [];
  return [{
    lineChatUrl: row.lineChatUrl,
    lineUserId: row.lineUserId,
    lineOaAccountId: row.lineOaAccountId ?? "",
    chatTitle: row.chatTitle,
    adminNoteRaw: null,
    relationshipRole: null,
    candidateRank: 1,
  }];
}

function candidateKey(rowId: string, lineUserId: string): string {
  return `${rowId}:${lineUserId}`;
}

function rowGroupKey(row: LineOaResolverRow): string {
  return row.studentKey;
}

export function OaResolverDialog({
  open,
  onOpenChange,
  onCommitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommitted: () => void;
}) {
  const [run, setRun] = useState<LineOaResolverRun | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "refresh" | "commit" | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [knownCandidateKeys, setKnownCandidateKeys] = useState<Set<string>>(new Set());

  const committableRows = useMemo(
    () => run?.rows.filter((row) => row.status === "matched" || row.status === "ambiguous") ?? [],
    [run],
  );
  const selectedCandidatePayload = useMemo(() => {
    const selected: Array<{ rowId: string; lineUserId: string }> = [];
    for (const row of committableRows) {
      for (const candidate of candidateContacts(row)) {
        if (selectedCandidates.has(candidateKey(row.id, candidate.lineUserId))) {
          selected.push({ rowId: row.id, lineUserId: candidate.lineUserId });
        }
      }
    }
    return selected;
  }, [committableRows, selectedCandidates]);
  const groupedRows = useMemo(() => {
    const groups = new Map<string, LineOaResolverRow[]>();
    for (const row of run?.rows ?? []) {
      const key = rowGroupKey(row);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.entries()];
  }, [run]);

  function toggleCandidate(rowId: string, lineUserId: string) {
    setSelectedCandidates((current) => {
      const next = new Set(current);
      const key = candidateKey(rowId, lineUserId);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function loadRun(runId: string, mode: "refresh" | "silent" = "refresh") {
    if (mode === "refresh") setBusy("refresh");
    setMessage(null);
    try {
      const payload = await jsonFetch<{ run: LineOaResolverRun }>(
        `/api/line/contacts/oa-resolver/runs/${runId}`,
      );
      setRun(payload.run);
      window.localStorage.setItem(STORAGE_KEY, payload.run.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load resolver run");
    } finally {
      if (mode === "refresh") setBusy(null);
    }
  }

  async function loadLatestRun() {
    setBusy("refresh");
    setMessage(null);
    try {
      const payload = await jsonFetch<{ run: LineOaResolverRun | null }>(
        "/api/line/contacts/oa-resolver/runs?latest=true",
      );
      setRun(payload.run);
      if (payload.run) window.localStorage.setItem(STORAGE_KEY, payload.run.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load resolver run");
    } finally {
      setBusy(null);
    }
  }

  async function createRun() {
    setBusy("create");
    setMessage(null);
    try {
      const payload = await jsonFetch<{ run: LineOaResolverRun; token: string }>(
        "/api/line/contacts/oa-resolver/runs",
        { method: "POST" },
      );
      setRun(payload.run);
      setToken(payload.token);
      window.localStorage.setItem(STORAGE_KEY, payload.run.id);
      setMessage("Resolver run created. Paste the token into the LINE OA Chrome extension.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to create resolver run");
    } finally {
      setBusy(null);
    }
  }

  async function copyToken() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setMessage("Extension token copied.");
  }

  async function commitRun() {
    if (!run) return;
    setBusy("commit");
    setMessage(null);
    try {
      const payload = await jsonFetch<{
        result: { committed: number; skipped: number; run: LineOaResolverRun };
      }>(`/api/line/contacts/oa-resolver/runs/${run.id}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selectedCandidates: selectedCandidatePayload }),
      });
      setRun(payload.result.run);
      setMessage(`Committed ${payload.result.committed} suggested link(s); skipped ${payload.result.skipped}.`);
      onCommitted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Commit failed");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    const storedRunId = window.localStorage.getItem(STORAGE_KEY);
    if (storedRunId && !run) {
      void loadRun(storedRunId, "silent");
    } else if (!run) {
      void loadLatestRun();
    }
  }, [open, run]);

  useEffect(() => {
    if (!open || !run || run.status !== "active") return;
    const interval = window.setInterval(() => {
      void loadRun(run.id, "silent");
    }, 4000);
    return () => window.clearInterval(interval);
  }, [open, run]);

  useEffect(() => {
    if (!run) {
      setSelectedCandidates(new Set());
      setKnownCandidateKeys(new Set());
      return;
    }
    const candidateKeys = new Set<string>();
    for (const row of run.rows) {
      if (row.status !== "matched" && row.status !== "ambiguous") continue;
      for (const candidate of candidateContacts(row)) {
        candidateKeys.add(candidateKey(row.id, candidate.lineUserId));
      }
    }
    setSelectedCandidates((current) => {
      const next = new Set(current);
      for (const key of candidateKeys) {
        if (!knownCandidateKeys.has(key)) next.add(key);
      }
      return next;
    });
    setKnownCandidateKeys(candidateKeys);
  }, [run]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-6xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border p-4">
          <DialogTitle className="flex items-center gap-2">
            <Search className="size-5 text-primary" />
            Bulk LINE OA resolver
          </DialogTitle>
          <DialogDescription>
            Generate a Wise student-code worklist, let the Chrome extension search LINE OA, then commit suggested links.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="space-y-3 border-b border-border p-4 lg:border-b-0 lg:border-r">
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-sm font-semibold text-foreground">1. Start or resume a run</div>
              <p className="mt-1 text-xs text-muted-foreground">
                New runs use the current Wise credit-control snapshot and include inactive current-snapshot students.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={createRun} disabled={Boolean(busy)}>
                  {busy === "create" ? <Loader2 className="animate-spin" /> : <Play />}
                  New run
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={loadLatestRun} disabled={Boolean(busy)}>
                  {busy === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  Latest
                </Button>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-sm font-semibold text-foreground">2. Run the Chrome extension</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Load the unpacked extension from <span className="font-mono">extensions/line-oa-resolver</span>, open LINE OA Manager, then paste this token.
              </p>
              <div className="mt-3 rounded-md border border-dashed border-border bg-background p-2 font-mono text-xs">
                {token ?? "Create a new run to reveal a token. Existing tokens are not shown again."}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={copyToken} disabled={!token}>
                  <Clipboard />
                  Copy token
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => window.open("https://chat.line.biz/", "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink />
                  Open LINE OA
                </Button>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-sm font-semibold text-foreground">3. Commit suggested links</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Commit only writes suggested links. Admin verification still happens inside Scheduler.
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-3"
                onClick={commitRun}
                disabled={!run || selectedCandidatePayload.length === 0 || Boolean(busy)}
              >
                {busy === "commit" ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                Commit {selectedCandidatePayload.length} selected candidate(s)
              </Button>
            </div>

            {message ? (
              <div className="rounded-lg border border-border bg-background p-3 text-sm text-muted-foreground">
                {message}
              </div>
            ) : null}
          </aside>

          <section className="min-h-0 overflow-hidden p-4">
            {!run ? (
              <div className="flex h-[520px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                Create or load a resolver run to see the preview table.
              </div>
            ) : (
              <div className="flex h-[520px] min-h-0 flex-col">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={run.status === "active" ? "default" : "outline"}>
                        {run.status}
                      </Badge>
                      <span className="text-sm font-medium text-foreground">
                        Run {run.id.slice(0, 8)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Expires {formatDateTime(run.expiresAt)} / created {formatDateTime(run.createdAt)}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => loadRun(run.id)}
                    disabled={Boolean(busy)}
                  >
                    <RefreshCw />
                    Refresh preview
                  </Button>
                </div>

                <div className="mb-3 grid grid-cols-3 gap-2 md:grid-cols-7">
                  <CountChip label="Total" value={run.totalRows} />
                  <CountChip label="Pending" value={run.pendingRows} />
                  <CountChip label="Matched" value={run.matchedRows} />
                  <CountChip label="Ambig." value={run.ambiguousRows} />
                  <CountChip label="No match" value={run.noMatchRows} />
                  <CountChip label="Needs code" value={run.needsManualCodeRows} />
                  <CountChip label="Committed" value={run.committedRows} />
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
                  {groupedRows.map(([groupKey, rows]) => (
                    <div key={groupKey} className="border-b border-border last:border-b-0">
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-muted/80 px-3 py-2 backdrop-blur">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-foreground">
                            {rows[0]?.studentName ?? groupKey}
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {rows[0]?.searchCode || "No dotted code"} / {rows[0]?.parentName || "No parent"}
                          </div>
                        </div>
                        <Badge variant="outline">{rows.length}</Badge>
                      </div>
                      {rows.map((row) => (
                        <div key={row.id} className="grid gap-2 border-b border-border px-3 py-2 last:border-b-0 md:grid-cols-[minmax(0,1fr)_120px_220px]">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-sm font-medium text-foreground">
                                {row.searchCode || "No dotted code"}
                              </div>
                              <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>
                            </div>
                            {row.errorMessage ? (
                              <div className="mt-1 text-xs text-destructive">{row.errorMessage}</div>
                            ) : null}
                            {candidateContacts(row).length > 0 ? (
                              <div className="mt-2 space-y-1.5">
                                {candidateContacts(row).map((candidate) => {
                                  const key = candidateKey(row.id, candidate.lineUserId);
                                  const checked = selectedCandidates.has(key);
                                  return (
                                    <label
                                      key={key}
                                      className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                                    >
                                      <input
                                        type="checkbox"
                                        className="mt-0.5"
                                        checked={checked}
                                        onChange={() => toggleCandidate(row.id, candidate.lineUserId)}
                                      />
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate font-medium text-foreground">
                                          {candidate.chatTitle || candidate.lineUserId}
                                        </span>
                                        <span className="block truncate text-muted-foreground">
                                          {candidate.relationshipRole || "unknown"}
                                          {candidate.adminNoteRaw ? ` / ${candidate.adminNoteRaw}` : ""}
                                          {candidate.siblingFanout ? " / sibling fanout" : ""}
                                        </span>
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                          <div className="min-w-0 text-xs text-muted-foreground">
                            <div className="truncate">{row.captureMode || row.matchMode || "n/a"}</div>
                            <div className="truncate">{row.lineOaAccountId || ""}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

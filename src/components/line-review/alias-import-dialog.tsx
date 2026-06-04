"use client";

import { useMemo, useState } from "react";
import { FileImage, Loader2, RefreshCw, Upload, WandSparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { mergeAliasImportPreviewSources, type AliasImportPreviewSource } from "./alias-import-batch";
import type { AliasImportPreview } from "./types";
import { jsonFetch } from "./utils";

type SelectedContacts = Record<string, string>;
type ScreenshotStatus = "queued" | "extracting" | "done" | "error";

interface ScreenshotQueueItem {
  id: string;
  file: File;
  sourceIndex: number;
  status: ScreenshotStatus;
  rowCount: number | null;
  error: string | null;
}

function candidateLabel(candidate: AliasImportPreview["rows"][number]["contactCandidates"][number]): string {
  const name = candidate.linkedStudentLabel || candidate.displayName || candidate.lineUserId;
  const time = candidate.lastMessageAt
    ? new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(candidate.lastMessageAt))
    : "no time";
  return `${name} / ${time} / score ${candidate.score}`;
}

async function fetchAliasPreview(input: {
  text?: string;
  image?: File;
  preferredContactId?: string | null;
}): Promise<AliasImportPreview> {
  const formData = new FormData();
  if (input.text?.trim()) formData.append("text", input.text.trim());
  if (input.image) formData.append("image", input.image);
  if (input.preferredContactId) formData.append("preferredContactId", input.preferredContactId);
  const response = await fetch("/api/line/contacts/alias-import/preview", {
    method: "POST",
    body: formData,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Preview failed");
  }
  return payload.preview as AliasImportPreview;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
  );
  return results;
}

export function AliasImportDialog({
  open,
  onOpenChange,
  preferredContactId,
  onCommitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preferredContactId: string | null;
  onCommitted: () => void;
}) {
  const [text, setText] = useState("");
  const [screenshots, setScreenshots] = useState<ScreenshotQueueItem[]>([]);
  const [preview, setPreview] = useState<AliasImportPreview | null>(null);
  const [selectedContacts, setSelectedContacts] = useState<SelectedContacts>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | "refresh" | null>(null);
  const hasImportInput = text.trim().length > 0 || screenshots.length > 0;

  const selectedRows = useMemo(() => (
    preview?.rows
      .map((row) => ({
        contactId: selectedContacts[row.rowId] || row.autoSelectedContactId,
        aliasLabel: row.aliasLabel,
      }))
      .filter((row): row is { contactId: string; aliasLabel: string } => Boolean(row.contactId)) ?? []
  ), [preview, selectedContacts]);

  function updateScreenshotStatus(
    id: string,
    patch: Partial<Pick<ScreenshotQueueItem, "status" | "rowCount" | "error">>,
  ) {
    setScreenshots((current) => current.map((item) => (
      item.id === id ? { ...item, ...patch } : item
    )));
  }

  function updateScreenshots(files: FileList | null) {
    const nextItems = Array.from(files ?? []).slice(0, 20).map((file, index) => ({
      id: `${file.name}-${file.lastModified}-${file.size}-${index}`,
      file,
      sourceIndex: text.trim() ? index + 1 : index,
      status: "queued" as const,
      rowCount: null,
      error: null,
    }));
    setScreenshots(nextItems);
    setPreview(null);
    setSelectedContacts({});
  }

  async function previewImport() {
    setBusy("preview");
    setMessage(null);
    setPreview(null);
    setSelectedContacts({});
    try {
      const sources: AliasImportPreviewSource[] = [];
      const textValue = text.trim();
      if (textValue) {
        const textPreview = await fetchAliasPreview({
          text: textValue,
          preferredContactId,
        });
        sources.push({
          sourceType: "text",
          sourceName: "Pasted text",
          sourceIndex: 0,
          preview: textPreview,
        });
      }

      const nextScreenshots = screenshots.map((item, index) => ({
        ...item,
        sourceIndex: textValue ? index + 1 : index,
        status: "queued" as const,
        rowCount: null,
        error: null,
      }));
      setScreenshots(nextScreenshots);

      const imageSources = await mapWithConcurrency(nextScreenshots, 2, async (item) => {
        updateScreenshotStatus(item.id, { status: "extracting", rowCount: null, error: null });
        try {
          const imagePreview = await fetchAliasPreview({
            image: item.file,
            preferredContactId,
          });
          updateScreenshotStatus(item.id, {
            status: "done",
            rowCount: imagePreview.rows.length,
            error: null,
          });
          return {
            sourceType: "image",
            sourceName: item.file.name,
            sourceIndex: item.sourceIndex,
            preview: imagePreview,
          } satisfies AliasImportPreviewSource;
        } catch (error) {
          updateScreenshotStatus(item.id, {
            status: "error",
            rowCount: null,
            error: error instanceof Error ? error.message : "Preview failed",
          });
          return null;
        }
      });
      const successfulImageSources: AliasImportPreviewSource[] = [];
      for (const source of imageSources) {
        if (source) successfulImageSources.push(source);
      }
      sources.push(...successfulImageSources);

      const rows = mergeAliasImportPreviewSources(sources);
      const nextPreview: AliasImportPreview = {
        source: screenshots.length > 0 ? "image" : "text",
        rows,
      };
      setPreview(nextPreview);
      setSelectedContacts(Object.fromEntries(
        rows
          .filter((row) => row.autoSelectedContactId)
          .map((row) => [row.rowId, row.autoSelectedContactId as string]),
      ));
      const failedCount = nextScreenshots.length - successfulImageSources.length;
      setMessage(
        `Extracted ${rows.length} alias row(s)` +
        (failedCount > 0 ? `; ${failedCount} screenshot(s) failed.` : "."),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preview failed");
    } finally {
      setBusy(null);
    }
  }

  async function commitImport() {
    if (selectedRows.length === 0) {
      setMessage("Select at least one matched LINE contact before committing aliases.");
      return;
    }
    setBusy("commit");
    setMessage(null);
    try {
      const payload = await jsonFetch<{ result: { applied: Array<{ contactId: string }> } }>(
        "/api/line/contacts/alias-import/commit",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rows: selectedRows }),
        },
      );
      setMessage(`Applied ${payload.result.applied.length} alias row(s).`);
      onCommitted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Commit failed");
    } finally {
      setBusy(null);
    }
  }

  async function refreshProfiles() {
    setBusy("refresh");
    setMessage(null);
    try {
      const payload = await jsonFetch<{
        result: { total: number; refreshed: number; missing: number; failed: Array<unknown> };
      }>("/api/line/contacts/refresh-profiles", { method: "POST" });
      setMessage(
        `Refreshed ${payload.result.refreshed}/${payload.result.total} LINE profiles. ` +
        `${payload.result.missing} missing, ${payload.result.failed.length} failed.`,
      );
      onCommitted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile refresh failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-5xl flex-col overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Import LINE chat aliases</DialogTitle>
          <DialogDescription>
            Capture staff-renamed LINE Desktop labels and turn them into suggested student links.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-3 overflow-hidden lg:grid-cols-[340px_minmax(0,1fr)]">
          <section className="space-y-3 overflow-y-auto rounded-lg border border-border bg-card p-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Paste chat-list text
              </div>
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={"𝓟☑️Kin/Parin.Pu\nเช็คตารางครู Tito ก่อนนะคะ"}
                className="mt-2 min-h-36"
              />
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Or upload screenshots
              </div>
              <Input
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp"
                className="mt-2"
                onChange={(event) => updateScreenshots(event.target.files)}
              />
              {screenshots.length > 0 ? (
                <div className="mt-2 space-y-1.5">
                  <div className="text-xs text-muted-foreground">
                    {screenshots.length} screenshot(s) queued. Processing runs two at a time.
                  </div>
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border bg-background p-2">
                    {screenshots.map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-2 text-xs">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <FileImage className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{item.file.name}</span>
                        </div>
                        <Badge
                          variant={item.status === "error" ? "destructive" : "outline"}
                          className="shrink-0"
                        >
                          {item.status === "extracting" ? "Extracting" : null}
                          {item.status === "queued" ? "Queued" : null}
                          {item.status === "done" ? `${item.rowCount ?? 0} rows` : null}
                          {item.status === "error" ? "Error" : null}
                        </Badge>
                      </div>
                    ))}
                  </div>
                  {screenshots.some((item) => item.error) ? (
                    <div className="space-y-1">
                      {screenshots.filter((item) => item.error).map((item) => (
                        <div key={`${item.id}-error`} className="text-xs text-destructive">
                          {item.file.name}: {item.error}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={previewImport}
                disabled={Boolean(busy) || !hasImportInput}
              >
                {busy === "preview" ? <Loader2 className="animate-spin" /> : <WandSparkles />}
                Preview import
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={refreshProfiles}
                disabled={Boolean(busy)}
              >
                {busy === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Refresh profiles
              </Button>
            </div>

            {message ? (
              <div className="rounded-md border border-border bg-background p-2 text-xs text-muted-foreground">
                {message}
              </div>
            ) : null}
          </section>

          <section className="min-h-0 overflow-y-auto rounded-lg border border-border bg-card p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-foreground">Preview rows</div>
                <div className="text-xs text-muted-foreground">
                  Auto-selected rows require a high-confidence message/time match.
                </div>
              </div>
              <Badge variant="outline">{selectedRows.length} selected</Badge>
            </div>

            {!preview ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                Paste text or upload a screenshot to preview alias matches.
              </div>
            ) : preview.rows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No alias rows were extracted. Try a clearer screenshot or paste one chat label per line.
              </div>
            ) : (
              <div className="space-y-3">
                {preview.rows.map((row) => (
                  <div key={row.rowId} className="rounded-lg border border-border bg-background p-3">
                    <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <div className="text-sm font-semibold text-foreground">{row.aliasLabel}</div>
                          {row.sourceName ? (
                            <Badge variant="outline" className="max-w-48 truncate">
                              {row.sourceName}
                            </Badge>
                          ) : null}
                          {row.duplicateCount && row.duplicateCount > 1 ? (
                            <Badge variant="secondary">{row.duplicateCount} duplicates</Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {row.latestMessagePreview || "No preview text"} {row.timeLabel ? `/ ${row.timeLabel}` : ""}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {row.parsedCodes.length === 0 ? (
                            <Badge variant="outline">No student code parsed</Badge>
                          ) : row.parsedCodes.map((code) => (
                            <Badge key={code.normalized} variant="secondary">{code.code}</Badge>
                          ))}
                          {row.suggestedStudents.map((student) => (
                            <Badge key={student.studentKey} variant="outline">
                              {student.studentName}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <select
                        className="h-8 min-w-64 rounded-md border border-border bg-background px-2 text-xs"
                        value={selectedContacts[row.rowId] ?? row.autoSelectedContactId ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSelectedContacts((current) => ({
                            ...current,
                            [row.rowId]: value,
                          }));
                        }}
                      >
                        <option value="">No contact selected</option>
                        {row.contactCandidates.map((candidate) => (
                          <option key={candidate.contactId} value={candidate.contactId}>
                            {candidateLabel(candidate)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="mt-2 space-y-1">
                      {row.contactCandidates.length === 0 ? (
                        <div className="text-xs text-destructive">
                          No contact match found. Use a row with visible latest-message preview/time.
                        </div>
                      ) : row.contactCandidates.slice(0, 2).map((candidate) => (
                        <div key={candidate.contactId} className="text-xs text-muted-foreground">
                          {candidateLabel(candidate)} / {candidate.reasons.join(", ") || "matched"}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border pt-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            type="button"
            onClick={commitImport}
            disabled={Boolean(busy) || selectedRows.length === 0}
          >
            {busy === "commit" ? <Loader2 className="animate-spin" /> : <Upload />}
            Commit selected aliases
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

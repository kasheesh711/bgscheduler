"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Calendar, Check, Copy, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatSlotTime } from "@/lib/search/recommend";
import type { AiSchedulerOption, AiSchedulerResponse, AiSchedulerSolvedRequest } from "@/lib/ai/scheduler";
import { cn } from "@/lib/utils";

interface AiSchedulerPanelProps {
  enabled: boolean;
  onAddToCompare: (tutorIds: string[]) => void;
  disableAdd: boolean;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatParsedRequest(parsed: AiSchedulerSolvedRequest): string {
  const day = parsed.searchMode === "one_time"
    ? parsed.date ?? "one-time"
    : parsed.dayOfWeek !== undefined
      ? `every ${DAY_NAMES[parsed.dayOfWeek]}`
      : "recurring";
  const filters = [parsed.filters.subject, parsed.filters.curriculum, parsed.filters.level]
    .filter(Boolean)
    .join(" / ");
  return [
    day,
    `${parsed.startTime}-${parsed.endTime}`,
    `${parsed.durationMinutes} min`,
    parsed.mode,
    filters || "Any qualification",
  ].join(" · ");
}

function optionTutorIds(option: AiSchedulerOption): string[] {
  return option.tutors.slice(0, 3).map((tutor) => tutor.tutorGroupId);
}

export function AiSchedulerPanel({ enabled, onAddToCompare, disableAdd }: AiSchedulerPanelProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<AiSchedulerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editedMessage, setEditedMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setEditedMessage(null);
    setCopied(false);
  }, [response]);

  const handleSolve = async () => {
    const trimmed = input.trim();
    if (!enabled || !trimmed || loading) return;

    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const res = await fetch("/api/search/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? `AI scheduling failed (${res.status})`);
      }
      setResponse(data as AiSchedulerResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI scheduling failed");
    } finally {
      setLoading(false);
    }
  };

  const message = response?.status === "solved"
    ? editedMessage ?? response.parentMessageDraft
    : "";

  const handleCopy = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mb-2 flex-shrink-0 rounded-lg border border-border bg-card/80 p-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Sparkles className="h-3 w-3 text-primary" aria-hidden />
        AI scheduler
        {!enabled && (
          <Badge variant="outline" className="ml-auto h-5 px-1.5 text-[9px]">
            Disabled
          </Badge>
        )}
      </div>

      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          maxLength={6000}
          disabled={!enabled || loading}
          placeholder="Paste parent request or LINE chat thread..."
          className="min-h-[76px] flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs leading-relaxed outline-none focus:ring-2 focus:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label="Parent scheduling request"
        />
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={handleSolve}
          disabled={!enabled || loading || input.trim().length === 0}
          className="h-[76px] w-[78px] shrink-0 text-xs"
        >
          {loading ? "Solving..." : "Solve"}
        </Button>
      </div>

      {!enabled && (
        <div className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
          AI scheduler unavailable.
        </div>
      )}

      {error && (
        <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      )}

      {response?.status === "needs_clarification" && (
        <div className="mt-2 rounded-md border border-amber-300/40 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <AlertCircle className="h-3 w-3" aria-hidden />
            Needs clarification
          </div>
          <ul className="space-y-0.5">
            {response.clarifyingQuestions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
          {response.warnings.length > 0 && (
            <div className="mt-1.5 space-y-0.5 text-[10.5px] opacity-80">
              {response.warnings.map((warning, index) => (
                <div key={index}>{warning}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {response?.status === "solved" && (
        <div className="mt-2 space-y-2">
          <div className="rounded-md border border-primary/20 bg-primary/5 px-2 py-1.5 text-[11px] text-foreground">
            <span className="font-medium">Parsed:</span> {formatParsedRequest(response.parsedRequest)}
          </div>

          {response.parsedRequest.assumptions.length > 0 && (
            <div className="space-y-0.5 text-[10.5px] text-muted-foreground">
              {response.parsedRequest.assumptions.map((assumption, index) => (
                <div key={index}>{assumption}</div>
              ))}
            </div>
          )}

          <div className="divide-y divide-border rounded-md border border-border">
            {response.options.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                No proven available options in this window.
              </div>
            ) : (
              response.options.map((option) => (
                <div key={option.id} className="flex items-start gap-2 px-2 py-2">
                  <Badge variant="secondary" className="mt-0.5 h-5 px-1.5 text-[9px]">
                    #{option.rank}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-foreground">
                      {formatSlotTime(option.start, option.end)}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {option.tutors.map((tutor) => tutor.displayName).join(" or ")}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {option.reasons.slice(0, 2).map((reason) => (
                        <span key={reason} className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                          <Check className="h-2.5 w-2.5 text-available" aria-hidden />
                          {reason}
                        </span>
                      ))}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAddToCompare(optionTutorIds(option))}
                    disabled={disableAdd || option.tutors.length === 0}
                    title={disableAdd ? "Max 3 tutors - remove one first" : "Show these tutors in calendar"}
                    aria-label="Show AI option tutors in calendar"
                    className="h-7 w-7 p-0"
                  >
                    <Calendar className="h-3 w-3" aria-hidden />
                  </Button>
                </div>
              ))
            )}
          </div>

          {response.warnings.length > 0 && (
            <div className="space-y-0.5 text-[10.5px] text-muted-foreground">
              {response.warnings.map((warning, index) => (
                <div key={index}>{warning}</div>
              ))}
            </div>
          )}

          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Parent message
            </div>
            <textarea
              value={message}
              onChange={(e) => setEditedMessage(e.target.value)}
              rows={6}
              className={cn(
                "min-h-[132px] w-full resize-none rounded-md border border-border bg-muted/30 p-2 text-xs leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-ring/50",
              )}
              aria-label="Editable AI parent message"
            />
            <div className="mt-1.5 flex items-center gap-2">
              {editedMessage !== null && editedMessage !== response.parentMessageDraft && (
                <button
                  type="button"
                  onClick={() => setEditedMessage(null)}
                  className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Reset
                </button>
              )}
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={handleCopy}
                className="ml-auto h-7 gap-1.5 text-[11px]"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3" aria-hidden /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" aria-hidden /> Copy for parent
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

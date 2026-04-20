"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Copy, Check, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatSlotTime, type RecommendedSlot } from "@/lib/search/recommend";
import { DAY_NAMES } from "@/components/search/search-form";
import type { SearchContext } from "@/components/search/search-form";
import { cn } from "@/lib/utils";

interface CopyForParentDrawerProps {
  open: boolean;
  onClose: () => void;
  slots: RecommendedSlot[];
  searchContext: SearchContext | null;
}

type Tone = "friendly" | "terse";

function formatDayForSlot(searchContext: SearchContext | null): string {
  if (!searchContext) return "";
  if (searchContext.searchMode === "one_time" && searchContext.date) {
    const d = new Date(searchContext.date + "T00:00:00");
    return `${DAY_NAMES[d.getDay()]} ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
  }
  if (searchContext.searchMode === "recurring" && searchContext.dayOfWeek !== undefined) {
    const longDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return `every ${longDays[searchContext.dayOfWeek]}`;
  }
  return "";
}

function buildMessage({
  slots,
  tone,
  includeTutorNames,
  searchContext,
}: {
  slots: RecommendedSlot[];
  tone: Tone;
  includeTutorNames: boolean;
  searchContext: SearchContext | null;
}): string {
  if (slots.length === 0) return "";

  const subject = searchContext?.filters.subject ?? "";
  const curriculum = searchContext?.filters.curriculum ?? "";
  const level = searchContext?.filters.level ?? "";
  const subjectParts = [subject, curriculum, level].filter(Boolean).join(" ");
  const subjectLabel = subjectParts || "tuition";

  const header =
    tone === "friendly"
      ? `Hi! Here ${slots.length === 1 ? "is" : "are"} ${slots.length} option${slots.length > 1 ? "s" : ""} for ${subjectLabel}:`
      : `${subjectLabel} — proposed slot${slots.length > 1 ? "s" : ""}:`;

  const dayLabel = formatDayForSlot(searchContext);

  const lines = slots.map((slot, i) => {
    const tutorList = includeTutorNames
      ? slot.availableTutors.slice(0, 3).map((t) => t.displayName).join(" or ")
      : "";
    const tutorSuffix = tutorList ? ` — ${tutorList}` : "";
    const prefix = slots.length > 1 ? `${i + 1}. ` : "• ";
    return `${prefix}${dayLabel ? `${dayLabel}, ` : ""}${formatSlotTime(slot.start, slot.end)}${tutorSuffix}`;
  });

  const footer = tone === "friendly" ? "\nLet me know which works best and I'll confirm." : "";

  return [header, "", ...lines, footer].filter((v) => v !== null).join("\n").trimEnd();
}

export function CopyForParentDrawer({
  open,
  onClose,
  slots,
  searchContext,
}: CopyForParentDrawerProps) {
  const [copied, setCopied] = useState(false);
  const [tone, setTone] = useState<Tone>("friendly");
  const [includeTutorNames, setIncludeTutorNames] = useState(true);
  const [edited, setEdited] = useState<string | null>(null);

  const generatedMessage = useMemo(
    () => buildMessage({ slots, tone, includeTutorNames, searchContext }),
    [slots, tone, includeTutorNames, searchContext],
  );

  // Reset editable textarea when slots / tone / toggle change
  useEffect(() => {
    setEdited(null);
    setCopied(false);
  }, [open, slots, tone, includeTutorNames]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const message = edited ?? generatedMessage;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard errors — surface failure via button state reset only.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Copy slots for parent"
    >
      <div
        className="absolute inset-0 bg-black/30 animate-in fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={cn(
          "relative flex h-full w-[440px] max-w-full flex-col border-l border-border bg-card shadow-2xl",
          "animate-in slide-in-from-right duration-200",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Send className="h-4 w-4 text-primary" aria-hidden />
          <div className="text-sm font-semibold">Copy for parent</div>
          <span className="text-[11px] text-muted-foreground">
            {slots.length} slot{slots.length !== 1 ? "s" : ""}
          </span>
          <button
            onClick={onClose}
            aria-label="Close drawer"
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="text-[11px] font-medium text-muted-foreground">Tone</span>
          {(["friendly", "terse"] as Tone[]).map((t) => (
            <button
              key={t}
              onClick={() => setTone(t)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[11px] font-medium capitalize transition-colors",
                tone === t
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-muted text-muted-foreground hover:bg-muted/80",
              )}
            >
              {t}
            </button>
          ))}
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={includeTutorNames}
              onChange={(e) => setIncludeTutorNames(e.target.checked)}
              className="h-3 w-3 rounded"
            />
            Tutor names
          </label>
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Message preview
          </div>
          <textarea
            value={message}
            onChange={(e) => setEdited(e.target.value)}
            rows={10}
            className="min-h-[220px] flex-1 resize-none rounded-md border border-border bg-muted/30 p-3 font-sans text-[13px] leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-ring/50"
            spellCheck={false}
            aria-label="Editable message to copy"
          />
          {edited !== null && edited !== generatedMessage && (
            <button
              onClick={() => setEdited(null)}
              className="self-start text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Reset to generated text
            </button>
          )}

          <div className="mt-2 space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Included slots
            </div>
            {slots.map((slot, i) => (
              <div
                key={slot.id}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[12px]"
              >
                <span className="font-mono text-[10px] text-muted-foreground">#{i + 1}</span>
                <span className="font-medium">{formatSlotTime(slot.start, slot.end)}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {slot.availableTutors.length} tutor{slot.availableTutors.length > 1 ? "s" : ""}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleCopy}
            className="ml-auto min-w-[180px] justify-center gap-1.5"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" aria-hidden /> Copied to clipboard
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" aria-hidden /> Copy message
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

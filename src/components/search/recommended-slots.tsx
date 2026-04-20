"use client";

import { useMemo, useState } from "react";
import { Sparkles, Check, Copy, Calendar, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TUTOR_COLORS } from "@/components/compare/session-colors";
import { getRecommendedSlots, formatSlotTime, type RecommendedSlot } from "@/lib/search/recommend";
import { DAY_NAMES } from "@/components/search/search-form";
import { cn } from "@/lib/utils";
import type { RangeSearchResponse } from "@/lib/search/types";
import type { SearchContext } from "@/components/search/search-form";

interface RecommendedSlotsProps {
  response: RangeSearchResponse;
  searchContext: SearchContext | null;
  onOpenDrawer: (slots: RecommendedSlot[]) => void;
  onAddToCompare: (tutorIds: string[]) => void;
  disableAdd: boolean;
}

function getDayLabel(searchContext: SearchContext | null): {
  dayLabel: string;
  dateLabel: string;
} {
  if (!searchContext) return { dayLabel: "", dateLabel: "" };
  if (searchContext.searchMode === "one_time" && searchContext.date) {
    const d = new Date(searchContext.date + "T00:00:00");
    const dayLabel = DAY_NAMES[d.getDay()];
    const dateLabel = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    return { dayLabel, dateLabel };
  }
  if (searchContext.searchMode === "recurring" && searchContext.dayOfWeek !== undefined) {
    const longDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return { dayLabel: longDays[searchContext.dayOfWeek], dateLabel: "every week" };
  }
  return { dayLabel: "", dateLabel: "" };
}

function Avatar({ id, label, size = 22 }: { id: string; label: string; size?: number }) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const color = TUTOR_COLORS[Math.abs(h) % TUTOR_COLORS.length];
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold ring-2 ring-card"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `color-mix(in oklch, ${color} 16%, white)`,
        color,
        border: `1px solid color-mix(in oklch, ${color} 30%, white)`,
      }}
      aria-hidden
    >
      {label}
    </span>
  );
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function RecommendedSlots({
  response,
  searchContext,
  onOpenDrawer,
  onAddToCompare,
  disableAdd,
}: RecommendedSlotsProps) {
  const slots = useMemo(() => getRecommendedSlots(response, 3), [response]);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  if (slots.length === 0) return null;

  const { dayLabel, dateLabel } = getDayLabel(searchContext);

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickedSlots = slots.filter((s) => picked.has(s.id));

  return (
    <div className="mb-2 flex-shrink-0">
      <div className="flex items-center justify-between px-0.5 pb-1.5">
        <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Sparkles className="h-3 w-3 text-accent-foreground" aria-hidden />
          Recommended slots
        </div>
        <span className="text-[10px] text-muted-foreground">
          Auto-ranked · fit × availability
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {slots.map((slot, i) => {
          const isPicked = picked.has(slot.id);
          const tutors = slot.availableTutors;
          return (
            <div
              key={slot.id}
              className={cn(
                "relative flex flex-col gap-2 rounded-lg border bg-card p-2.5 shadow-sm transition-all cursor-pointer",
                isPicked
                  ? "border-primary/50 bg-primary/5 ring-2 ring-primary/30"
                  : "hover:border-primary/30 hover:shadow-md",
              )}
              onClick={() => togglePick(slot.id)}
              role="button"
              tabIndex={0}
              aria-pressed={isPicked}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  togglePick(slot.id);
                }
              }}
            >
              {/* Confidence badge */}
              <div className="absolute right-2 top-2">
                <Badge
                  variant="secondary"
                  className="gap-0.5 bg-accent/60 px-1.5 py-0 text-[9px] font-semibold text-accent-foreground"
                >
                  #{i + 1} {slot.confidence}
                </Badge>
              </div>

              {/* Day + date */}
              <div className="pr-14">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {dayLabel} {dateLabel && `· ${dateLabel}`}
                </div>
                <div className="text-[15px] font-semibold leading-tight tracking-tight text-foreground">
                  {formatSlotTime(slot.start, slot.end)}
                </div>
              </div>

              {/* Tutor avatar stack */}
              <div className="flex items-center gap-1">
                <div className="flex -space-x-1.5">
                  {tutors.slice(0, 3).map((t) => (
                    <Avatar
                      key={t.tutorGroupId}
                      id={t.tutorGroupId}
                      label={initialsOf(t.displayName)}
                      size={22}
                    />
                  ))}
                </div>
                <span className="ml-1 text-[10.5px] text-muted-foreground">
                  {tutors.length} tutor{tutors.length > 1 ? "s" : ""} free
                </span>
              </div>

              {/* Reasons */}
              <ul className="space-y-0.5">
                {slot.reasons.slice(0, 3).map((r, j) => (
                  <li
                    key={j}
                    className="flex items-center gap-1 text-[10.5px] text-muted-foreground"
                  >
                    <Check className="h-2.5 w-2.5 flex-shrink-0 text-available" aria-hidden />
                    {r}
                  </li>
                ))}
              </ul>

              {/* Actions */}
              <div className="mt-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant="default"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenDrawer([slot]);
                  }}
                  className="h-7 flex-1 gap-1 text-[11px]"
                >
                  <Copy className="h-3 w-3" aria-hidden /> Copy for parent
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(e) => {
                    e.stopPropagation();
                    const ids = tutors.slice(0, 3).map((t) => t.tutorGroupId);
                    onAddToCompare(ids);
                  }}
                  disabled={disableAdd}
                  title={disableAdd ? "Max 3 tutors — remove one first" : "Show these tutors in calendar"}
                  aria-label={`Show ${tutors.length} tutors in calendar`}
                  className="h-7 w-7 p-0"
                >
                  <Calendar className="h-3 w-3" aria-hidden />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bundle hint */}
      {pickedSlots.length > 1 && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs">
          <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
          <span>
            <strong>{pickedSlots.length} slots</strong> selected — bundle into one message
          </span>
          <Button
            size="sm"
            variant="default"
            className="ml-auto h-6 gap-1 text-[11px]"
            onClick={() => onOpenDrawer(pickedSlots)}
          >
            <Send className="h-3 w-3" aria-hidden /> Bundle & copy
          </Button>
        </div>
      )}
    </div>
  );
}

"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SearchSlot } from "@/lib/search/types";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface SlotChipsProps {
  slots: SearchSlot[];
  onRemove: (id: string) => void;
}

export function SlotChips({ slots, onRemove }: SlotChipsProps) {
  if (slots.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {slots.map((slot) => (
        <Badge key={slot.id} variant="secondary" className="gap-1 px-3 py-1.5 text-sm">
          <span>
            {slot.dayOfWeek !== undefined
              ? WEEKDAY_NAMES[slot.dayOfWeek]
              : slot.date}{" "}
            {slot.start}-{slot.end}
          </span>
          <span className="text-xs text-muted-foreground">({slot.mode})</span>
          <button
            onClick={() => onRemove(slot.id)}
            className="ml-1 text-muted-foreground hover:text-foreground"
          >
            x
          </button>
        </Badge>
      ))}
    </div>
  );
}

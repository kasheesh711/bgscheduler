"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { RangeGridRow } from "@/lib/search/types";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatSlotTime(start: string, end: string): string {
  const fmt = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    const suffix = h >= 12 ? "pm" : "am";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
  };
  return `${fmt(start)}-${fmt(end)}`;
}

interface CopyButtonProps {
  grid: RangeGridRow[];
  subSlots: { start: string; end: string }[];
  selectedIds: Set<string>;
  dayOfWeek?: number;
  date?: string;
  filters?: { subject?: string; curriculum?: string; level?: string };
}

export function CopyButton({
  grid,
  subSlots,
  selectedIds,
  dayOfWeek,
  date,
  filters,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const selectedRows = grid.filter((r) => selectedIds.has(r.tutorGroupId));

  const handleCopy = async () => {
    if (selectedRows.length === 0) return;

    // Build header
    const parts: string[] = [];
    if (filters?.subject) parts.push(filters.subject);
    if (filters?.curriculum) parts.push(`(${filters.curriculum})`);
    if (filters?.level) parts.push(filters.level);

    const dayLabel =
      date ??
      (dayOfWeek !== undefined ? DAY_NAMES[dayOfWeek] : "");

    const header =
      parts.length > 0
        ? `${parts.join(" ")} - ${dayLabel}`
        : dayLabel;

    // Build tutor lines
    const lines = selectedRows.map((row, i) => {
      const modeLabel = row.supportedModes.join("/");
      const times = row.availability
        .map((avail, j) => (avail ? formatSlotTime(subSlots[j].start, subSlots[j].end) : null))
        .filter(Boolean)
        .join(", ");
      return `${i + 1}. ${row.displayName} (${modeLabel}): ${times}`;
    });

    const text = [header, "", ...lines].join("\n");

    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      disabled={selectedIds.size === 0}
    >
      {copied ? "Copied!" : `Copy for parents (${selectedIds.size})`}
    </Button>
  );
}

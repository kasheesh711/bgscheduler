"use client";

import { Badge } from "@/components/ui/badge";
import type { RangeGridRow, TutorReviewResult } from "@/lib/search/types";

function formatSlotLabel(start: string, end: string): string {
  const fmt = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    const suffix = h >= 12 ? "pm" : "am";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
  };
  return `${fmt(start)}-${fmt(end)}`;
}

interface AvailabilityGridProps {
  subSlots: { start: string; end: string }[];
  grid: RangeGridRow[];
  needsReview: TutorReviewResult[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}

export function AvailabilityGrid({
  subSlots,
  grid,
  needsReview,
  selectedIds,
  onToggleSelect,
}: AvailabilityGridProps) {
  if (grid.length === 0 && needsReview.length === 0) {
    return (
      <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
        No tutors found matching your criteria.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {grid.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="w-8 px-3 py-2 text-left" />
                <th className="min-w-[120px] px-3 py-2 text-left font-medium">Tutor</th>
                {subSlots.map((ss, i) => (
                  <th key={i} className="min-w-[70px] px-2 py-2 text-center font-medium text-xs">
                    {formatSlotLabel(ss.start, ss.end)}
                  </th>
                ))}
                <th className="min-w-[100px] px-3 py-2 text-left font-medium">Mode</th>
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => {
                const isSelected = selectedIds.has(row.tutorGroupId);
                return (
                  <tr
                    key={row.tutorGroupId}
                    className={`border-b cursor-pointer transition-colors ${
                      isSelected ? "bg-blue-950/30" : "hover:bg-muted/30"
                    }`}
                    onClick={() => onToggleSelect(row.tutorGroupId)}
                  >
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleSelect(row.tutorGroupId)}
                        className="rounded"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">{row.displayName}</td>
                    {row.availability.map((avail, i) => (
                      <td
                        key={i}
                        className={`px-2 py-2 text-center ${
                          avail
                            ? "bg-green-950/40 text-green-400"
                            : "text-muted-foreground/30"
                        }`}
                      >
                        {avail ? "\u2713" : "\u2014"}
                      </td>
                    ))}
                    <td className="px-3 py-2">
                      <div className="flex gap-1 flex-wrap">
                        {row.supportedModes.map((m) => (
                          <Badge key={m} variant="secondary" className="text-xs">
                            {m}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {needsReview.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Needs Review ({needsReview.length})
          </h3>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Tutor</th>
                  <th className="px-3 py-2 text-left font-medium">Reasons</th>
                </tr>
              </thead>
              <tbody>
                {needsReview.map((t) => (
                  <tr key={t.tutorGroupId} className="border-b">
                    <td className="px-3 py-2 font-medium">{t.displayName}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 flex-wrap">
                        {t.reasons.map((r, i) => (
                          <Badge key={i} variant="destructive" className="text-xs">
                            {r.split(":")[0]}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

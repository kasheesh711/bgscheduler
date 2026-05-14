"use client";

import {
  buildHeatmapCells,
  groupCellsByRoom,
  minuteToTimeLabel,
  type TimelineBounds,
} from "@/lib/classrooms/visualization";
import type { ClassroomRoom, ClassroomRow } from "./types";

interface RoomOccupancyHeatmapProps {
  rows: ClassroomRow[];
  rooms: ClassroomRoom[];
  bounds: TimelineBounds;
  currentMinute: number;
  onMinuteSelect: (minute: number) => void;
}

function cellColor(loadRatio: number, active: boolean, isReview: boolean): string {
  if (isReview && active) return "var(--blocked)";
  if (!active) return "var(--muted)";
  if (loadRatio > 1) return "var(--conflict)";
  if (loadRatio >= 0.8) return "var(--blocked)";
  if (loadRatio >= 0.45) return "oklch(0.75 0.14 120)";
  return "var(--available)";
}

export function RoomOccupancyHeatmap({
  rows,
  rooms,
  bounds,
  currentMinute,
  onMinuteSelect,
}: RoomOccupancyHeatmapProps) {
  const groups = groupCellsByRoom(buildHeatmapCells(rows, rooms, bounds));
  const firstCells = groups[0]?.cells ?? [];

  return (
    <div className="min-h-0 overflow-auto rounded-lg border bg-card p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">Room heat map</div>
        <div className="text-xs text-muted-foreground">15-minute bins</div>
      </div>
      <div className="min-w-max">
        <div
          className="grid items-end gap-1 pl-[132px]"
          style={{ gridTemplateColumns: `repeat(${firstCells.length}, 12px)` }}
        >
          {firstCells.map((cell, index) => (
            <div
              key={cell.id}
              className="h-8 text-[10px] text-muted-foreground [writing-mode:vertical-rl]"
              aria-hidden={index % 4 !== 0}
            >
              {index % 4 === 0 ? minuteToTimeLabel(cell.startMinute) : ""}
            </div>
          ))}
        </div>

        <div className="space-y-1">
          {groups.map((group) => (
            <div
              key={group.roomName}
              className="grid items-center gap-1"
              style={{ gridTemplateColumns: `124px repeat(${group.cells.length}, 12px)` }}
            >
              <div className="truncate pr-2 text-xs font-medium" title={group.roomName}>
                {group.roomName}
              </div>
              {group.cells.map((cell) => {
                const activeNow = currentMinute >= cell.startMinute && currentMinute < cell.endMinute;
                return (
                  <button
                    key={cell.id}
                    type="button"
                    onClick={() => onMinuteSelect(cell.startMinute)}
                    className="h-4 rounded-[2px] border border-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    style={{
                      backgroundColor: cellColor(cell.loadRatio, cell.active, cell.isReview),
                      opacity: cell.active ? 0.95 : 0.55,
                      boxShadow: activeNow ? "0 0 0 2px var(--foreground)" : undefined,
                    }}
                    title={`${group.roomName} ${minuteToTimeLabel(cell.startMinute)}-${minuteToTimeLabel(cell.endMinute)}: ${cell.rows.length} session(s)`}
                    aria-label={`${group.roomName} ${minuteToTimeLabel(cell.startMinute)} to ${minuteToTimeLabel(cell.endMinute)}, ${cell.rows.length} session(s)`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

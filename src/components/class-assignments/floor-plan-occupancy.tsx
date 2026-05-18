"use client";

import {
  FLOOR_PLAN_GUIDE_PATH,
  FLOOR_PLAN_ROOMS,
  FLOOR_PLAN_VIEWBOX,
  type FloorPlanRoomGeometry,
} from "@/lib/classrooms/floor-plan";
import {
  buildRoomOccupancyState,
  minuteToTimeLabel,
  REVIEW_LANE_ROOM_NAME,
  rowLoad,
} from "@/lib/classrooms/visualization";
import type { ClassroomRoom, ClassroomRow } from "./types";
import { AssignmentDetailPopover } from "./assignment-detail-popover";

interface FloorPlanOccupancyProps {
  rows: ClassroomRow[];
  rooms: ClassroomRoom[];
  currentMinute: number;
  onUpdateOverride: (row: ClassroomRow, overrideRoom: string) => void;
}

function shortTutorName(value: string): string {
  const nickname = value.match(/\(([^)]+)\)/)?.[1];
  if (nickname) return nickname;
  return value.split(/\s+/)[0] ?? value;
}

function roomFill(status: string, loadRatio: number): string {
  if (status === "over_capacity") return "oklch(0.9 0.07 25)";
  if (status === "full") return "oklch(0.9 0.065 75)";
  if (status === "occupied") {
    if (loadRatio >= 0.75) return "oklch(0.9 0.055 95)";
    return "oklch(0.92 0.06 155)";
  }
  return "var(--card)";
}

function roomStroke(status: string): string {
  if (status === "over_capacity") return "var(--conflict)";
  if (status === "full") return "var(--blocked)";
  if (status === "occupied") return "var(--available)";
  return "var(--border)";
}

function labelLines(geometry: FloorPlanRoomGeometry, activeRows: ClassroomRow[]): string[] {
  if (activeRows.length === 0) return geometry.labelLines;
  const tutors = activeRows.slice(0, 2).map((row) => shortTutorName(row.tutorDisplayName));
  if (activeRows.length > 2) tutors.push(`+${activeRows.length - 2}`);
  return tutors;
}

export function FloorPlanOccupancy({
  rows,
  rooms,
  currentMinute,
  onUpdateOverride,
}: FloorPlanOccupancyProps) {
  const state = buildRoomOccupancyState(rows, rooms, currentMinute);
  const byRoom = new Map(state.rooms.map((snapshot) => [snapshot.room.name, snapshot]));

  return (
    <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-h-0 overflow-auto rounded-lg border bg-card p-3">
        <svg
          viewBox={FLOOR_PLAN_VIEWBOX}
          role="img"
          aria-label="Interactive BeGifted floor plan occupancy"
          className="min-h-[520px] w-full min-w-[980px]"
        >
          <rect x="0" y="0" width="1600" height="900" rx="18" fill="var(--background)" />
          <path
            d={FLOOR_PLAN_GUIDE_PATH}
            fill="none"
            stroke="var(--border)"
            strokeWidth="3"
            strokeDasharray="8 10"
            opacity="0.55"
          />

          {FLOOR_PLAN_ROOMS.map((geometry) => {
            const snapshot = byRoom.get(geometry.roomName);
            const activeRows = snapshot?.activeRows ?? [];
            const assignable = geometry.assignable;
            const fill = assignable
              ? roomFill(snapshot?.status ?? "empty", snapshot?.loadRatio ?? 0)
              : "var(--muted)";
            const stroke = assignable ? roomStroke(snapshot?.status ?? "empty") : "var(--border)";
            const lines = labelLines(geometry, activeRows);
            const detailRows = activeRows;
            const roomMeta = snapshot?.room;

            if (!assignable) {
              return (
                <g key={geometry.roomName} aria-label={geometry.label}>
                  <path d={geometry.d} fill={fill} stroke={stroke} strokeWidth="4" opacity="0.75" />
                  <text
                    x={geometry.labelX}
                    y={geometry.labelY}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[18px] font-semibold"
                  >
                    {geometry.labelLines.map((line, index) => (
                      <tspan key={line} x={geometry.labelX} dy={index === 0 ? 0 : 22}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              );
            }

            return (
              <AssignmentDetailPopover
                key={geometry.roomName}
                rows={detailRows}
                rooms={rooms}
                roomName={geometry.roomName}
                onUpdateOverride={onUpdateOverride}
                trigger={(props) => (
                  <g
                    {...props}
                    tabIndex={0}
                    role="button"
                    aria-label={`${geometry.roomName}, ${activeRows.length} active session${activeRows.length === 1 ? "" : "s"} at ${minuteToTimeLabel(currentMinute)}`}
                    className="cursor-pointer outline-none"
                  >
                    <path
                      d={geometry.d}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={activeRows.length > 0 ? 6 : 4}
                      className="transition-[fill,stroke,stroke-width] duration-200 motion-reduce:transition-none"
                    />
                    <text
                      x={geometry.labelX}
                      y={geometry.labelY - (lines.length - 1) * 11}
                      textAnchor="middle"
                      className="pointer-events-none fill-foreground text-[18px] font-semibold"
                    >
                      {lines.map((line, index) => (
                        <tspan key={`${line}-${index}`} x={geometry.labelX} dy={index === 0 ? 0 : 22}>
                          {line}
                        </tspan>
                      ))}
                    </text>
                    {activeRows.length > 0 && (
                      <text
                        x={geometry.labelX}
                        y={geometry.labelY + 46}
                        textAnchor="middle"
                        className="pointer-events-none fill-muted-foreground text-[15px] font-medium"
                      >
                        {snapshot?.load ?? 0}/{roomMeta?.capacity ?? 0}
                      </text>
                    )}
                  </g>
                )}
              >
                {roomMeta
                  ? `Capacity ${roomMeta.capacity}, TV ${roomMeta.hasTv ? "yes" : "no"}, load ${snapshot?.load ?? 0}`
                  : "Room not active"}
              </AssignmentDetailPopover>
            );
          })}
        </svg>
      </div>

      <div className="rounded-lg border bg-card p-3">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-sm font-semibold">At {minuteToTimeLabel(currentMinute)}</div>
          <div className="text-xs text-muted-foreground">
            {state.rooms.filter((room) => room.activeRows.length > 0).length} rooms active
          </div>
        </div>
        <div className="mt-3 max-h-[560px] space-y-2 overflow-auto pr-1">
          {state.rooms
            .filter((room) => room.activeRows.length > 0)
            .map((snapshot) => (
              <div key={snapshot.room.id} className="rounded-md border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{snapshot.room.name}</span>
                  <span className="font-mono text-muted-foreground">
                    {snapshot.load}/{snapshot.room.capacity}
                  </span>
                </div>
                <div className="mt-1 space-y-1 text-muted-foreground">
                  {snapshot.activeRows.map((row) => (
                    <div key={row.id} className="truncate">
                      {shortTutorName(row.tutorDisplayName)} - {row.studentName || row.title || "Untitled"}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          {state.reviewRows.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:bg-amber-950/20">
              <div className="font-semibold">{REVIEW_LANE_ROOM_NAME}</div>
              <div className="mt-1 space-y-1 text-amber-800 dark:text-amber-200">
                {state.reviewRows.map((row) => (
                  <div key={row.id} className="truncate">
                    {shortTutorName(row.tutorDisplayName)} - {row.assignedRoom} - load {rowLoad(row)}
                  </div>
                ))}
              </div>
            </div>
          )}
          {state.rooms.every((room) => room.activeRows.length === 0) && state.reviewRows.length === 0 && (
            <div className="rounded-md border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
              No active sessions.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

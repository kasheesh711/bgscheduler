"use client";

import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  buildRoomCalendarEvents,
  getActiveRooms,
  minuteToTimeLabel,
  REVIEW_LANE_ROOM_NAME,
  type TimelineBounds,
} from "@/lib/classrooms/visualization";
import type { ClassroomRoom, ClassroomRow } from "./types";
import { AssignmentDetailPopover } from "./assignment-detail-popover";

interface RoomCalendarViewProps {
  rows: ClassroomRow[];
  rooms: ClassroomRoom[];
  bounds: TimelineBounds;
  onUpdateOverride: (row: ClassroomRow, overrideRoom: string) => void;
}

const HOUR_HEIGHT = 68;
const ROOM_WIDTH = 188;
const TIME_RAIL_WIDTH = 58;

function eventTop(bounds: TimelineBounds, minute: number): number {
  return ((minute - bounds.startMinute) / 60) * HOUR_HEIGHT;
}

function eventHeight(row: Pick<ClassroomRow, "startMinute" | "endMinute">): number {
  return Math.max(((row.endMinute - row.startMinute) / 60) * HOUR_HEIGHT - 4, 30);
}

function classLabel(row: ClassroomRow): string {
  return row.subject || row.classType || row.title || "";
}

function roomLaneNames(rows: ClassroomRow[], rooms: ClassroomRoom[]): string[] {
  const activeRoomNames = getActiveRooms(rooms).map((room) => room.name);
  const events = buildRoomCalendarEvents(rows, rooms);
  if (events.some((event) => event.isReview) && !activeRoomNames.includes(REVIEW_LANE_ROOM_NAME)) {
    activeRoomNames.push(REVIEW_LANE_ROOM_NAME);
  }
  return activeRoomNames;
}

export function RoomCalendarView({
  rows,
  rooms,
  bounds,
  onUpdateOverride,
}: RoomCalendarViewProps) {
  const events = buildRoomCalendarEvents(rows, rooms);
  const roomNames = roomLaneNames(rows, rooms);
  const height = ((bounds.endMinute - bounds.startMinute) / 60) * HOUR_HEIGHT;
  const hours = [];
  for (let minute = bounds.startMinute; minute <= bounds.endMinute; minute += 60) {
    hours.push(minute);
  }

  return (
    <div className="h-full min-h-0 overflow-auto rounded-lg border bg-card">
      <div
        className="grid min-w-max border-b bg-card"
        style={{ gridTemplateColumns: `${TIME_RAIL_WIDTH}px repeat(${roomNames.length}, ${ROOM_WIDTH}px)` }}
      >
        <div className="sticky left-0 z-20 border-r bg-card" />
        {roomNames.map((roomName) => (
          <div
            key={roomName}
            className="sticky top-0 z-10 border-r bg-card px-2 py-2 text-center text-xs font-semibold"
          >
            <span className="line-clamp-2">{roomName}</span>
          </div>
        ))}
      </div>

      <div
        className="relative min-w-max"
        style={{
          height,
          width: TIME_RAIL_WIDTH + roomNames.length * ROOM_WIDTH,
        }}
      >
        <div
          className="sticky left-0 z-10 h-full border-r bg-card"
          style={{ width: TIME_RAIL_WIDTH }}
        >
          {hours.map((minute) => (
            <div
              key={minute}
              className="absolute right-2 font-mono text-[11px] text-muted-foreground"
              style={{ top: eventTop(bounds, minute) - 7 }}
            >
              {minuteToTimeLabel(minute)}
            </div>
          ))}
        </div>

        {hours.map((minute) => (
          <div
            key={minute}
            className="absolute border-t border-border/50"
            style={{
              left: TIME_RAIL_WIDTH,
              right: 0,
              top: eventTop(bounds, minute),
            }}
          />
        ))}

        {roomNames.map((roomName, index) => {
          const left = TIME_RAIL_WIDTH + index * ROOM_WIDTH;
          const roomEvents = events.filter((event) => event.roomName === roomName);
          return (
            <div
              key={roomName}
              className="absolute top-0 border-r border-border/60"
              style={{ left, width: ROOM_WIDTH, height }}
            >
              {roomEvents.map((event) => {
                const laneWidth = (ROOM_WIDTH - 10) / event.laneCount;
                const cardLeft = 5 + event.lane * laneWidth;
                const review = event.isReview || event.row.warnings.length > 0 || event.row.status !== "assigned";
                return (
                  <AssignmentDetailPopover
                    key={event.id}
                    rows={[event.row]}
                    rooms={rooms}
                    roomName={event.roomName}
                    onUpdateOverride={onUpdateOverride}
                    trigger={(props) => (
                      <button
                        type="button"
                        {...props}
                        className={`absolute overflow-hidden rounded-md border-l-4 p-2 text-left text-xs shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                          review
                            ? "border-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"
                            : "border-primary bg-primary/10 text-foreground"
                        }`}
                        style={{
                          top: eventTop(bounds, event.startMinute) + 2,
                          left: cardLeft,
                          width: Math.max(laneWidth - 4, 56),
                          height: eventHeight(event.row),
                        }}
                      >
                        <div className="flex items-center gap-1">
                          {event.hasRoomConflict && <AlertTriangle className="size-3 shrink-0 text-conflict" />}
                          <span className="truncate font-semibold">{event.row.tutorDisplayName}</span>
                        </div>
                        <div className="mt-0.5 truncate text-muted-foreground">
                          {event.row.studentName || event.row.title || "Untitled"}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {event.row.overrideRoom && (
                            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                              override
                            </Badge>
                          )}
                          <span className="truncate font-mono text-[10px] text-muted-foreground">
                            {minuteToTimeLabel(event.startMinute)}-{minuteToTimeLabel(event.endMinute)}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                          {[classLabel(event.row), event.row.sessionType].filter(Boolean).join(" - ")}
                        </div>
                      </button>
                    )}
                  >
                    {event.isReview ? "Review lane" : event.hasRoomConflict ? "Overlapping room events" : ""}
                  </AssignmentDetailPopover>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import type { ReactElement, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { minuteToTimeLabel } from "@/lib/classrooms/visualization";
import type { ClassroomRoom, ClassroomRow } from "./types";

interface AssignmentDetailPopoverProps {
  rows: ClassroomRow[];
  rooms: ClassroomRoom[];
  roomName: string;
  trigger: (props: Record<string, unknown>) => ReactElement;
  onUpdateOverride: (row: ClassroomRow, overrideRoom: string) => void;
  children?: ReactNode;
}

function classLabel(row: ClassroomRow): string {
  return row.subject || row.classType || row.title || "";
}

function statusVariant(row: ClassroomRow): "default" | "secondary" | "destructive" | "outline" {
  if (row.status === "no_room") return "destructive";
  if (row.status === "needs_review" || row.warnings.length > 0) return "secondary";
  if (row.publishStatus === "success") return "default";
  return "outline";
}

export function AssignmentDetailPopover({
  rows,
  rooms,
  roomName,
  trigger,
  onUpdateOverride,
  children,
}: AssignmentDetailPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger render={(props) => trigger(props as Record<string, unknown>)} />
      <PopoverContent side="top" className="max-h-[420px] w-80 overflow-auto p-3">
        <div className="space-y-3">
          <div>
            <div className="text-sm font-semibold">{roomName}</div>
            {children && <div className="mt-1 text-xs text-muted-foreground">{children}</div>}
          </div>

          {rows.length === 0 ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              No active session at this time.
            </div>
          ) : (
            rows.map((row) => (
              <div key={row.id} className="rounded-md border p-2 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{row.tutorDisplayName}</div>
                    <div className="mt-0.5 text-muted-foreground">
                      {minuteToTimeLabel(row.startMinute)}-{minuteToTimeLabel(row.endMinute)}
                    </div>
                  </div>
                  <Badge variant={statusVariant(row)} className="shrink-0">
                    {row.status === "assigned" && row.warnings.length === 0 ? "Assigned" : "Review"}
                  </Badge>
                </div>

                <div className="mt-2 space-y-1 text-muted-foreground">
                  <div>{row.studentName || row.title || "Untitled class"}</div>
                  <div>{[classLabel(row), row.sessionType].filter(Boolean).join(" - ") || "No class details"}</div>
                  <div>
                    Load {row.studentCount ?? row.minCapacity}
                    {row.needsTv ? " - TV needed" : ""}
                    {row.overrideRoom ? ` - Override: ${row.overrideRoom}` : ""}
                  </div>
                  {row.warnings.length > 0 && (
                    <div className="text-amber-700 dark:text-amber-300">
                      {row.warnings.join(", ")}
                    </div>
                  )}
                </div>

                <label className="mt-2 grid gap-1 text-xs font-medium text-muted-foreground">
                  Override room
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                    value={row.overrideRoom ?? ""}
                    onChange={(event) => onUpdateOverride(row, event.target.value)}
                  >
                    <option value="">No override</option>
                    {rooms.filter((room) => room.active).map((room) => (
                      <option key={room.id} value={room.name}>
                        {room.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

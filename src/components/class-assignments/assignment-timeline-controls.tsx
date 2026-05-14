"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TimelineBounds } from "@/lib/classrooms/visualization";
import { minuteToTimeLabel } from "@/lib/classrooms/visualization";

interface AssignmentTimelineControlsProps {
  bounds: TimelineBounds;
  currentMinute: number;
  playing: boolean;
  speed: number;
  disabled: boolean;
  onMinuteChange: (minute: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onReset: () => void;
  onSpeedChange: (speed: number) => void;
}

const SPEEDS = [5, 15, 30];

export function AssignmentTimelineControls({
  bounds,
  currentMinute,
  playing,
  speed,
  disabled,
  onMinuteChange,
  onPlayingChange,
  onReset,
  onSpeedChange,
}: AssignmentTimelineControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          onClick={() => onPlayingChange(!playing)}
          disabled={disabled}
          aria-label={playing ? "Pause schedule playback" : "Play schedule playback"}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? "Pause" : "Play"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onReset}
          disabled={disabled}
          aria-label="Reset schedule playback"
        >
          <RotateCcw />
          Reset
        </Button>
      </div>

      <div className="min-w-[74px] font-mono text-sm font-semibold tabular-nums">
        {minuteToTimeLabel(currentMinute)}
      </div>

      <label className="flex min-w-[240px] flex-1 items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">{minuteToTimeLabel(bounds.startMinute)}</span>
        <input
          type="range"
          min={bounds.startMinute}
          max={bounds.endMinute}
          step={5}
          value={currentMinute}
          disabled={disabled}
          onChange={(event) => onMinuteChange(Number(event.target.value))}
          aria-label="Schedule playback time"
          className="h-2 min-w-0 flex-1 accent-primary"
        />
        <span className="font-mono tabular-nums">{minuteToTimeLabel(bounds.endMinute)}</span>
      </label>

      <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        Speed
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
          value={speed}
          disabled={disabled}
          onChange={(event) => onSpeedChange(Number(event.target.value))}
          aria-label="Playback speed"
        >
          {SPEEDS.map((value) => (
            <option key={value} value={value}>
              {value}m/s
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { v4 as uuidv4 } from "uuid";
import type { SearchSlot, SearchMode } from "@/lib/search/types";

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

// Generate time options in 15-minute increments
function generateTimeOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const ampm = h < 12 ? "AM" : "PM";
      const label = `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
      options.push({ value, label });
    }
  }
  return options;
}

const TIME_OPTIONS = generateTimeOptions();

interface SlotBuilderProps {
  searchMode: SearchMode;
  onAdd: (slot: SearchSlot) => void;
}

export function SlotBuilder({ searchMode, onAdd }: SlotBuilderProps) {
  const [dayOfWeek, setDayOfWeek] = useState<number>(1);
  const [date, setDate] = useState<string>("");
  const [startTime, setStartTime] = useState<string>("09:00");
  const [endTime, setEndTime] = useState<string>("10:00");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    setError(null);

    if (searchMode === "one_time" && !date) {
      setError("Please select a date");
      return;
    }

    if (startTime >= endTime) {
      setError("End time must be after start time");
      return;
    }

    const slot: SearchSlot = {
      id: uuidv4(),
      start: startTime,
      end: endTime,
      mode: "either", // overridden by page-level mode filter
    };

    if (searchMode === "recurring") {
      slot.dayOfWeek = dayOfWeek;
    } else {
      slot.date = date;
      slot.dayOfWeek = new Date(date + "T00:00:00").getDay();
    }

    onAdd(slot);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        {searchMode === "recurring" ? (
          <div className="flex-1">
            <label className="text-xs font-medium text-muted-foreground">Day</label>
            <select
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={dayOfWeek}
              onChange={(e) => setDayOfWeek(Number(e.target.value))}
            >
              {WEEKDAYS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="flex-1">
            <label className="text-xs font-medium text-muted-foreground">Date</label>
            <input
              type="date"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={new Date().toISOString().slice(0, 10)}
            />
          </div>
        )}

        <div className="flex-1">
          <label className="text-xs font-medium text-muted-foreground">Start Time</label>
          <select
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          >
            {TIME_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1">
          <label className="text-xs font-medium text-muted-foreground">End Time</label>
          <select
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
          >
            {TIME_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <Button onClick={handleAdd} size="sm">
          Add Slot
        </Button>
      </div>

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}

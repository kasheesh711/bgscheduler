"use client";

import type { CompareTutor, Conflict, SharedFreeSlot } from "@/lib/search/types";
import type { TutorChip } from "./tutor-selector";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun

function minuteToLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

interface WeekOverviewProps {
  tutors: CompareTutor[];
  tutorChips: TutorChip[];
  conflicts: Conflict[];
  onDayClick: (day: number) => void;
}

export function WeekOverview({ tutors, tutorChips, conflicts, onDayClick }: WeekOverviewProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="w-[120px] px-3 py-2 text-left font-medium">Tutor</th>
            {DISPLAY_DAYS.map((day) => {
              const dayConflicts = conflicts.filter((c) => c.dayOfWeek === day);
              return (
                <th
                  key={day}
                  className="min-w-[100px] px-2 py-2 text-center font-medium text-xs cursor-pointer hover:bg-muted/80 transition-colors"
                  onClick={() => onDayClick(day)}
                >
                  {DAY_NAMES[day]}
                  {dayConflicts.length > 0 && (
                    <span className="ml-1 text-red-400">⚠</span>
                  )}
                  <span className="block text-[10px] text-muted-foreground font-normal">click to expand</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {tutors.map((t, idx) => {
            const chip = tutorChips[idx];
            return (
              <tr key={t.tutorGroupId} className="border-b">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full" style={{ background: chip?.color }} />
                    <span className="font-medium text-xs">{t.displayName}</span>
                  </div>
                </td>
                {DISPLAY_DAYS.map((day) => {
                  const daySessions = t.sessions.filter((s) => s.weekday === day);
                  const dayConflicts = conflicts.filter(
                    (c) =>
                      c.dayOfWeek === day &&
                      (c.tutorA.tutorGroupId === t.tutorGroupId ||
                        c.tutorB.tutorGroupId === t.tutorGroupId),
                  );

                  return (
                    <td
                      key={day}
                      className="px-2 py-1.5 align-top cursor-pointer hover:bg-muted/30"
                      onClick={() => onDayClick(day)}
                    >
                      {daySessions.length === 0 ? (
                        <span className="text-[10px] text-muted-foreground/30">—</span>
                      ) : (
                        <div className="space-y-0.5">
                          {daySessions.slice(0, 3).map((s, si) => {
                            const isConflict = dayConflicts.some(
                              (c) =>
                                s.studentName &&
                                c.studentName.toLowerCase() === s.studentName?.toLowerCase() &&
                                s.startMinute < c.endMinute &&
                                s.endMinute > c.startMinute,
                            );
                            return (
                              <div
                                key={si}
                                className="text-[10px] px-1 py-0.5 rounded truncate"
                                style={{
                                  background: isConflict ? "rgba(239, 68, 68, 0.15)" : `${chip?.color}15`,
                                  borderLeft: `2px solid ${isConflict ? "#ef4444" : chip?.color}`,
                                  color: isConflict ? "#fca5a5" : undefined,
                                }}
                              >
                                {minuteToLabel(s.startMinute)} {s.subject ?? ""}
                              </div>
                            );
                          })}
                          {daySessions.length > 3 && (
                            <div className="text-[9px] text-muted-foreground">
                              +{daySessions.length - 3} more
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

"use client";

// ----------------------------------------------------------------------------
// Admin workspace for the student monthly schedule.
//
// Flow: search a student by nickname code (Aadhu.Sr) or name → page through
// months → print a PDF or copy a parent link. The student directory is the
// existing GET /api/line/students endpoint, so code ranking (exact code >
// student key > nickname > substring) is shared with the LINE tooling rather
// than reimplemented here.
//
// Sending to a parent over LINE is deliberately NOT a button on this page: that
// path runs through the bot's confirm gate so a wrong student cannot be pushed
// with one click. Admins copy the link and paste it, or use the bot.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PrinterIcon, LinkIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScheduleMonthCalendar } from "@/components/student-schedule/schedule-month-calendar";
import { addMonths, formatMonthLabel, getMonthKey } from "@/lib/calendar/month-grid";
import { todayBangkok } from "@/lib/room-capacity/dates";
import type { StudentSchedulePayload } from "@/lib/student-schedule/types";

interface StudentOption {
  studentKey: string;
  studentName: string;
  parentName: string;
}

function readStudents(payload: unknown): StudentOption[] {
  if (typeof payload !== "object" || payload === null) return [];
  const rows = (payload as { students?: unknown }).students;
  if (!Array.isArray(rows)) return [];
  const options: StudentOption[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.studentKey !== "string" || typeof record.studentName !== "string") continue;
    options.push({
      studentKey: record.studentKey,
      studentName: record.studentName,
      parentName: typeof record.parentName === "string" ? record.parentName : "",
    });
  }
  return options;
}

export function StudentScheduleWorkspace() {
  const todayKey = useMemo(() => todayBangkok(), []);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<StudentOption[]>([]);
  const [selected, setSelected] = useState<StudentOption | null>(null);
  const [monthKey, setMonthKey] = useState(() => getMonthKey(todayBangkok()));
  const [payload, setPayload] = useState<StudentSchedulePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const scheduleAbort = useRef<AbortController | null>(null);

  // Debounced student search against the shared LINE student directory.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setOptions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/line/students?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("search failed"))))
        .then((data) => setOptions(readStudents(data)))
        .catch((cause) => {
          if ((cause as Error).name !== "AbortError") setOptions([]);
        });
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  // Load the selected student's month.
  useEffect(() => {
    if (!selected) {
      setPayload(null);
      return;
    }
    scheduleAbort.current?.abort();
    const controller = new AbortController();
    scheduleAbort.current = controller;
    setLoading(true);
    setError(null);

    fetch(
      `/api/student-schedule?studentKey=${encodeURIComponent(selected.studentKey)}&month=${monthKey}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof data.error === "string" ? data.error : "Failed to load schedule");
        }
        return data as StudentSchedulePayload;
      })
      .then(setPayload)
      .catch((cause) => {
        if ((cause as Error).name === "AbortError") return;
        setError((cause as Error).message);
        setPayload(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [selected, monthKey]);

  const openPrintView = useCallback(() => {
    if (!selected) return;
    window.open(
      `/student-schedule/report?studentKey=${encodeURIComponent(selected.studentKey)}&month=${monthKey}`,
      "_blank",
      "noopener",
    );
  }, [selected, monthKey]);

  const copyParentLink = useCallback(async () => {
    if (!selected) return;
    setLinkNotice(null);
    try {
      const response = await fetch("/api/student-schedule/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentKey: selected.studentKey, month: monthKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Failed to create link");
      }
      await navigator.clipboard.writeText(data.url);
      setLinkNotice(`Link copied — expires ${new Date(data.expiresAt).toLocaleDateString("en-GB")}`);
    } catch (cause) {
      setLinkNotice((cause as Error).message);
    }
  }, [selected, monthKey]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Student Schedule</h1>
        <p className="text-sm text-muted-foreground">
          Look up a student&apos;s month, print it as a PDF, or copy a link to send a parent.
        </p>
      </header>

      {/* ── Student picker ────────────────────────────────────────── */}
      <div className="relative max-w-md">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(null);
          }}
          placeholder="Search by code (Aadhu.Sr) or name…"
          className="pl-8"
          aria-label="Search students"
        />
        {options.length > 0 && !selected && (
          <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
            {options.map((option) => (
              <li key={option.studentKey}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setSelected(option);
                    setQuery(option.studentName);
                    setOptions([]);
                  }}
                >
                  <span className="font-medium">{option.studentName}</span>
                  {option.parentName && (
                    <span className="ml-2 text-xs text-muted-foreground">{option.parentName}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <>
          {/* ── Month navigation + actions ──────────────────────────── */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setMonthKey((current) => addMonths(current, -1))}
                aria-label="Previous month"
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
              <span className="min-w-40 text-center text-sm font-semibold">
                {formatMonthLabel(monthKey)}
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setMonthKey((current) => addMonths(current, 1))}
                aria-label="Next month"
              >
                <ChevronRightIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMonthKey(getMonthKey(todayBangkok()))}
              >
                This month
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={copyParentLink}>
                <LinkIcon className="mr-1.5 size-4" />
                Copy parent link
              </Button>
              <Button size="sm" onClick={openPrintView}>
                <PrinterIcon className="mr-1.5 size-4" />
                Print / Save PDF
              </Button>
            </div>
          </div>

          {linkNotice && (
            <p className="text-xs text-muted-foreground" role="status">{linkNotice}</p>
          )}

          {/* ── Calendar ────────────────────────────────────────────── */}
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {loading && !payload && (
            <div className="h-96 animate-pulse rounded-md bg-muted/50" />
          )}
          {payload && (
            <div className={cn(loading && "opacity-60 transition-opacity")}>
              <ScheduleMonthCalendar payload={payload} todayKey={todayKey} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

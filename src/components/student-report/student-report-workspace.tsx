"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DownloadIcon,
  FileTextIcon,
  PrinterIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";

import { ReportDocument } from "@/components/student-report/report-document";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addBangkokDays, todayBangkok } from "@/lib/room-capacity/dates";
import {
  CLASSES_CSV_COLUMNS,
  CREDITS_CSV_COLUMNS,
  flattenClassesForCsv,
  flattenCreditsForCsv,
  flattenSummaryForCsv,
  reportCsvFilename,
  SUMMARY_CSV_COLUMNS,
} from "@/lib/student-report/csv";
import {
  buildReportSearch,
  REPORT_MAX_STUDENTS,
} from "@/lib/student-report/params";
import { downloadCsv } from "@/lib/sales-dashboard/csv";

import type { ParentReportPayload } from "@/lib/student-report/types";

interface StudentOption {
  studentKey: string;
  studentName: string;
  parentName: string;
}

interface ReportRange {
  from: string;
  to: string;
}

interface LoadedReportRequest extends ReportRange {
  studentKeys: string[];
  includeFeedback: boolean;
}

const DATE_PRESETS = [
  { id: "this-month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "last-30-days", label: "Last 30 days" },
  { id: "last-90-days", label: "Last 90 days" },
] as const;

type DatePreset = (typeof DATE_PRESETS)[number]["id"];

function readStudents(payload: unknown): StudentOption[] {
  if (typeof payload !== "object" || payload === null) return [];
  const rows = (payload as { students?: unknown }).students;
  if (!Array.isArray(rows)) return [];

  const options: StudentOption[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    if (
      typeof record.studentKey !== "string" ||
      typeof record.studentName !== "string"
    ) {
      continue;
    }
    options.push({
      studentKey: record.studentKey,
      studentName: record.studentName,
      parentName:
        typeof record.parentName === "string" ? record.parentName : "",
    });
  }
  return options;
}

function rangeForPreset(preset: DatePreset): ReportRange {
  const today = todayBangkok();
  if (preset === "this-month") {
    return { from: `${today.slice(0, 7)}-01`, to: today };
  }
  if (preset === "last-month") {
    const previousMonthEnd = addBangkokDays(`${today.slice(0, 7)}-01`, -1);
    return {
      from: `${previousMonthEnd.slice(0, 7)}-01`,
      to: previousMonthEnd,
    };
  }
  if (preset === "last-30-days") {
    return { from: addBangkokDays(today, -30), to: today };
  }
  return { from: addBangkokDays(today, -90), to: today };
}

function reportRequestMatches(
  request: LoadedReportRequest,
  selected: readonly StudentOption[],
  range: ReportRange,
  includeFeedback: boolean,
): boolean {
  return (
    request.from === range.from &&
    request.to === range.to &&
    request.includeFeedback === includeFeedback &&
    request.studentKeys.length === selected.length &&
    request.studentKeys.every(
      (studentKey, index) => studentKey === selected[index]?.studentKey,
    )
  );
}

export function StudentReportWorkspace() {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<StudentOption[]>([]);
  const [selected, setSelected] = useState<StudentOption[]>([]);
  const [siblingOptions, setSiblingOptions] = useState<StudentOption[]>([]);
  const [range, setRange] = useState<ReportRange>(() =>
    rangeForPreset("this-month"),
  );
  const [activePreset, setActivePreset] = useState<DatePreset | null>(
    "this-month",
  );
  const [includeFeedback, setIncludeFeedback] = useState(true);
  const [payload, setPayload] = useState<ParentReportPayload | null>(null);
  const [loadedRequest, setLoadedRequest] =
    useState<LoadedReportRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const selectedRef = useRef<StudentOption[]>([]);
  const siblingAbort = useRef<AbortController | null>(null);
  const reportAbort = useRef<AbortController | null>(null);

  // Debounced student search against the shared LINE student directory.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setOptions([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/line/students?q=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
      })
        .then((response) =>
          response.ok
            ? response.json()
            : Promise.reject(new Error("search failed")),
        )
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

  useEffect(() => {
    return () => {
      siblingAbort.current?.abort();
      reportAbort.current?.abort();
    };
  }, []);

  const loadSiblingSuggestions = useCallback((student: StudentOption) => {
    siblingAbort.current?.abort();
    setSiblingOptions([]);

    if (
      selectedRef.current.length >= REPORT_MAX_STUDENTS ||
      student.parentName.trim().length < 2
    ) {
      return;
    }

    const controller = new AbortController();
    siblingAbort.current = controller;
    fetch(
      `/api/line/students?q=${encodeURIComponent(student.parentName)}`,
      { signal: controller.signal },
    )
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("sibling search failed")),
      )
      .then((data) => {
        if (siblingAbort.current !== controller) return;
        const selectedKeys = new Set(
          selectedRef.current.map((option) => option.studentKey),
        );
        const seen = new Set<string>();
        setSiblingOptions(
          readStudents(data).filter((option) => {
            if (
              option.parentName !== student.parentName ||
              selectedKeys.has(option.studentKey) ||
              seen.has(option.studentKey)
            ) {
              return false;
            }
            seen.add(option.studentKey);
            return true;
          }),
        );
      })
      .catch((cause) => {
        if ((cause as Error).name === "AbortError") return;
        console.error("student-report sibling search failed", cause);
        if (siblingAbort.current === controller) setSiblingOptions([]);
      });
  }, []);

  const addStudent = useCallback(
    (student: StudentOption) => {
      if (
        selectedRef.current.length >= REPORT_MAX_STUDENTS ||
        selectedRef.current.some(
          (option) => option.studentKey === student.studentKey,
        )
      ) {
        return;
      }

      const nextSelected = [...selectedRef.current, student];
      selectedRef.current = nextSelected;
      setSelected(nextSelected);
      setQuery("");
      setOptions([]);

      if (nextSelected.length < REPORT_MAX_STUDENTS) {
        loadSiblingSuggestions(student);
      } else {
        siblingAbort.current?.abort();
        setSiblingOptions([]);
      }
    },
    [loadSiblingSuggestions],
  );

  const removeStudent = useCallback((studentKey: string) => {
    const nextSelected = selectedRef.current.filter(
      (student) => student.studentKey !== studentKey,
    );
    selectedRef.current = nextSelected;
    setSelected(nextSelected);
  }, []);

  const applyPreset = useCallback((preset: DatePreset) => {
    setRange(rangeForPreset(preset));
    setActivePreset(preset);
  }, []);

  const generateReport = useCallback(async () => {
    if (
      selected.length === 0 ||
      !range.from ||
      !range.to ||
      range.from > range.to
    ) {
      return;
    }

    reportAbort.current?.abort();
    const controller = new AbortController();
    reportAbort.current = controller;
    const request: LoadedReportRequest = {
      studentKeys: selected.map((student) => student.studentKey),
      from: range.from,
      to: range.to,
      includeFeedback,
    };

    setLoading(true);
    setError(null);
    setMissing(null);

    try {
      const response = await fetch(
        `/api/student-report?${buildReportSearch(request)}`,
        { signal: controller.signal },
      );
      const data: unknown = await response.json().catch(() => ({}));
      const record =
        typeof data === "object" && data !== null
          ? (data as Record<string, unknown>)
          : {};

      if (response.status === 404) {
        setMissing(
          Array.isArray(record.missing)
            ? record.missing.filter(
                (studentKey): studentKey is string =>
                  typeof studentKey === "string",
              )
            : [],
        );
        return;
      }

      if (!response.ok) {
        throw new Error(
          typeof record.error === "string"
            ? record.error
            : "Failed to generate report",
        );
      }

      setPayload(data as ParentReportPayload);
      setLoadedRequest(request);
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return;
      setError(
        cause instanceof Error ? cause.message : "Failed to generate report",
      );
    } finally {
      if (
        !controller.signal.aborted &&
        reportAbort.current === controller
      ) {
        setLoading(false);
      }
    }
  }, [includeFeedback, range, selected]);

  const openPrintView = useCallback(() => {
    if (!loadedRequest) return;
    window.open(
      `/student-report/report?${buildReportSearch(loadedRequest)}`,
      "_blank",
      "noopener",
    );
  }, [loadedRequest]);

  const rangeError =
    !range.from || !range.to
      ? "Choose both a From and To date."
      : range.from > range.to
        ? "From must be on or before To."
        : null;
  const atStudentLimit = selected.length >= REPORT_MAX_STUDENTS;
  const previewIsStale = Boolean(
    payload &&
      loadedRequest &&
      !reportRequestMatches(loadedRequest, selected, range, includeFeedback),
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Parent Report</h1>
        <p className="text-sm text-muted-foreground">
          Create a class &amp; credit statement for one student or a family.
        </p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Report setup</CardTitle>
          <CardDescription>
            Choose up to {REPORT_MAX_STUDENTS} students and the statement date
            range.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
          <section className="min-w-0 space-y-3" aria-labelledby="report-students-heading">
            <div>
              <h2 id="report-students-heading" className="text-sm font-semibold">
                Students
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Search by nickname code, student name, or parent name.
              </p>
            </div>

            <div className="relative max-w-xl">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by code (Aadhu.Sr) or name…"
                className="pl-8"
                aria-label="Search students"
              />
              {options.length > 0 && (
                <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
                  {options.map((option) => {
                    const alreadySelected = selected.some(
                      (student) => student.studentKey === option.studentKey,
                    );
                    return (
                      <li key={option.studentKey}>
                        <button
                          type="button"
                          className="w-full px-3 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => addStudent(option)}
                          disabled={atStudentLimit || alreadySelected}
                        >
                          <span className="font-medium">
                            {option.studentName}
                          </span>
                          {option.parentName && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {option.parentName}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {selected.length > 0 && (
              <div
                className="flex flex-wrap gap-2"
                aria-label="Selected students"
              >
                {selected.map((student) => (
                  <div
                    key={student.studentKey}
                    className="flex h-8 items-center gap-1 rounded-full border bg-muted/40 pl-3 pr-1 text-sm"
                  >
                    <span>{student.studentName}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="rounded-full"
                      onClick={() => removeStudent(student.studentKey)}
                      aria-label={`Remove ${student.studentName}`}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {atStudentLimit && (
              <p className="text-xs text-muted-foreground" role="status">
                Maximum {REPORT_MAX_STUDENTS} students selected. Remove one to
                add another.
              </p>
            )}

            {siblingOptions.length > 0 && !atStudentLimit && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Possible siblings
                </p>
                <div className="flex flex-wrap gap-2">
                  {siblingOptions.map((student) => (
                    <Button
                      key={student.studentKey}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      onClick={() => addStudent(student)}
                    >
                      Add sibling: {student.studentName}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section
            className="space-y-3 lg:border-l lg:pl-6"
            aria-labelledby="report-range-heading"
          >
            <div>
              <h2 id="report-range-heading" className="text-sm font-semibold">
                Date range
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Dates use the Bangkok calendar.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {DATE_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  variant={activePreset === preset.id ? "secondary" : "outline"}
                  size="sm"
                  className="rounded-full"
                  onClick={() => applyPreset(preset.id)}
                  aria-pressed={activePreset === preset.id}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="student-report-from">From</Label>
                <Input
                  id="student-report-from"
                  type="date"
                  value={range.from}
                  onChange={(event) => {
                    setRange((current) => ({
                      ...current,
                      from: event.target.value,
                    }));
                    setActivePreset(null);
                  }}
                  aria-invalid={Boolean(rangeError)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="student-report-to">To</Label>
                <Input
                  id="student-report-to"
                  type="date"
                  value={range.to}
                  onChange={(event) => {
                    setRange((current) => ({
                      ...current,
                      to: event.target.value,
                    }));
                    setActivePreset(null);
                  }}
                  aria-invalid={Boolean(rangeError)}
                />
              </div>
            </div>

            {rangeError && (
              <p className="text-xs text-destructive" role="alert">
                {rangeError}
              </p>
            )}

            <div className="space-y-1 pt-1">
              <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                <Checkbox
                  checked={includeFeedback}
                  onCheckedChange={() =>
                    setIncludeFeedback((current) => !current)
                  }
                />
                <span>Include tutor feedback</span>
              </label>
              <p className="pl-6 text-xs text-muted-foreground">
                Per-class notes from the tutor appear under each class row.
              </p>
            </div>
          </section>
        </CardContent>

        <CardFooter className="justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {selected.length} of {REPORT_MAX_STUDENTS} students selected
          </p>
          <Button
            type="button"
            onClick={generateReport}
            disabled={
              selected.length === 0 || Boolean(rangeError) || loading
            }
          >
            <FileTextIcon className="size-4" />
            {loading ? "Generating…" : "Generate"}
          </Button>
        </CardFooter>
      </Card>

      {missing !== null && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          <p>Some selected students were not found:</p>
          <ul className="mt-1 list-disc pl-5">
            {missing.map((studentKey, index) => (
              <li key={`${studentKey}-${index}`}>{studentKey}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}

      {loading && !payload && (
        <div
          className="h-96 animate-pulse rounded-md bg-muted/50"
          aria-label="Generating report preview"
          role="status"
        />
      )}

      {payload && (
        <section className="space-y-3" aria-labelledby="report-preview-heading">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
            <div>
              <h2 id="report-preview-heading" className="text-sm font-semibold">
                Report preview
              </h2>
              {loadedRequest && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {loadedRequest.from} to {loadedRequest.to}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadCsv(
                    reportCsvFilename(payload, "classes"),
                    flattenClassesForCsv(payload),
                    CLASSES_CSV_COLUMNS,
                  )
                }
              >
                <DownloadIcon className="size-4" />
                Classes CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadCsv(
                    reportCsvFilename(payload, "summary"),
                    flattenSummaryForCsv(payload),
                    SUMMARY_CSV_COLUMNS,
                  )
                }
              >
                <DownloadIcon className="size-4" />
                Summary CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadCsv(
                    reportCsvFilename(payload, "credits"),
                    flattenCreditsForCsv(payload),
                    CREDITS_CSV_COLUMNS,
                  )
                }
              >
                <DownloadIcon className="size-4" />
                Credits CSV
              </Button>
              <Button type="button" size="sm" onClick={openPrintView}>
                <PrinterIcon className="size-4" />
                Open print view
              </Button>
            </div>
          </div>

          {previewIsStale && (
            <p
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
              role="status"
            >
              Selection changed — regenerate to refresh.
            </p>
          )}

          <div className="begifted rounded-md border border-begifted-neutral-200 bg-white p-6">
            <ReportDocument payload={payload} />
          </div>
        </section>
      )}
    </div>
  );
}

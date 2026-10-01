"use client";
import { useState } from "react";
import type {
  WorkforceQuery,
  WorkforceSubjectRow,
} from "@/lib/tutor-offboarding/workforce/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changeFilter, monthLabel } from "./presentation";
export function WorkforceFilters({
  query,
  subjects,
  busy = false,
  onChange,
  growthScope = false,
}: {
  query: WorkforceQuery;
  subjects: WorkforceSubjectRow[];
  busy?: boolean;
  growthScope?: boolean;
  onChange: (query: WorkforceQuery) => void;
}) {
  const [draft, setDraft] = useState(query);
  const [error, setError] = useState<string | null>(null);
  const change = (key: keyof WorkforceQuery, value: string) =>
    setDraft((current) => changeFilter(current, key, value));
  const options = (key: "subject" | "curriculum" | "level") =>
    [
      ...new Set(
        subjects
          .filter(
            (row) =>
              (key === "subject" ||
                !draft.subject ||
                row.subject === draft.subject) &&
              (key !== "level" ||
                !draft.curriculum ||
                row.curriculum === draft.curriculum),
          )
          .map((row) => row[key])
          .filter((value): value is string => !!value),
      ),
    ].sort();
  const months: string[] = [];
  for (
    let current = draft.from.slice(0, 7), limit = 0;
    current <= draft.to.slice(0, 7) && limit < 120;
    limit++
  ) {
    months.push(current);
    const d = new Date(`${current}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    current = d.toISOString().slice(0, 7);
  }
  const selectClass =
    "h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-primary";
  return (
    <form
      aria-label="Workforce filters"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !draft.from ||
          !draft.to ||
          draft.from < "2026-03-01" ||
          draft.from > draft.to
        ) {
          setError(
            "Choose a valid date range starting on or after 1 March 2026.",
          );
          return;
        }
        setError(null);
        onChange(draft);
      }}
      className="space-y-3 rounded-[10px] border bg-card p-4"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <label className="text-xs text-muted-foreground">
          From
          <Input
            type="date"
            min="2026-03-01"
            value={draft.from}
            onChange={(e) => change("from", e.target.value)}
            className="mt-1"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          To
          <Input
            type="date"
            min={draft.from}
            value={draft.to}
            onChange={(e) => change("to", e.target.value)}
            className="mt-1"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Selected month
          <select
            className={`${selectClass} mt-1`}
            value={draft.viewMonth}
            onChange={(e) => change("viewMonth", e.target.value)}
          >
            {months.map((month) => (
              <option key={month} value={month}>
                {monthLabel(month)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Role
          <select
            className={`${selectClass} mt-1`}
            disabled={growthScope}
            value={growthScope ? "all" : draft.role}
            onChange={(e) => change("role", e.target.value)}
          >
            <option value="all">Tutors + teaching admins</option>
            <option value="tutor">Tutors</option>
            <option value="teaching_admin">Teaching admins</option>
          </select>
        </label>
        {(["subject", "curriculum", "level"] as const).map((key) => (
          <label className="text-xs capitalize text-muted-foreground" key={key}>
            {key}
            <select
              className={`${selectClass} mt-1`}
              value={draft[key] ?? ""}
              onChange={(e) => change(key, e.target.value)}
            >
              <option value="">
                All{" "}
                {key === "level"
                  ? "levels"
                  : key === "subject"
                    ? "subjects"
                    : "curricula"}
              </option>
              {options(key).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        ))}
        <label className="text-xs text-muted-foreground">
          Mode
          <select
            className={`${selectClass} mt-1`}
            disabled={growthScope}
            value={growthScope ? "all" : draft.modality}
            onChange={(e) => change("modality", e.target.value)}
          >
            <option value="all">All modes</option>
            <option value="online">Online</option>
            <option value="onsite">Onsite</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Bangkok dates · Historical capacity appears only where it was
          retained.
        </p>
        <Button size="sm" disabled={busy} type="submit">
          {busy ? "Loading selected evidence…" : "Apply filters"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-conflict">
          {error}
        </p>
      ) : null}
    </form>
  );
}

"use client";
import { useState } from "react";
import type { WorkforcePersonRow } from "@/lib/tutor-offboarding/workforce/types";
import { Panel, Tag } from "../atoms";
import { Input } from "@/components/ui/input";
import {
  formatMetric,
  metricReason,
  RATE_LABELS,
  rateFormula,
  type DisplayMetric,
} from "./presentation";
export function sortPeople(
  people: WorkforcePersonRow[],
  key: DisplayMetric,
  direction: "asc" | "desc",
) {
  return [...people].sort((a, b) => {
    const av = a[key].value,
      bv = b[key].value;
    if (av === null)
      return bv === null ? a.displayName.localeCompare(b.displayName) : 1;
    if (bv === null) return -1;
    return (
      (av - bv) * (direction === "asc" ? 1 : -1) ||
      a.displayName.localeCompare(b.displayName)
    );
  });
}
export function UtilizationTable({
  people,
  onSelect,
}: {
  people: WorkforcePersonRow[];
  onSelect: (person: WorkforcePersonRow) => void;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<DisplayMetric>("consumedUtilizationPercent");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const filtered = sortPeople(
    people.filter((person) =>
      person.displayName.toLowerCase().includes(search.toLowerCase()),
    ),
    sort,
    direction,
  );
  const columns: DisplayMetric[] = [
    "offeredHours",
    "leaveHours",
    "usableHours",
    "bookedHours",
    "creditConsumedHours",
    "recordedTeachingHours",
    "reservedUtilizationPercent",
    "consumedUtilizationPercent",
    "recordedTeachingUtilizationPercent",
  ];
  const labels: Record<string, string> = {
    offeredHours: "Gross offered hours",
    leaveHours: "Approved leave",
    usableHours: "Usable hours",
    bookedHours: "Booked tutor-hours",
    creditConsumedHours: "Credit-consumed hours",
    recordedTeachingHours: "Recorded teaching hours",
    ...RATE_LABELS,
  };
  return (
    <Panel aria-label="Individual utilization">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h3 className="font-semibold">3. Individual utilization</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Selected range · All three rates use usable hours after approved
            leave, with numerators limited to the same supported dates. Rates
            over 100% remain visible.
          </p>
        </div>
        <Input
          aria-label="Search tutor or teaching administrator"
          placeholder="Find a person…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-64"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">
            Tutor and teaching administrator hours and utilization for the
            selected range
          </caption>
          <thead className="bg-muted/30">
            <tr>
              <th scope="col" className="min-w-44 px-4 py-3">
                Person
              </th>
              {columns.map((key) => (
                <th
                  key={key}
                  scope="col"
                  className="min-w-28 px-3 py-3"
                  aria-sort={
                    sort === key
                      ? direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    className="rounded text-left focus-visible:outline-2 focus-visible:outline-primary"
                    onClick={() => {
                      setSort(key);
                      setDirection(
                        sort === key && direction === "desc" ? "asc" : "desc",
                      );
                    }}
                  >
                    {labels[key]}{" "}
                    {sort === key ? (direction === "desc" ? "↓" : "↑") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((person) => (
              <tr className="border-t align-top" key={person.canonicalKey}>
                <th scope="row" className="px-4 py-3">
                  <button
                    onClick={() => onSelect(person)}
                    className="rounded text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {person.displayName}
                  </button>
                  <p className="mt-1 font-normal text-muted-foreground">
                    {person.role === "teaching_admin"
                      ? "Teaching admin"
                      : person.role === "tutor"
                        ? "Tutor"
                        : "Role unavailable"}
                  </p>
                  {person.pendingDeparture ? (
                    <Tag tone="amber" className="mt-2">
                      Pending departure
                    </Tag>
                  ) : null}
                  {(person.outsideHours.value ?? 0) > 0 ||
                  (person.overlapHours.value ?? 0) > 0 ? (
                    <p className="mt-2 font-normal text-amber-700 dark:text-amber-300">
                      Outside hours: {formatMetric(person.outsideHours, "h")} ·
                      Overlap: {formatMetric(person.overlapHours, "h")}
                    </p>
                  ) : null}
                </th>
                {columns.map((key) => (
                  <td
                    key={key}
                    className={`px-3 py-3 ${(person[key].value ?? 0) > 100 && key.endsWith("Percent") ? "font-semibold text-amber-700 dark:text-amber-300" : ""}`}
                    title={
                      key in RATE_LABELS
                        ? rateFormula(person, key as keyof typeof RATE_LABELS)
                        : metricReason(person[key])
                    }
                  >
                    {formatMetric(
                      person[key],
                      key.endsWith("Percent") ? "%" : "h",
                    )}
                    {person[key].completeness === "partial" ? (
                      <span className="mt-1 block text-[10px] text-muted-foreground">
                        Partial support
                      </span>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">
          No people match this selection.
        </p>
      ) : null}
    </Panel>
  );
}

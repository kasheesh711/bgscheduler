"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AutoPairLanguage, PairLanguage, PairLanguages as PairLanguagesPayload } from "@/lib/feedback-autowriter/pair-languages";
import { cn } from "@/lib/utils";
import { CountChip, Disclosure, Tag, type Tone } from "./atoms";
import { percent, threshold } from "./format";

const HEAD = "h-auto bg-muted/40 px-3 py-2.5 text-[10px] font-medium text-muted-foreground first:pl-5 last:pr-5";
const CELL = "px-3 py-2.5 text-[11px] first:pl-5 last:pr-5";
const NUMBER = cn(CELL, "text-right tabular-nums");
const NUMBER_HEAD = cn(HEAD, "text-right");

const LABEL: Record<AutoPairLanguage, string> = { english: "English", bilingual: "Bilingual", thai: "Thai", unknown: "Unknown" };
const TONE: Record<AutoPairLanguage, Tone> = { english: "blue", bilingual: "amber", thai: "green", unknown: "neutral" };
const FILTERS: readonly (AutoPairLanguage | "all")[] = ["all", "english", "bilingual", "thai", "unknown"];

type PairKey = { wiseClassId: string; tutorKey: string };

async function getJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const json = await response.json();
  // A 400 carries Zod's flattened issues, not a message.
  if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : "The server could not complete this request.");
  return json as T;
}

/** The class-languages table: filter chips by effective label, one row per (class, tutor) pair, the owner's override select. */
export function PairLanguagesTable({ data, canControl, filter, onFilter, busy, onOverride }: {
  data: PairLanguagesPayload;
  canControl: boolean;
  filter: AutoPairLanguage | "all";
  onFilter: (filter: AutoPairLanguage | "all") => void;
  busy: boolean;
  onOverride: (pair: PairKey, language: PairLanguage | null) => void;
}) {
  const counts = new Map<AutoPairLanguage | "all", number>([["all", data.pairs.length]]);
  for (const pair of data.pairs) counts.set(pair.effective, (counts.get(pair.effective) ?? 0) + 1);
  const rows = filter === "all" ? data.pairs : data.pairs.filter((pair) => pair.effective === filter);

  return (
    <div>
      <div className="space-y-2 px-5 py-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((key) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => onFilter(key)}
              className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]", filter === key && "bg-muted font-semibold")}>
              {key === "all" ? "All" : LABEL[key]}
              <CountChip>{counts.get(key) ?? 0}</CountChip>
            </button>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground">
          English: every transcript under {threshold(data.englishMaxThaiShare)} Thai · Thai: median ≥ {threshold(data.thaiMinMedianShare)} ·
          Bilingual: the rest · last {data.lookbackDays} days · shown only, routing does not read these yet
        </p>
        {canControl && !data.overridesAvailable ? (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">Overrides need migration 0116 — the labels shown are automatic.</p>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="border-t px-5 py-4 text-[11px] text-muted-foreground">No transcribed lessons in the last {data.lookbackDays} days.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD}>Tutor</TableHead>
              <TableHead className={HEAD}>Class</TableHead>
              <TableHead className={NUMBER_HEAD}>Lessons</TableHead>
              <TableHead className={NUMBER_HEAD}>Thai share (median / max)</TableHead>
              <TableHead className={HEAD}>Auto</TableHead>
              {canControl ? <TableHead className={HEAD}>Override</TableHead> : null}
              <TableHead className={HEAD}>Effective</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((pair) => {
              const name = pair.className ?? pair.wiseClassId;
              return (
                <TableRow key={`${pair.wiseClassId}:${pair.tutorKey}`}>
                  <TableCell className={CELL}>{pair.tutorKey}</TableCell>
                  <TableCell className={CELL}>{name}</TableCell>
                  <TableCell className={NUMBER}>
                    {pair.lessons}
                    {pair.zoomLessons > 0 ? <span className="text-muted-foreground"> · {pair.zoomLessons} Zoom</span> : null}
                  </TableCell>
                  <TableCell className={NUMBER}>{percent(pair.medianThaiShare, 0)} / {percent(pair.maxThaiShare, 0)}</TableCell>
                  <TableCell className={CELL}><Tag tone={TONE[pair.auto]}>{LABEL[pair.auto]}</Tag></TableCell>
                  {canControl ? (
                    <TableCell className={CELL}>
                      <select aria-label={`Language for ${name} with ${pair.tutorKey}`} value={pair.override ?? ""}
                        disabled={busy || !data.overridesAvailable}
                        onChange={(event) => onOverride(
                          { wiseClassId: pair.wiseClassId, tutorKey: pair.tutorKey },
                          event.target.value === "" ? null : event.target.value as PairLanguage,
                        )}
                        className="rounded border bg-background px-1.5 py-0.5 text-[11px] disabled:opacity-50">
                        <option value="">Auto</option>
                        <option value="english">English</option>
                        <option value="bilingual">Bilingual</option>
                        <option value="thai">Thai</option>
                      </select>
                    </TableCell>
                  ) : null}
                  <TableCell className={CELL}>
                    <Tag tone={TONE[pair.effective]}>{LABEL[pair.effective]}</Tag>
                    {pair.override !== null ? <span className="ml-1.5 text-[10px] text-muted-foreground">owner</span> : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** "Class languages": loads on first open, so a missing migration or a slow query cannot hold up the dashboard. */
export function PairLanguages({ canControl }: { canControl: boolean }) {
  const [data, setData] = useState<PairLanguagesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<AutoPairLanguage | "all">("all");

  async function load() {
    setBusy(true); setError(null);
    try { setData(await getJson<PairLanguagesPayload>("/api/feedback-autowriter/pair-languages")); }
    catch (e) { setError(e instanceof Error ? e.message : "The class languages could not load."); }
    finally { setBusy(false); }
  }

  async function override(pair: PairKey, language: PairLanguage | null) {
    setBusy(true); setError(null);
    try {
      setData(await getJson<PairLanguagesPayload>("/api/feedback-autowriter/pair-languages", {
        method: language === null ? "DELETE" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(language === null ? pair : { ...pair, language }),
      }));
    } catch (e) { setError(e instanceof Error ? e.message : "The class language could not be saved."); }
    finally { setBusy(false); }
  }

  return (
    <Disclosure title="Class languages" count={data?.pairs.length} hint="English · Bilingual · Thai per class and tutor"
      onToggle={(open) => { if (open && !data && !busy) void load(); }}>
      {busy && !data ? <p className="px-5 py-4 text-[11px] text-muted-foreground">Loading…</p> : null}
      {error ? (
        <div className="flex items-center gap-3 px-5 py-3">
          <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>Try again</Button>
        </div>
      ) : null}
      {data ? (
        <PairLanguagesTable data={data} canControl={canControl} filter={filter} onFilter={setFilter} busy={busy} onOverride={override} />
      ) : null}
    </Disclosure>
  );
}

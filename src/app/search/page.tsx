"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SlotInput } from "@/components/search/slot-input";
import { SlotChips } from "@/components/search/slot-chips";
import { ResultsView } from "@/components/search/results-view";
import { parseSlotInput } from "@/lib/search/parser";
import type { SearchSlot, SearchResponse, SearchMode } from "@/lib/search/types";

export default function SearchPage() {
  const [slots, setSlots] = useState<SearchSlot[]>([]);
  const [searchMode, setSearchMode] = useState<SearchMode>("recurring");
  const [modeFilter, setModeFilter] = useState<"online" | "onsite" | "either">("either");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [curriculumFilter, setCurriculumFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);

  const handleParse = (input: string) => {
    const result = parseSlotInput(input, modeFilter);
    setSlots((prev) => [...prev, ...result.slots]);
    setParseWarnings(result.warnings);
  };

  const handleRemoveSlot = (id: string) => {
    setSlots((prev) => prev.filter((s) => s.id !== id));
  };

  const handleSearch = async () => {
    if (slots.length === 0) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchMode,
          slots: slots.map((s) => ({ ...s, mode: modeFilter })),
          filters: {
            subject: subjectFilter || undefined,
            curriculum: curriculumFilter || undefined,
            level: levelFilter || undefined,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Search failed (${res.status})`);
      }

      const data: SearchResponse = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tutor Availability Search</h1>
        <a href="/data-health" className="text-sm text-blue-600 hover:underline">
          Data Health
        </a>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Search Criteria</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Search mode toggle */}
          <div className="flex gap-2">
            <Button
              variant={searchMode === "recurring" ? "default" : "outline"}
              onClick={() => setSearchMode("recurring")}
              size="sm"
            >
              Recurring Weekly
            </Button>
            <Button
              variant={searchMode === "one_time" ? "default" : "outline"}
              onClick={() => setSearchMode("one_time")}
              size="sm"
            >
              One-Time
            </Button>
          </div>

          {/* Slot input */}
          <SlotInput onParse={handleParse} />

          {/* Parse warnings */}
          {parseWarnings.length > 0 && (
            <div className="text-sm text-yellow-700">
              {parseWarnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}

          {/* Slot chips */}
          <SlotChips slots={slots} onRemove={handleRemoveSlot} />

          {/* Filters */}
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Mode</label>
              <select
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                value={modeFilter}
                onChange={(e) => setModeFilter(e.target.value as "online" | "onsite" | "either")}
              >
                <option value="either">Either</option>
                <option value="online">Online</option>
                <option value="onsite">Onsite</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Subject</label>
              <Input
                placeholder="e.g. Math"
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
                className="h-8"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Curriculum</label>
              <Input
                placeholder="e.g. International"
                value={curriculumFilter}
                onChange={(e) => setCurriculumFilter(e.target.value)}
                className="h-8"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Level</label>
              <Input
                placeholder="e.g. Y2-8"
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
                className="h-8"
              />
            </div>
          </div>

          {/* Search button */}
          <Button onClick={handleSearch} disabled={loading || slots.length === 0} className="w-full">
            {loading ? "Searching..." : "Search"}
          </Button>

          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}
        </CardContent>
      </Card>

      {/* Results */}
      {response && <ResultsView response={response} />}
    </div>
  );
}

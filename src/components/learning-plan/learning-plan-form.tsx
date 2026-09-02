"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { topicsIndex } from "@/lib/syllabus/topics-index";

const NOTES_MAX = 1000;

function allCodesFor(year: number): Set<string> {
  const summary = topicsIndex.find((item) => item.year === year);
  return new Set(summary?.topics.map((topic) => topic.code) ?? []);
}

export function LearningPlanForm() {
  const router = useRouter();
  const [student, setStudent] = useState("");
  const [year, setYear] = useState(7);
  const [tutor, setTutor] = useState("");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => allCodesFor(7));

  const summary = topicsIndex.find((item) => item.year === year);
  const topics = summary?.topics ?? [];
  const allSelected = selected.size === topics.length;
  const selectedSkillCount = topics
    .filter((topic) => selected.has(topic.code))
    .reduce((count, topic) => count + topic.skillCount, 0);

  function changeYear(nextYear: number) {
    // Base UI fires onValueChange even when the selected item is re-clicked.
    // Without this guard, that click wipes a curated topic selection.
    if (nextYear === year) return;
    setYear(nextYear);
    setSelected(allCodesFor(nextYear));
  }

  function toggleTopic(code: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!student.trim() || selected.size === 0) return;

    const params = new URLSearchParams();
    params.set("student", student.trim());
    params.set("year", String(year));
    if (tutor.trim()) params.set("tutor", tutor.trim());
    if (notes.trim()) params.set("notes", notes.trim());
    if (!allSelected) {
      params.set(
        "topics",
        topics
          .filter((topic) => selected.has(topic.code))
          .map((topic) => topic.code)
          .join(","),
      );
    }
    router.push(`/learning-plans/report?${params.toString()}`);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-10">
        <Image
          src="/brand/logo-horizontal.png"
          alt="BeGifted"
          width={194}
          height={76}
          preload
          className="mb-8 h-12 w-auto"
        />
        <p className="eyebrow mb-3">Internal tool · General Mathematics</p>
        <h1 className="begifted-display text-4xl">
          Learning Plan{" "}
          <em className="text-begifted-orange-500">Generator</em>
        </h1>
        <p className="mt-3 max-w-xl text-begifted-neutral-500">
          Enter the student&apos;s details and year group to generate a branded
          learning plan, then download it as a PDF to send to parents.
        </p>
      </header>

      <form onSubmit={handleSubmit}>
        <Card className="border-begifted-neutral-200 shadow-begifted-sm">
          <CardContent className="flex flex-col gap-6 p-6">
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="student">Student name</Label>
                <Input
                  id="student"
                  value={student}
                  maxLength={80}
                  required
                  placeholder="e.g. Thunthun"
                  onChange={(event) => setStudent(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="year">Year group</Label>
                <Select
                  value={String(year)}
                  onValueChange={(value) => changeYear(Number(value ?? year))}
                >
                  <SelectTrigger id="year" className="w-full bg-background">
                    <SelectValue>
                      Year {year} · {summary?.topicCount ?? 0} topics,{" "}
                      {summary?.skillCount ?? 0} skills
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent className="begifted">
                    {topicsIndex.map((item) => (
                      <SelectItem key={item.year} value={String(item.year)}>
                        Year {item.year} · {item.topicCount} topics,{" "}
                        {item.skillCount} skills
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tutor">
                Prepared by{" "}
                <span className="font-normal text-begifted-neutral-400">
                  (optional)
                </span>
              </Label>
              <Input
                id="tutor"
                value={tutor}
                maxLength={80}
                placeholder="Tutor or consultant name"
                onChange={(event) => setTutor(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">
                Notes for parents{" "}
                <span className="font-normal text-begifted-neutral-400">
                  (optional)
                </span>
              </Label>
              <Textarea
                id="notes"
                value={notes}
                maxLength={NOTES_MAX}
                rows={4}
                placeholder="Focus areas, current progress, a short message to parents…"
                onChange={(event) => setNotes(event.target.value)}
              />
              <p className="self-end text-xs text-begifted-neutral-400">
                {notes.length}/{NOTES_MAX}
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <Label>Topics to include</Label>
                  <p className="mt-1 text-xs text-begifted-neutral-500">
                    {selected.size}/{topics.length} topics ·{" "}
                    {selectedSkillCount} skills
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(allCodesFor(year))}
                  >
                    Select all
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear
                  </Button>
                </div>
              </div>
              <div className="grid max-h-80 gap-x-6 gap-y-2 overflow-y-auto rounded-lg border border-begifted-neutral-200 bg-begifted-neutral-50 p-4 sm:grid-cols-2">
                {topics.map((topic) => (
                  <label
                    key={topic.code}
                    className="flex cursor-pointer items-center gap-2.5 text-sm text-begifted-neutral-700"
                  >
                    <Checkbox
                      checked={selected.has(topic.code)}
                      onCheckedChange={() => toggleTopic(topic.code)}
                    />
                    <span className="min-w-6 font-medium text-begifted-neutral-400">
                      {topic.code}
                    </span>
                    <span className="flex-1">{topic.name}</span>
                    <span className="text-xs text-begifted-neutral-400">
                      {topic.skillCount}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <Button
              type="submit"
              size="lg"
              disabled={!student.trim() || selected.size === 0}
              className="self-start rounded-full bg-begifted-orange-500 px-7 font-semibold text-white shadow-[0_12px_28px_rgba(255,117,24,0.32)] hover:bg-begifted-orange-600"
            >
              <FileText data-icon="inline-start" />
              Generate learning plan
            </Button>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpenCheckIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";

import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { roleAtLeast } from "@/lib/admissions/config";
import type { EssayPromptCatalogDto } from "@/lib/admissions/essay-prompt-catalog";
import type { CaseRole } from "@/lib/admissions/types";
import type { EssayCollegeOption } from "./essays-view";

function readError(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && "error" in payload && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : fallback;
}

export function buildPromptCatalogQuery(institution: string, cycle: string): string {
  const params = new URLSearchParams({ activeOnly: "true" });
  if (institution.trim()) params.set("institution", institution.trim());
  if (cycle.trim()) params.set("cycle", cycle.trim());
  return params.toString();
}

export function buildEssayFromPromptPayload({
  promptId,
  listItemId,
  deadline,
  isStaff,
}: {
  promptId: string;
  listItemId: string;
  deadline: string;
  isStaff: boolean;
}) {
  const payload: Record<string, unknown> = {
    promptId,
  };
  if (isStaff) {
    payload.listItemId = listItemId || null;
    payload.deadline = deadline || null;
  }
  return payload;
}

export function EssayPromptChooser({
  caseId,
  collegeOptions,
  viewerRole,
}: {
  caseId: string;
  collegeOptions: EssayCollegeOption[];
  viewerRole: CaseRole;
}) {
  const router = useRouter();
  const isStaff = roleAtLeast(viewerRole, "counselor");
  const [open, setOpen] = useState(false);
  const [institution, setInstitution] = useState("");
  const [cycle, setCycle] = useState("");
  const [prompts, setPrompts] = useState<EssayPromptCatalogDto[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [listItemId, setListItemId] = useState("");
  const [deadline, setDeadline] = useState("");
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = prompts.find((prompt) => prompt.id === selectedId) ?? null;

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!institution.trim() && !cycle.trim()) {
      setError("Enter an institution or application cycle.");
      return;
    }
    setLoading(true);
    setError(null);
    setSelectedId("");
    try {
      const response = await fetch(
        `/api/admissions/prompt-catalog?${buildPromptCatalogQuery(institution, cycle)}`,
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Prompt catalog could not be searched."));
      const rows = payload && typeof payload === "object" && "prompts" in payload && Array.isArray((payload as { prompts?: unknown }).prompts)
        ? (payload as { prompts: EssayPromptCatalogDto[] }).prompts
        : [];
      setPrompts(rows);
      setSearched(true);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Prompt catalog could not be searched.");
    } finally {
      setLoading(false);
    }
  };

  const add = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/essays/from-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildEssayFromPromptPayload({
            promptId: selected.id,
            listItemId,
            deadline,
            isStaff,
          }),
        ),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "This prompt is already tracked for the selected college."
            : readError(payload, "Prompt could not be added."),
        );
      }
      setOpen(false);
      setSelectedId("");
      router.refresh();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Prompt could not be added.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid="open-prompt-catalog"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <BookOpenCheckIcon aria-hidden />
        Prompt catalog
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Choose a verified prompt</DialogTitle>
            <DialogDescription>
              Search by institution and annual cycle, preview the exact prompt,
              then add it to this case. Essay writing remains in Google Docs.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={search} className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
            <Input
              aria-label="Prompt institution"
              placeholder="Institution"
              value={institution}
              onChange={(event) => setInstitution(event.target.value)}
            />
            <Input
              aria-label="Prompt cycle"
              placeholder="2026-27"
              value={cycle}
              onChange={(event) => setCycle(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={loading}>
              <SearchIcon aria-hidden />
              {loading ? "Searching…" : "Search"}
            </Button>
          </form>

          {searched && prompts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active prompts matched. Try a shorter institution name or a
              different cycle.
            </p>
          ) : null}
          {prompts.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-muted-foreground">
                {prompts.length} matching prompt{prompts.length === 1 ? "" : "s"}
              </legend>
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {prompts.map((prompt) => (
                  <label
                    key={prompt.id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 p-3 has-checked:border-primary has-checked:bg-primary/5"
                  >
                    <input
                      type="radio"
                      name="catalog-prompt"
                      value={prompt.id}
                      checked={selectedId === prompt.id}
                      onChange={() => setSelectedId(prompt.id)}
                      className="mt-1"
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold">{prompt.institution}</span>
                        {prompt.program ? <Badge variant="outline">{prompt.program}</Badge> : null}
                        <Badge variant="secondary">{prompt.cycle}</Badge>
                        {prompt.wordLimit ? <Badge variant="outline">{prompt.wordLimit} words</Badge> : null}
                        {prompt.verifiedAt ? <Badge>Verified</Badge> : null}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {prompt.promptKey}
                      </span>
                      <span className="line-clamp-3 block text-sm">{prompt.prompt}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {selected ? (
            <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3" data-testid="prompt-preview">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold">Prompt preview</p>
                {selected.sourceUrl ? (
                  <a href={selected.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <ExternalLinkIcon aria-hidden className="size-3.5" /> Source
                  </a>
                ) : null}
              </div>
              <p className="text-sm whitespace-pre-wrap">{selected.prompt}</p>
              {isStaff ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="space-y-1 text-xs font-medium">
                    Link to college
                    <select className={SELECT_FIELD_CLASSES} value={listItemId} onChange={(event) => setListItemId(event.target.value)}>
                      <option value="">General / personal statement</option>
                      {collegeOptions.map((college) => <option key={college.id} value={college.id}>{college.instName}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs font-medium">
                    Deadline
                    <Input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" data-testid="select-catalog-prompt" onClick={() => void add()} disabled={!selected || saving}>{saving ? "Adding…" : "Add selected prompt"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

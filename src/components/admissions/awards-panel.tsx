"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon, TrophyIcon } from "lucide-react";

import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { roleAtLeast } from "@/lib/admissions/config";
import {
  ADMISSIONS_AWARD_GRADE_LEVELS,
  ADMISSIONS_AWARD_RECOGNITION_LEVELS,
  UC_AWARD_ACHIEVEMENT_MAX_CHARS,
  UC_AWARD_ELIGIBILITY_MAX_CHARS,
  type AdmissionsAwardGradeLevel,
  type AdmissionsAwardRecognitionLevel,
} from "@/lib/admissions/shared/awards";
import type { AwardDto } from "@/lib/admissions/awards";
import type { CaseRole } from "@/lib/admissions/types";

const GRADE_LABELS: Record<AdmissionsAwardGradeLevel, string> = {
  "9": "Grade 9",
  "10": "Grade 10",
  "11": "Grade 11",
  "12": "Grade 12",
  postgraduate: "Postgraduate",
};

const RECOGNITION_LABELS: Record<AdmissionsAwardRecognitionLevel, string> = {
  school: "School",
  regional: "Regional",
  state: "State",
  national: "National",
  international: "International",
};

interface AwardFormState {
  title: string;
  organization: string;
  gradeLevels: AdmissionsAwardGradeLevel[];
  recognitionLevels: AdmissionsAwardRecognitionLevel[];
  awardDate: string;
  commonAppRank: string;
  ucEligibilityNarrative: string;
  ucAchievementNarrative: string;
  internalNotes: string;
}

const EMPTY_AWARD_FORM: AwardFormState = {
  title: "",
  organization: "",
  gradeLevels: [],
  recognitionLevels: [],
  awardDate: "",
  commonAppRank: "",
  ucEligibilityNarrative: "",
  ucAchievementNarrative: "",
  internalNotes: "",
};

function formFromAward(award: AwardDto): AwardFormState {
  return {
    title: award.title,
    organization: award.organization ?? "",
    gradeLevels: award.gradeLevels,
    recognitionLevels: award.recognitionLevels,
    awardDate: award.awardDate ?? "",
    commonAppRank: award.commonAppRank == null ? "" : String(award.commonAppRank),
    ucEligibilityNarrative: award.ucEligibilityNarrative ?? "",
    ucAchievementNarrative: award.ucAchievementNarrative ?? "",
    internalNotes: award.internalNotes ?? "",
  };
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

export function buildAwardPayload(form: AwardFormState, includeInternalNotes: boolean) {
  return {
    title: form.title.trim(),
    organization: nullable(form.organization),
    gradeLevels: form.gradeLevels,
    recognitionLevels: form.recognitionLevels,
    awardDate: form.awardDate || null,
    commonAppRank: form.commonAppRank ? Number(form.commonAppRank) : null,
    ucEligibilityNarrative: nullable(form.ucEligibilityNarrative),
    ucAchievementNarrative: nullable(form.ucAchievementNarrative),
    ...(includeInternalNotes ? { internalNotes: nullable(form.internalNotes) } : {}),
  };
}

function readError(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && "error" in payload && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : fallback;
}

function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function AwardsPanel({ caseId, viewerRole }: { caseId: string; viewerRole: CaseRole }) {
  const canEdit = roleAtLeast(viewerRole, "student");
  const isStaff = roleAtLeast(viewerRole, "counselor");
  const [awards, setAwards] = useState<AwardDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AwardFormState>(EMPTY_AWARD_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/awards`);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Awards could not be loaded."));
      setAwards(payload && typeof payload === "object" && "awards" in payload && Array.isArray((payload as { awards?: unknown }).awards)
        ? (payload as { awards: AwardDto[] }).awards
        : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Awards could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  const editingAward = useMemo(() => awards.find((award) => award.id === editingId) ?? null, [awards, editingId]);

  const startCreate = () => { setForm({ ...EMPTY_AWARD_FORM }); setEditingId(null); setError(null); setFormOpen(true); };
  const startEdit = (award: AwardDto) => { setForm(formFromAward(award)); setEditingId(award.id); setError(null); setFormOpen(true); };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) { setError("Award title is required."); return; }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/awards`, {
        method: editingAward ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingAward
          ? { action: "update", awardId: editingAward.id, expectedUpdatedAt: editingAward.updatedAt, ...buildAwardPayload(form, isStaff) }
          : buildAwardPayload(form, isStaff)),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Award could not be saved."));
      setFormOpen(false);
      setEditingId(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Award could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (award: AwardDto) => {
    if (!window.confirm(`Remove “${award.title}”?`)) return;
    const response = await fetch(`/api/admissions/cases/${caseId}/awards?awardId=${award.id}`, { method: "DELETE" });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) { setError(readError(payload, "Award could not be removed.")); return; }
    await load();
  };

  return (
    <div className="space-y-4" data-testid="awards-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-base font-semibold">Honors &amp; Awards</h2><p className="text-sm text-muted-foreground">Recognition records stay separate from activities and can be ranked for Common App.</p></div>
        {canEdit && !formOpen ? <Button size="sm" onClick={startCreate}><PlusIcon aria-hidden /> Add award</Button> : null}
      </div>
      {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}

      {formOpen ? (
        <Card>
          <CardHeader><CardTitle>{editingAward ? "Edit award" : "Add award"}</CardTitle><CardDescription>Keep UC narratives within their published character limits.</CardDescription></CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-medium">Award title <span aria-hidden className="text-destructive">*</span><Input required value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} /></label>
                <label className="space-y-1 text-xs font-medium">Organization<Input value={form.organization} onChange={(event) => setForm((current) => ({ ...current, organization: event.target.value }))} /></label>
                <label className="space-y-1 text-xs font-medium">Award date<Input type="date" value={form.awardDate} onChange={(event) => setForm((current) => ({ ...current, awardDate: event.target.value }))} /></label>
                <label className="space-y-1 text-xs font-medium">Common App top-five rank<select className={SELECT_FIELD_CLASSES} value={form.commonAppRank} onChange={(event) => setForm((current) => ({ ...current, commonAppRank: event.target.value }))}><option value="">Not ranked</option>{[1, 2, 3, 4, 5].map((rank) => <option key={rank} value={rank}>#{rank}</option>)}</select></label>
              </div>
              <fieldset className="space-y-2"><legend className="text-xs font-medium">Grade levels</legend><div className="flex flex-wrap gap-2">{ADMISSIONS_AWARD_GRADE_LEVELS.map((level) => <label key={level} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-3 text-sm"><input type="checkbox" checked={form.gradeLevels.includes(level)} onChange={() => setForm((current) => ({ ...current, gradeLevels: toggleValue(current.gradeLevels, level) }))} />{GRADE_LABELS[level]}</label>)}</div></fieldset>
              <fieldset className="space-y-2"><legend className="text-xs font-medium">Recognition levels</legend><div className="flex flex-wrap gap-2">{ADMISSIONS_AWARD_RECOGNITION_LEVELS.map((level) => <label key={level} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-3 text-sm"><input type="checkbox" checked={form.recognitionLevels.includes(level)} onChange={() => setForm((current) => ({ ...current, recognitionLevels: toggleValue(current.recognitionLevels, level) }))} />{RECOGNITION_LABELS[level]}</label>)}</div></fieldset>
              <label className="block space-y-1 text-xs font-medium">UC eligibility narrative <span className="font-normal text-muted-foreground">({form.ucEligibilityNarrative.length}/{UC_AWARD_ELIGIBILITY_MAX_CHARS})</span><Textarea maxLength={UC_AWARD_ELIGIBILITY_MAX_CHARS} value={form.ucEligibilityNarrative} onChange={(event) => setForm((current) => ({ ...current, ucEligibilityNarrative: event.target.value }))} placeholder="What did you do to become eligible for this award?" /></label>
              <label className="block space-y-1 text-xs font-medium">UC achievement narrative <span className="font-normal text-muted-foreground">({form.ucAchievementNarrative.length}/{UC_AWARD_ACHIEVEMENT_MAX_CHARS})</span><Textarea maxLength={UC_AWARD_ACHIEVEMENT_MAX_CHARS} value={form.ucAchievementNarrative} onChange={(event) => setForm((current) => ({ ...current, ucAchievementNarrative: event.target.value }))} placeholder="What did you do to achieve this recognition?" /></label>
              {isStaff ? <label className="block space-y-1 text-xs font-medium">Internal counselor notes<Textarea value={form.internalNotes} onChange={(event) => setForm((current) => ({ ...current, internalNotes: event.target.value }))} /><span className="font-normal text-muted-foreground">Never shown in family projections.</span></label> : null}
              <div className="flex gap-2"><Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save award"}</Button><Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => { setFormOpen(false); setEditingId(null); }}>Cancel</Button></div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {loading ? <Card><CardContent><p className="text-sm text-muted-foreground">Loading awards…</p></CardContent></Card> : null}
      {!loading && awards.length === 0 ? <Card><CardContent className="flex items-start gap-3"><TrophyIcon aria-hidden className="mt-0.5 size-5 text-muted-foreground" /><p className="text-sm text-muted-foreground">No awards yet. Add academic, community, arts, sports, and other recognition here.</p></CardContent></Card> : null}
      <div className="space-y-3">
        {awards.map((award) => (
          <Card key={award.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">{award.commonAppRank ? <Badge>Common App #{award.commonAppRank}</Badge> : null}<span>{award.title}</span></CardTitle>
              <CardDescription>{[award.organization, award.awardDate].filter(Boolean).join(" · ") || "No organization or date recorded"}</CardDescription>
              {canEdit ? <CardAction className="flex gap-1"><Button size="xs" variant="ghost" onClick={() => startEdit(award)}><PencilIcon aria-hidden /> Edit</Button><Button size="icon-sm" variant="ghost" aria-label={`Remove ${award.title}`} onClick={() => void remove(award)}><Trash2Icon aria-hidden /></Button></CardAction> : null}
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-1">{award.gradeLevels.map((level) => <Badge key={level} variant="outline">{GRADE_LABELS[level]}</Badge>)}{award.recognitionLevels.map((level) => <Badge key={level} variant="secondary">{RECOGNITION_LABELS[level]}</Badge>)}</div>
              {award.ucEligibilityNarrative ? <div><p className="text-xs font-medium text-muted-foreground">UC eligibility</p><p className="whitespace-pre-wrap">{award.ucEligibilityNarrative}</p></div> : null}
              {award.ucAchievementNarrative ? <div><p className="text-xs font-medium text-muted-foreground">UC achievement</p><p className="whitespace-pre-wrap">{award.ucAchievementNarrative}</p></div> : null}
              {isStaff && award.internalNotes ? <div className="rounded-md bg-muted/50 p-2"><p className="text-xs font-medium text-muted-foreground">Internal notes</p><p className="whitespace-pre-wrap">{award.internalNotes}</p></div> : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

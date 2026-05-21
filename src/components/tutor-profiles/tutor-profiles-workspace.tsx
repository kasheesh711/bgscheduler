"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Plus, Save, Search, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { TEACHING_STYLE_VOCABULARY } from "@/lib/tutor-profile-vocabulary";
import type { TutorProfileImportPreview } from "@/lib/tutor-profile-import";
import type {
  EnglishProficiency,
  TutorBusinessProfileListItem,
  YoungLearnerFit,
} from "@/lib/tutor-business-profiles";

type EducationEntry = TutorBusinessProfileListItem["education"][number];
type LanguageEntry = TutorBusinessProfileListItem["languages"][number];

const ENGLISH_PROFICIENCY_OPTIONS: EnglishProficiency[] = [
  "unknown",
  "basic",
  "conversational",
  "fluent",
  "near-native",
  "native",
];

const YOUNG_LEARNER_FIT_OPTIONS: YoungLearnerFit[] = [
  "unknown",
  "comfortable",
  "conditional",
  "not_comfortable",
];

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(value: string[]): string {
  return value.join(", ");
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateInputValue(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

function datetimeFromDateInput(value: string): string | null {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;
}

function emptyEducation(): EducationEntry {
  return { institution: "", country: "", program: "", notes: "" };
}

function emptyLanguage(): LanguageEntry {
  return { language: "", proficiency: "", verificationSource: "" };
}

function cleanedEducation(entries: EducationEntry[]): EducationEntry[] {
  return entries
    .map((entry) => ({
      institution: entry.institution.trim(),
      country: entry.country?.trim() || undefined,
      program: entry.program?.trim() || undefined,
      notes: entry.notes?.trim() || undefined,
    }))
    .filter((entry) => entry.institution);
}

function cleanedLanguages(entries: LanguageEntry[]): LanguageEntry[] {
  return entries
    .map((entry) => ({
      language: entry.language.trim(),
      proficiency: entry.proficiency.trim(),
      verificationSource: entry.verificationSource?.trim() || undefined,
    }))
    .filter((entry) => entry.language && entry.proficiency);
}

function profileHasContent(profile: TutorBusinessProfileListItem): boolean {
  return Boolean(
    profile.parentSafeSummary ||
    profile.internalNotes ||
    profile.education.length ||
    profile.languages.length ||
    profile.englishProficiency !== "unknown" ||
    profile.youngLearnerFit !== "unknown" ||
    profile.youngestComfortableAge !== null ||
    profile.youngLearnerNotes ||
    profile.teachingStyleTags.length ||
    profile.teachingStyleNotes ||
    profile.strengthTags.length ||
    profile.curriculumExperience.length ||
    profile.studentFitNotes ||
    profile.doNotUseForNotes ||
    profile.verifiedBy ||
    profile.lastReviewedAt
  );
}

export function TutorProfilesWorkspace() {
  const [profiles, setProfiles] = useState<TutorBusinessProfileListItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<TutorBusinessProfileListItem | null>(null);
  const [strengthText, setStrengthText] = useState("");
  const [curriculumText, setCurriculumText] = useState("");
  const [teachingStyleText, setTeachingStyleText] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [educationFile, setEducationFile] = useState<File | null>(null);
  const [availabilityFile, setAvailabilityFile] = useState<File | null>(null);
  const [importVerifiedBy, setImportVerifiedBy] = useState("");
  const [importReviewedAt, setImportReviewedAt] = useState(todayIsoDate());
  const [importPreview, setImportPreview] = useState<TutorProfileImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [committingImport, setCommittingImport] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadProfiles() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/tutor-profiles");
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "Failed to load tutor profiles");
        if (cancelled) return;
        const loaded = data.profiles as TutorBusinessProfileListItem[];
        setProfiles(loaded);
        setSelectedKey((current) => current ?? loaded[0]?.canonicalKey ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load tutor profiles");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadProfiles();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.canonicalKey === selectedKey) ?? null,
    [profiles, selectedKey],
  );

  useEffect(() => {
    if (!selectedProfile) {
      setDraft(null);
      return;
    }
    setDraft(JSON.parse(JSON.stringify(selectedProfile)) as TutorBusinessProfileListItem);
    setStrengthText(joinList(selectedProfile.strengthTags));
    setCurriculumText(joinList(selectedProfile.curriculumExperience));
    setTeachingStyleText(joinList(selectedProfile.teachingStyleTags));
    setSaved(false);
  }, [selectedProfile]);

  const filteredProfiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter((profile) => [
      profile.displayName,
      profile.canonicalKey,
      profile.subjects.join(" "),
      profile.parentSafeSummary,
      profile.strengthTags.join(" "),
      profile.teachingStyleTags.join(" "),
      profile.youngLearnerNotes,
    ].join(" ").toLowerCase().includes(needle));
  }, [profiles, query]);

  const updateDraft = <K extends keyof TutorBusinessProfileListItem>(key: K, value: TutorBusinessProfileListItem[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setSaved(false);
  };

  const updateEducation = (index: number, key: keyof EducationEntry, value: string) => {
    setDraft((current) => {
      if (!current) return current;
      const education = [...current.education];
      education[index] = { ...education[index], [key]: value };
      return { ...current, education };
    });
    setSaved(false);
  };

  const updateLanguage = (index: number, key: keyof LanguageEntry, value: string) => {
    setDraft((current) => {
      if (!current) return current;
      const languages = [...current.languages];
      languages[index] = { ...languages[index], [key]: value };
      return { ...current, languages };
    });
    setSaved(false);
  };

  const saveProfile = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const strengthTags = splitList(strengthText);
    const curriculumExperience = splitList(curriculumText);
    const teachingStyleTags = splitList(teachingStyleText);
    const payload = {
      displayName: draft.displayName,
      parentSafeSummary: draft.parentSafeSummary,
      internalNotes: draft.internalNotes,
      education: cleanedEducation(draft.education),
      languages: cleanedLanguages(draft.languages),
      englishProficiency: draft.englishProficiency,
      youngLearnerFit: draft.youngLearnerFit,
      youngestComfortableAge: draft.youngestComfortableAge,
      youngLearnerNotes: draft.youngLearnerNotes,
      teachingStyleTags,
      teachingStyleNotes: draft.teachingStyleNotes,
      strengthTags,
      curriculumExperience,
      studentFitNotes: draft.studentFitNotes,
      doNotUseForNotes: draft.doNotUseForNotes,
      verifiedBy: draft.verifiedBy,
      lastReviewedAt: draft.lastReviewedAt,
      active: draft.active,
    };

    try {
      const response = await fetch(`/api/tutor-profiles/${encodeURIComponent(draft.canonicalKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Failed to save tutor profile");
      const savedProfile = {
        ...draft,
        ...data.profile,
        tutorGroupId: draft.tutorGroupId,
        supportedModes: draft.supportedModes,
        subjects: draft.subjects,
        strengthTags,
        curriculumExperience,
        teachingStyleTags,
      } as TutorBusinessProfileListItem;
      setProfiles((current) => current.map((profile) => (
        profile.canonicalKey === savedProfile.canonicalKey ? savedProfile : profile
      )));
      setDraft(savedProfile);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save tutor profile");
    } finally {
      setSaving(false);
    }
  };

  const previewImport = async () => {
    if (importing) return;
    setImporting(true);
    setError(null);
    setImportPreview(null);
    try {
      const formData = new FormData();
      if (educationFile) formData.append("educationFile", educationFile);
      if (availabilityFile) formData.append("availabilityFile", availabilityFile);
      if (importVerifiedBy.trim()) formData.append("verifiedBy", importVerifiedBy.trim());
      if (importReviewedAt) formData.append("lastReviewedAt", datetimeFromDateInput(importReviewedAt) ?? "");
      const response = await fetch("/api/tutor-profiles/import-preview", {
        method: "POST",
        body: formData,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Failed to preview import");
      setImportPreview(data as TutorProfileImportPreview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview import");
    } finally {
      setImporting(false);
    }
  };

  const commitImport = async () => {
    if (!importPreview || committingImport) return;
    setCommittingImport(true);
    setError(null);
    try {
      const response = await fetch("/api/tutor-profiles/import-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: importPreview.rows.map((row) => ({
            canonicalKey: row.canonicalKey,
            patch: row.patch,
          })),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Failed to commit import");
      const savedProfiles = new Map((data.profiles ?? []).map((profile: TutorBusinessProfileListItem) => [profile.canonicalKey, profile]));
      setProfiles((current) => current.map((profile) => {
        const savedProfile = savedProfiles.get(profile.canonicalKey);
        return savedProfile ? {
          ...profile,
          ...savedProfile,
          tutorGroupId: profile.tutorGroupId,
          supportedModes: profile.supportedModes,
          subjects: profile.subjects,
        } as TutorBusinessProfileListItem : profile;
      }));
      setImportPreview(null);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to commit import");
    } finally {
      setCommittingImport(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
      <aside className="flex w-[310px] shrink-0 flex-col overflow-hidden border-r border-border/60 pr-3">
        <div className="mb-2">
          <h1 className="text-sm font-semibold text-foreground">Tutor Profiles</h1>
          <p className="text-[11px] text-muted-foreground">Local business context for scheduler AI</p>
        </div>
        <section className="mb-2 rounded-md border border-border bg-card/70 p-2">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Upload className="h-3.5 w-3.5" aria-hidden />
            Import seed data
          </div>
          <div className="space-y-2">
            <label className="block text-[10px] font-medium text-muted-foreground">
              Education workbook
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={(event) => setEducationFile(event.target.files?.[0] ?? null)}
                className="mt-1 block w-full text-[10px] text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-[10px] file:text-secondary-foreground"
              />
            </label>
            <label className="block text-[10px] font-medium text-muted-foreground">
              Availability/profile workbook
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={(event) => setAvailabilityFile(event.target.files?.[0] ?? null)}
                className="mt-1 block w-full text-[10px] text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-[10px] file:text-secondary-foreground"
              />
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <Input
                value={importVerifiedBy}
                onChange={(event) => setImportVerifiedBy(event.target.value)}
                placeholder="Verified by"
                className="h-7 text-[11px]"
              />
              <Input
                type="date"
                value={importReviewedAt}
                onChange={(event) => setImportReviewedAt(event.target.value)}
                className="h-7 text-[11px]"
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={previewImport}
              disabled={importing || (!educationFile && !availabilityFile)}
              className="h-7 w-full text-[11px]"
            >
              {importing ? "Previewing" : "Preview import"}
            </Button>
          </div>
          {importPreview && (
            <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
              <div className="grid grid-cols-3 gap-1 text-center">
                <div className="rounded-md bg-muted px-1 py-1">
                  <div className="text-xs font-semibold text-foreground">{importPreview.summary.matchedRows}</div>
                  <div className="text-[9px] text-muted-foreground">matched</div>
                </div>
                <div className="rounded-md bg-muted px-1 py-1">
                  <div className="text-xs font-semibold text-foreground">{importPreview.summary.unmatchedRows}</div>
                  <div className="text-[9px] text-muted-foreground">review</div>
                </div>
                <div className="rounded-md bg-muted px-1 py-1">
                  <div className="text-xs font-semibold text-foreground">{importPreview.summary.availabilityOnlyRows}</div>
                  <div className="text-[9px] text-muted-foreground">profile-only</div>
                </div>
              </div>
              {(importPreview.unmatchedRows.length > 0 || importPreview.duplicateSourceRows.length > 0 || importPreview.invalidRows.length > 0) && (
                <div className="max-h-24 overflow-y-auto rounded-md border border-amber-300/50 bg-amber-500/10 p-2 text-[10px] text-amber-900 dark:text-amber-200">
                  <div className="mb-1 flex items-center gap-1 font-semibold">
                    <AlertTriangle className="h-3 w-3" aria-hidden />
                    Review before commit
                  </div>
                  {[...importPreview.unmatchedRows.map((row) => `${row.sourceName}: ${row.reason}`), ...importPreview.duplicateSourceRows, ...importPreview.invalidRows].slice(0, 8).map((item) => (
                    <div key={item} className="truncate">{item}</div>
                  ))}
                </div>
              )}
              <Button
                type="button"
                size="sm"
                onClick={commitImport}
                disabled={committingImport || importPreview.rows.length === 0}
                className="h-7 w-full text-[11px]"
              >
                {committingImport ? "Importing" : `Commit ${importPreview.rows.length} matched`}
              </Button>
            </div>
          )}
        </section>
        <div className="mb-2 flex items-center gap-1 rounded-md border border-input bg-background px-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tutors"
            className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {loading ? (
            <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">Loading profiles...</div>
          ) : filteredProfiles.length === 0 ? (
            <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">No tutors match this search.</div>
          ) : filteredProfiles.map((profile) => {
            const selected = profile.canonicalKey === selectedKey;
            const complete = profileHasContent(profile);
            return (
              <button
                key={profile.canonicalKey}
                type="button"
                onClick={() => setSelectedKey(profile.canonicalKey)}
                className={cn(
                  "w-full rounded-md border p-2 text-left transition-colors",
                  selected ? "border-primary/40 bg-primary/10" : "border-border bg-background hover:bg-muted/60",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <div className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{profile.displayName}</div>
                  <Badge variant={complete ? "secondary" : "outline"} className="h-4 px-1 text-[9px]">
                    {complete ? "Profiled" : "Blank"}
                  </Badge>
                </div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">
                  {profile.subjects.slice(0, 4).join(", ") || "No subjects"}
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  English: {profile.englishProficiency}
                  {profile.youngLearnerFit !== "unknown" ? ` · Young learners: ${profile.youngLearnerFit}` : ""}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto pr-1">
        {error && (
          <div className="mb-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</div>
        )}

        {!draft ? (
          <div className="rounded-md border border-border p-6 text-sm text-muted-foreground">
            Select a tutor to edit profile context.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-lg font-semibold text-foreground">{draft.displayName}</h2>
                  <Badge variant="outline" className="h-5 text-[10px]">{draft.canonicalKey}</Badge>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {draft.supportedModes.map((mode) => <Badge key={mode} variant="secondary" className="h-5 text-[10px]">{mode}</Badge>)}
                  {draft.subjects.slice(0, 8).map((subject) => <Badge key={subject} variant="outline" className="h-5 text-[10px]">{subject}</Badge>)}
                </div>
              </div>
              <Button type="button" size="sm" onClick={saveProfile} disabled={saving}>
                {saved ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />}
                {saving ? "Saving" : saved ? "Saved" : "Save"}
              </Button>
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="space-y-3">
                <section className="rounded-md border border-border bg-card/70 p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Parent-safe context</div>
                  <Textarea
                    value={draft.parentSafeSummary}
                    onChange={(event) => updateDraft("parentSafeSummary", event.target.value)}
                    rows={4}
                    placeholder="Short facts safe to include in parent messages."
                    className="min-h-[98px] resize-none text-sm"
                  />
                </section>

                <section className="rounded-md border border-border bg-card/70 p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Education</div>
                  <div className="space-y-2">
                    {draft.education.map((entry, index) => (
                      <div key={index} className="grid gap-2 rounded-md border border-border bg-background p-2 md:grid-cols-2">
                        <Input value={entry.institution} onChange={(event) => updateEducation(index, "institution", event.target.value)} placeholder="School or university" className="text-xs" />
                        <Input value={entry.country ?? ""} onChange={(event) => updateEducation(index, "country", event.target.value)} placeholder="Country" className="text-xs" />
                        <Input value={entry.program ?? ""} onChange={(event) => updateEducation(index, "program", event.target.value)} placeholder="Program or degree" className="text-xs" />
                        <div className="flex gap-2">
                          <Input value={entry.notes ?? ""} onChange={(event) => updateEducation(index, "notes", event.target.value)} placeholder="Notes" className="text-xs" />
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => updateDraft("education", draft.education.filter((_, itemIndex) => itemIndex !== index))}
                            aria-label="Remove education row"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => updateDraft("education", [...draft.education, emptyEducation()])}
                    className="mt-2"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Add education
                  </Button>
                </section>

                <section className="rounded-md border border-border bg-card/70 p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Languages</div>
                  <div className="space-y-2">
                    {draft.languages.map((entry, index) => (
                      <div key={index} className="grid gap-2 rounded-md border border-border bg-background p-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                        <Input value={entry.language} onChange={(event) => updateLanguage(index, "language", event.target.value)} placeholder="Language" className="text-xs" />
                        <Input value={entry.proficiency} onChange={(event) => updateLanguage(index, "proficiency", event.target.value)} placeholder="Proficiency" className="text-xs" />
                        <Input value={entry.verificationSource ?? ""} onChange={(event) => updateLanguage(index, "verificationSource", event.target.value)} placeholder="Verification source" className="text-xs" />
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => updateDraft("languages", draft.languages.filter((_, itemIndex) => itemIndex !== index))}
                          aria-label="Remove language row"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => updateDraft("languages", [...draft.languages, emptyLanguage()])}
                    className="mt-2"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Add language
                  </Button>
                </section>
              </div>

              <div className="space-y-3">
                <section className="rounded-md border border-border bg-card/70 p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Structured fit</div>
                  <label className="block text-[11px] font-medium text-muted-foreground">
                    English proficiency
                    <select
                      value={draft.englishProficiency}
                      onChange={(event) => updateDraft("englishProficiency", event.target.value as EnglishProficiency)}
                      className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                    >
                      {ENGLISH_PROFICIENCY_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </label>
                  <label className="mt-3 block text-[11px] font-medium text-muted-foreground">
                    Strength tags
                    <Input value={strengthText} onChange={(event) => setStrengthText(event.target.value)} placeholder="writing, exam prep, young learners" className="mt-1 text-xs" />
                  </label>
                  <label className="mt-3 block text-[11px] font-medium text-muted-foreground">
                    Curriculum experience
                    <Input value={curriculumText} onChange={(event) => setCurriculumText(event.target.value)} placeholder="International, IGCSE, IELTS" className="mt-1 text-xs" />
                  </label>
                  <div className="mt-3 grid grid-cols-[1fr_96px] gap-2">
                    <label className="block text-[11px] font-medium text-muted-foreground">
                      Young learner fit
                      <select
                        value={draft.youngLearnerFit}
                        onChange={(event) => updateDraft("youngLearnerFit", event.target.value as YoungLearnerFit)}
                        className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                      >
                        {YOUNG_LEARNER_FIT_OPTIONS.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-[11px] font-medium text-muted-foreground">
                      Min age
                      <Input
                        type="number"
                        min={3}
                        max={20}
                        value={draft.youngestComfortableAge ?? ""}
                        onChange={(event) => updateDraft(
                          "youngestComfortableAge",
                          event.target.value ? Number(event.target.value) : null,
                        )}
                        className="mt-1 text-xs"
                      />
                    </label>
                  </div>
                  <label className="mt-3 block text-[11px] font-medium text-muted-foreground">
                    Young learner notes
                    <Textarea value={draft.youngLearnerNotes} onChange={(event) => updateDraft("youngLearnerNotes", event.target.value)} rows={3} className="mt-1 min-h-[66px] resize-none text-xs" />
                  </label>
                  <label className="mt-3 block text-[11px] font-medium text-muted-foreground">
                    Teaching style tags
                    <Input value={teachingStyleText} onChange={(event) => setTeachingStyleText(event.target.value)} placeholder="patient, structured, interactive" className="mt-1 text-xs" />
                  </label>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {TEACHING_STYLE_VOCABULARY.map((entry) => (
                      <button
                        key={entry.tag}
                        type="button"
                        onClick={() => setTeachingStyleText((current) => joinList([...new Set([...splitList(current), entry.tag])]))}
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                  <label className="mt-3 block text-[11px] font-medium text-muted-foreground">
                    Teaching style notes
                    <Textarea value={draft.teachingStyleNotes} onChange={(event) => updateDraft("teachingStyleNotes", event.target.value)} rows={3} className="mt-1 min-h-[66px] resize-none text-xs" />
                  </label>
                </section>

                <section className="rounded-md border border-border bg-card/70 p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Internal guidance</div>
                  <label className="block text-[11px] font-medium text-muted-foreground">
                    Student fit notes
                    <Textarea value={draft.studentFitNotes} onChange={(event) => updateDraft("studentFitNotes", event.target.value)} rows={4} className="mt-1 min-h-[88px] resize-none text-xs" />
                  </label>
                  <label className="mt-3 block text-[11px] font-medium text-muted-foreground">
                    Do-not-use notes
                    <Textarea value={draft.doNotUseForNotes} onChange={(event) => updateDraft("doNotUseForNotes", event.target.value)} rows={4} className="mt-1 min-h-[88px] resize-none text-xs" />
                  </label>
                  <label className="mt-3 block text-[11px] font-medium text-muted-foreground">
                    Internal notes
                    <Textarea value={draft.internalNotes} onChange={(event) => updateDraft("internalNotes", event.target.value)} rows={5} className="mt-1 min-h-[106px] resize-none text-xs" />
                  </label>
                </section>

                <section className="rounded-md border border-border bg-card/70 p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Verification</div>
                  <label className="block text-[11px] font-medium text-muted-foreground">
                    Verified by
                    <Input value={draft.verifiedBy ?? ""} onChange={(event) => updateDraft("verifiedBy", event.target.value || null)} className="mt-1 text-xs" />
                  </label>
                  <label className="mt-3 block text-[11px] font-medium text-muted-foreground">
                    Last reviewed
                    <div className="mt-1 flex gap-2">
                      <Input
                        type="date"
                        value={dateInputValue(draft.lastReviewedAt)}
                        onChange={(event) => updateDraft("lastReviewedAt", datetimeFromDateInput(event.target.value))}
                        className="text-xs"
                      />
                      <Button type="button" size="sm" variant="outline" onClick={() => updateDraft("lastReviewedAt", datetimeFromDateInput(todayIsoDate()))}>
                        Today
                      </Button>
                    </div>
                  </label>
                  <label className="mt-3 flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={draft.active}
                      onChange={(event) => updateDraft("active", event.target.checked)}
                      className="h-4 w-4 rounded border-input"
                    />
                    Active profile
                  </label>
                </section>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

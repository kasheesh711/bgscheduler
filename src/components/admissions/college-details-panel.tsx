"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLinkIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { roleAtLeast } from "@/lib/admissions/config";
import type {
  CollegeResearchDto,
  CollegeRequirementDto,
  InterestEventDto,
} from "@/lib/admissions/college-details";
import type { AdmissionsCollegeListRowDto } from "@/lib/admissions/colleges";
import type {
  CollegeRequirementKind,
  InterestEventType,
} from "@/lib/admissions/shared/college-details";
import {
  COLLEGE_REQUIREMENT_KINDS,
  INTEREST_EVENT_TYPES,
} from "@/lib/admissions/shared/college-details";
import type { CaseRole } from "@/lib/admissions/types";

const REQUIREMENT_LABELS: Record<CollegeRequirementKind, string> = {
  college_questions: "College questions",
  honors_program: "Honors program",
  interview: "Interview",
  portfolio: "Portfolio",
  srar: "SRAR",
  fafsa: "FAFSA",
  css_profile: "CSS Profile",
  scholarship: "Scholarship",
  other: "Other",
};

const INTEREST_LABELS: Record<InterestEventType, string> = {
  information_session: "Information session",
  campus_visit: "Campus visit",
  college_fair: "College fair",
  interview: "Interview",
  email: "Email",
  webinar: "Webinar",
  other: "Other",
};

interface ResearchForm {
  fitRating: string;
  sourceLabel: string;
  sourceUrl: string;
  campusVisitDate: string;
  campusVisitNotes: string;
  academicNotes: string;
  opportunities: string;
  questions: string;
  notes: string;
}

interface PlanForm {
  firstChoiceMajor: string;
  secondChoiceMajor: string;
  admissionsUrl: string;
  portalUrl: string;
}

function researchFormFromDto(value: CollegeResearchDto | null): ResearchForm {
  return {
    fitRating: value?.fitRating == null ? "" : String(value.fitRating),
    sourceLabel: value?.sources[0]?.label ?? "",
    sourceUrl: value?.sources[0]?.url ?? "",
    campusVisitDate: value?.campusVisitDate ?? "",
    campusVisitNotes: value?.campusVisitNotes ?? "",
    academicNotes: value?.academicNotes ?? "",
    opportunities: value?.opportunities ?? "",
    questions: value?.questions ?? "",
    notes: value?.notes ?? "",
  };
}

function planFormFromCollege(college: AdmissionsCollegeListRowDto): PlanForm {
  return {
    firstChoiceMajor: college.firstChoiceMajor ?? "",
    secondChoiceMajor: college.secondChoiceMajor ?? "",
    admissionsUrl: college.admissionsUrl ?? "",
    portalUrl: college.portalUrl ?? "",
  };
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function readError(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && "error" in payload && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : fallback;
}

export function CollegeDetailsPanel({
  caseId,
  colleges,
  viewerRole,
}: {
  caseId: string;
  colleges: AdmissionsCollegeListRowDto[];
  viewerRole: CaseRole;
}) {
  const canContribute = roleAtLeast(viewerRole, "student");
  const isStaff = roleAtLeast(viewerRole, "counselor");
  const [selectedId, setSelectedId] = useState(colleges[0]?.id ?? "");
  const selected = useMemo(() => colleges.find((college) => college.id === selectedId) ?? null, [colleges, selectedId]);
  const [research, setResearch] = useState<CollegeResearchDto | null>(null);
  const [events, setEvents] = useState<InterestEventDto[]>([]);
  const [requirements, setRequirements] = useState<CollegeRequirementDto[]>([]);
  const [researchForm, setResearchForm] = useState<ResearchForm>(() => researchFormFromDto(null));
  const [planForm, setPlanForm] = useState<PlanForm>({ firstChoiceMajor: "", secondChoiceMajor: "", admissionsUrl: "", portalUrl: "" });
  const [eventType, setEventType] = useState<InterestEventType>("information_session");
  const [eventDate, setEventDate] = useState("");
  const [eventNotes, setEventNotes] = useState("");
  const [requirementKind, setRequirementKind] = useState<CollegeRequirementKind>("college_questions");
  const [requirementTitle, setRequirementTitle] = useState("");
  const [requirementDueDate, setRequirementDueDate] = useState("");
  const [requirementOwner, setRequirementOwner] = useState<"student" | "counselor">("student");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId && colleges[0]) setSelectedId(colleges[0].id);
  }, [colleges, selectedId]);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    setError(null);
    try {
      const base = `/api/admissions/cases/${caseId}/colleges/${selectedId}`;
      const [researchResponse, eventsResponse, requirementsResponse] = await Promise.all([
        fetch(`${base}/research`),
        fetch(`${base}/interest-events`),
        fetch(`${base}/requirements`),
      ]);
      const [researchPayload, eventsPayload, requirementsPayload] = await Promise.all([
        researchResponse.json().catch(() => null),
        eventsResponse.json().catch(() => null),
        requirementsResponse.json().catch(() => null),
      ]);
      if (!researchResponse.ok) throw new Error(readError(researchPayload, "Research could not be loaded."));
      if (!eventsResponse.ok) throw new Error(readError(eventsPayload, "Interest events could not be loaded."));
      if (!requirementsResponse.ok) throw new Error(readError(requirementsPayload, "Requirements could not be loaded."));
      const nextResearch = (researchPayload as { research: CollegeResearchDto | null }).research;
      setResearch(nextResearch);
      setResearchForm(researchFormFromDto(nextResearch));
      setEvents((eventsPayload as { events: InterestEventDto[] }).events ?? []);
      setRequirements((requirementsPayload as { requirements: CollegeRequirementDto[] }).requirements ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "College details could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [caseId, selectedId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (selected) setPlanForm(planFormFromCollege(selected)); }, [selected]);

  const savePlan = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError(null); setSaved(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/colleges`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: selected.id, expectedUpdatedAt: selected.updatedAt, firstChoiceMajor: nullable(planForm.firstChoiceMajor), secondChoiceMajor: nullable(planForm.secondChoiceMajor), admissionsUrl: nullable(planForm.admissionsUrl), portalUrl: nullable(planForm.portalUrl) }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "College plan could not be saved."));
      setSaved("College plan saved");
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "College plan could not be saved."); }
    finally { setSaving(false); }
  };

  const saveResearch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError(null); setSaved(null);
    try {
      const sources = researchForm.sourceLabel.trim() ? [{ label: researchForm.sourceLabel.trim(), ...(researchForm.sourceUrl.trim() ? { url: researchForm.sourceUrl.trim() } : {}) }] : [];
      const response = await fetch(`/api/admissions/cases/${caseId}/colleges/${selected.id}/research`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: research?.updatedAt, fitRating: researchForm.fitRating ? Number(researchForm.fitRating) : null, sources, campusVisitDate: researchForm.campusVisitDate || null, campusVisitNotes: nullable(researchForm.campusVisitNotes), academicNotes: nullable(researchForm.academicNotes), opportunities: nullable(researchForm.opportunities), questions: nullable(researchForm.questions), notes: nullable(researchForm.notes) }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Research could not be saved."));
      const next = (payload as { research: CollegeResearchDto }).research;
      setResearch(next); setResearchForm(researchFormFromDto(next)); setSaved("Research saved");
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Research could not be saved."); }
    finally { setSaving(false); }
  };

  const addEvent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError(null); setSaved(null);
    const response = await fetch(`/api/admissions/cases/${caseId}/colleges/${selected.id}/interest-events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: eventType, eventDate, notes: nullable(eventNotes) }) });
    const payload: unknown = await response.json().catch(() => null);
    setSaving(false);
    if (!response.ok) { setError(readError(payload, "Interest event could not be added.")); return; }
    setEventDate(""); setEventNotes(""); setSaved("Interest event added"); await load();
  };

  const removeEvent = async (item: InterestEventDto) => {
    if (!selected || !window.confirm("Remove this demonstrated-interest event?")) return;
    const response = await fetch(`/api/admissions/cases/${caseId}/colleges/${selected.id}/interest-events?eventId=${item.id}`, { method: "DELETE" });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) { setError(readError(payload, "Interest event could not be removed.")); return; }
    await load();
  };

  const addRequirement = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError(null); setSaved(null);
    const response = await fetch(`/api/admissions/cases/${caseId}/colleges/${selected.id}/requirements`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: requirementKind, title: requirementTitle, status: "not_started", owner: requirementOwner, dueDate: requirementDueDate || null, required: true, sourceUrl: null, notes: null, sortOrder: requirements.length }) });
    const payload: unknown = await response.json().catch(() => null);
    setSaving(false);
    if (!response.ok) { setError(readError(payload, "Requirement could not be added.")); return; }
    setRequirementTitle(""); setRequirementDueDate(""); setSaved("Requirement added"); await load();
  };

  const updateRequirementStatus = async (item: CollegeRequirementDto, status: CollegeRequirementDto["status"]) => {
    if (!selected) return;
    const response = await fetch(`/api/admissions/cases/${caseId}/colleges/${selected.id}/requirements`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requirementId: item.id, expectedUpdatedAt: item.updatedAt, status }) });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) { setError(readError(payload, "Requirement status could not be updated.")); return; }
    await load();
  };

  const removeRequirement = async (item: CollegeRequirementDto) => {
    if (!selected || !window.confirm(`Remove “${item.title}”?`)) return;
    const response = await fetch(`/api/admissions/cases/${caseId}/colleges/${selected.id}/requirements?requirementId=${item.id}`, { method: "DELETE" });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) { setError(readError(payload, "Requirement could not be removed.")); return; }
    await load();
  };

  if (colleges.length === 0) return <Card><CardContent><p className="text-sm text-muted-foreground">Add a college before recording research, demonstrated interest, or requirements.</p></CardContent></Card>;

  return (
    <div className="space-y-4" data-testid="college-details-panel">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-base font-semibold">College research &amp; requirements</h2><p className="text-sm text-muted-foreground">One working space for fit research, interest, majors, links, and supplemental requirements.</p></div><label className="w-full space-y-1 text-xs font-medium sm:w-80">College<select className={SELECT_FIELD_CLASSES} value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setSaved(null); }}>{colleges.map((college) => <option key={college.id} value={college.id}>{college.instName}</option>)}</select></label></div>
      {loading ? <Card><CardContent><p className="text-sm text-muted-foreground">Loading {selected?.instName}…</p></CardContent></Card> : null}
      {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
      {saved ? <p role="status" className="text-sm text-available">{saved}</p> : null}
      {!loading && selected ? (
        <>
          <Card><CardHeader><CardTitle>Application plan</CardTitle><CardDescription>Major choices and official admissions links. Counselors own these official fields.</CardDescription></CardHeader><CardContent><form onSubmit={savePlan} className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs font-medium">First-choice major<Input disabled={!isStaff} value={planForm.firstChoiceMajor} onChange={(event) => setPlanForm((current) => ({ ...current, firstChoiceMajor: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Second-choice major<Input disabled={!isStaff} value={planForm.secondChoiceMajor} onChange={(event) => setPlanForm((current) => ({ ...current, secondChoiceMajor: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Admissions URL<Input type="url" disabled={!isStaff} value={planForm.admissionsUrl} onChange={(event) => setPlanForm((current) => ({ ...current, admissionsUrl: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Portal URL <span className="font-normal text-muted-foreground">(never a password)</span><Input type="url" disabled={!isStaff} value={planForm.portalUrl} onChange={(event) => setPlanForm((current) => ({ ...current, portalUrl: event.target.value }))} /></label></div>{isStaff ? <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save application plan"}</Button> : <div className="flex flex-wrap gap-3">{selected.admissionsUrl ? <ExternalLink href={selected.admissionsUrl} label="Admissions site" /> : null}{selected.portalUrl ? <ExternalLink href={selected.portalUrl} label="Application portal" /> : null}</div>}</form></CardContent></Card>

          <Card><CardHeader><CardTitle>Research &amp; fit</CardTitle><CardDescription>Capture sources, fit assessment, visit notes, opportunities, and open questions.</CardDescription></CardHeader><CardContent><form onSubmit={saveResearch} className="space-y-3"><div className="grid gap-3 sm:grid-cols-3"><label className="space-y-1 text-xs font-medium">Fit rating<select className={SELECT_FIELD_CLASSES} disabled={!canContribute} value={researchForm.fitRating} onChange={(event) => setResearchForm((current) => ({ ...current, fitRating: event.target.value }))}><option value="">Not rated</option>{[1,2,3,4,5].map((rating) => <option key={rating} value={rating}>{rating} / 5</option>)}</select></label><label className="space-y-1 text-xs font-medium">Primary source<Input disabled={!canContribute} value={researchForm.sourceLabel} onChange={(event) => setResearchForm((current) => ({ ...current, sourceLabel: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Source URL<Input type="url" disabled={!canContribute} value={researchForm.sourceUrl} onChange={(event) => setResearchForm((current) => ({ ...current, sourceUrl: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Campus visit date<Input type="date" disabled={!canContribute} value={researchForm.campusVisitDate} onChange={(event) => setResearchForm((current) => ({ ...current, campusVisitDate: event.target.value }))} /></label></div><div className="grid gap-3 sm:grid-cols-2"><ResearchTextarea label="Academic notes" field="academicNotes" form={researchForm} setForm={setResearchForm} disabled={!canContribute} /><ResearchTextarea label="Opportunities" field="opportunities" form={researchForm} setForm={setResearchForm} disabled={!canContribute} /><ResearchTextarea label="Campus visit notes" field="campusVisitNotes" form={researchForm} setForm={setResearchForm} disabled={!canContribute} /><ResearchTextarea label="Questions" field="questions" form={researchForm} setForm={setResearchForm} disabled={!canContribute} /><ResearchTextarea label="General fit notes" field="notes" form={researchForm} setForm={setResearchForm} disabled={!canContribute} /></div>{canContribute ? <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save research"}</Button> : null}</form></CardContent></Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Demonstrated interest</CardTitle><CardDescription>Visits, sessions, fairs, interviews, emails, and webinars.</CardDescription></CardHeader><CardContent className="space-y-3">{canContribute ? <form onSubmit={addEvent} className="space-y-2 rounded-lg border border-border/70 p-3"><div className="grid grid-cols-2 gap-2"><select aria-label="Interest event type" className={SELECT_FIELD_CLASSES} value={eventType} onChange={(event) => setEventType(event.target.value as InterestEventType)}>{INTEREST_EVENT_TYPES.map((type) => <option key={type} value={type}>{INTEREST_LABELS[type]}</option>)}</select><Input aria-label="Interest event date" type="date" required value={eventDate} onChange={(event) => setEventDate(event.target.value)} /></div><Input aria-label="Interest event notes" placeholder="Notes" value={eventNotes} onChange={(event) => setEventNotes(event.target.value)} /><Button type="submit" size="xs" disabled={saving}><PlusIcon aria-hidden /> Add event</Button></form> : null}<ul className="space-y-2">{events.map((item) => <li key={item.id} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 p-3"><div><p className="text-sm font-medium">{INTEREST_LABELS[item.type]}</p><p className="text-xs text-muted-foreground">{item.eventDate}</p>{item.notes ? <p className="mt-1 text-sm whitespace-pre-wrap">{item.notes}</p> : null}</div>{canContribute ? <Button size="icon-sm" variant="ghost" aria-label="Remove interest event" onClick={() => void removeEvent(item)}><Trash2Icon aria-hidden /></Button> : null}</li>)}</ul>{events.length === 0 ? <p className="text-sm text-muted-foreground">No interest events yet.</p> : null}</CardContent></Card>

            <Card><CardHeader><CardTitle>Other requirements</CardTitle><CardDescription>Tracks supplemental items without duplicating essays, recommendations, transcripts, or score sends.</CardDescription></CardHeader><CardContent className="space-y-3">{isStaff ? <form onSubmit={addRequirement} className="space-y-2 rounded-lg border border-border/70 p-3"><div className="grid grid-cols-2 gap-2"><select aria-label="Requirement kind" className={SELECT_FIELD_CLASSES} value={requirementKind} onChange={(event) => setRequirementKind(event.target.value as CollegeRequirementKind)}>{COLLEGE_REQUIREMENT_KINDS.map((kind) => <option key={kind} value={kind}>{REQUIREMENT_LABELS[kind]}</option>)}</select><select aria-label="Requirement owner" className={SELECT_FIELD_CLASSES} value={requirementOwner} onChange={(event) => setRequirementOwner(event.target.value as "student" | "counselor")}><option value="student">Student</option><option value="counselor">Counselor</option></select></div><Input aria-label="Requirement title" required placeholder="Requirement title" value={requirementTitle} onChange={(event) => setRequirementTitle(event.target.value)} /><Input aria-label="Requirement due date" type="date" value={requirementDueDate} onChange={(event) => setRequirementDueDate(event.target.value)} /><Button type="submit" size="xs" disabled={saving}><PlusIcon aria-hidden /> Add requirement</Button></form> : null}<ul className="space-y-2">{requirements.map((item) => <li key={item.id} className="rounded-lg border border-border/60 p-3"><div className="flex items-start justify-between gap-2"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{item.title}</p><Badge variant="secondary">{REQUIREMENT_LABELS[item.kind]}</Badge></div><p className="text-xs text-muted-foreground">{item.owner}{item.dueDate ? ` · Due ${item.dueDate}` : ""}</p></div>{isStaff ? <Button size="icon-sm" variant="ghost" aria-label={`Remove ${item.title}`} onClick={() => void removeRequirement(item)}><Trash2Icon aria-hidden /></Button> : null}</div><select aria-label={`${item.title} status`} className={`${SELECT_FIELD_CLASSES} mt-2`} disabled={!canContribute || (viewerRole === "student" && item.owner !== "student")} value={item.status} onChange={(event) => void updateRequirementStatus(item, event.target.value as CollegeRequirementDto["status"])}><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="done">Done</option></select></li>)}</ul>{requirements.length === 0 ? <p className="text-sm text-muted-foreground">No generic requirements yet.</p> : null}</CardContent></Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ResearchTextarea({ label, field, form, setForm, disabled }: { label: string; field: keyof Pick<ResearchForm, "campusVisitNotes" | "academicNotes" | "opportunities" | "questions" | "notes">; form: ResearchForm; setForm: React.Dispatch<React.SetStateAction<ResearchForm>>; disabled: boolean }) {
  return <label className="block space-y-1 text-xs font-medium">{label}<Textarea disabled={disabled} value={form[field]} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} /></label>;
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><ExternalLinkIcon aria-hidden className="size-3.5" />{label}</a>;
}

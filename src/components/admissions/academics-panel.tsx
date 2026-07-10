"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLinkIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

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
import type {
  AdmissionsAcademicRecordDto,
  LegacyAcademicWorksheetDto,
} from "@/lib/admissions/academics";
import type {
  AcademicRecordPayload,
  AdmissionsAcademicSystem,
  AdmissionsCoursePlanItem,
  AdmissionsIbSubject,
  AdmissionsUkSubject,
} from "@/lib/admissions/shared/academics";
import type { CaseRole } from "@/lib/admissions/types";

const SYSTEM_LABELS: Record<AdmissionsAcademicSystem, string> = {
  us: "US GPA / transcript",
  ib: "IB MYP / DP",
  a_level_igcse: "A-level / IGCSE",
};

const COURSE_RIGOR_LABELS = {
  most_demanding: "Most demanding",
  very_demanding: "Very demanding",
  demanding: "Demanding",
  average: "Average",
  not_reported: "Not reported",
} as const;

type CourseRigor = keyof typeof COURSE_RIGOR_LABELS;

interface AcademicFormState {
  system: AdmissionsAcademicSystem;
  effectiveDate: string;
  transcriptUrl: string;
  schoolProfileUrl: string;
  gpaScale: string;
  unweightedGpa: string;
  weightedGpa: string;
  coreGpa: string;
  classRank: string;
  classSize: string;
  courseRigor: "" | CourseRigor;
  fourYearCoursePlan: AdmissionsCoursePlanItem[];
  ibProgram: "myp" | "dp" | "myp_dp";
  ibSubjects: AdmissionsIbSubject[];
  tokGrade: "" | "A" | "B" | "C" | "D" | "E";
  extendedEssayGrade: "" | "A" | "B" | "C" | "D" | "E";
  casCompleted: "" | "yes" | "no";
  predictedTotal: string;
  finalTotal: string;
  ukSubjects: AdmissionsUkSubject[];
  curriculumNotes: string;
}

function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyForm(): AcademicFormState {
  return {
    system: "us",
    effectiveDate: todayDateOnly(),
    transcriptUrl: "",
    schoolProfileUrl: "",
    gpaScale: "4",
    unweightedGpa: "",
    weightedGpa: "",
    coreGpa: "",
    classRank: "",
    classSize: "",
    courseRigor: "",
    fourYearCoursePlan: [],
    ibProgram: "dp",
    ibSubjects: [],
    tokGrade: "",
    extendedEssayGrade: "",
    casCompleted: "",
    predictedTotal: "",
    finalTotal: "",
    ukSubjects: [],
    curriculumNotes: "",
  };
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}

function optionalInteger(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number.parseInt(trimmed, 10) : null;
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

export function buildAcademicPayload(form: AcademicFormState): AcademicRecordPayload {
  const links = {
    transcriptUrl: optionalText(form.transcriptUrl),
    schoolProfileUrl: optionalText(form.schoolProfileUrl),
  };

  if (form.system === "us") {
    return {
      system: "us",
      gpaScale: Number(form.gpaScale),
      unweightedGpa: optionalNumber(form.unweightedGpa),
      weightedGpa: optionalNumber(form.weightedGpa),
      coreGpa: optionalNumber(form.coreGpa),
      classRank: optionalInteger(form.classRank),
      classSize: optionalInteger(form.classSize),
      courseRigor: form.courseRigor || null,
      fourYearCoursePlan: form.fourYearCoursePlan.map((course) => ({
        ...course,
        level: optionalText(course.level ?? ""),
        finalGrade: optionalText(course.finalGrade ?? ""),
      })),
      ...links,
    };
  }

  if (form.system === "ib") {
    return {
      system: "ib",
      program: form.ibProgram,
      subjects: form.ibSubjects,
      tokGrade: form.tokGrade || null,
      extendedEssayGrade: form.extendedEssayGrade || null,
      casCompleted:
        form.casCompleted === "" ? null : form.casCompleted === "yes",
      predictedTotal: optionalInteger(form.predictedTotal),
      finalTotal: optionalInteger(form.finalTotal),
      ...links,
    };
  }

  return {
    system: "a_level_igcse",
    subjects: form.ukSubjects,
    curriculumNotes: optionalText(form.curriculumNotes),
    ...links,
  };
}

function formFromRecord(record: AdmissionsAcademicRecordDto): AcademicFormState {
  const form = emptyForm();
  const payload = record.payload;
  form.system = payload.system;
  form.effectiveDate = record.effectiveDate;
  form.transcriptUrl = payload.transcriptUrl ?? "";
  form.schoolProfileUrl = payload.schoolProfileUrl ?? "";
  if (payload.system === "us") {
    form.gpaScale = String(payload.gpaScale);
    form.unweightedGpa = payload.unweightedGpa == null ? "" : String(payload.unweightedGpa);
    form.weightedGpa = payload.weightedGpa == null ? "" : String(payload.weightedGpa);
    form.coreGpa = payload.coreGpa == null ? "" : String(payload.coreGpa);
    form.classRank = payload.classRank == null ? "" : String(payload.classRank);
    form.classSize = payload.classSize == null ? "" : String(payload.classSize);
    form.courseRigor = payload.courseRigor ?? "";
    form.fourYearCoursePlan = payload.fourYearCoursePlan;
  } else if (payload.system === "ib") {
    form.ibProgram = payload.program;
    form.ibSubjects = payload.subjects;
    form.tokGrade = payload.tokGrade ?? "";
    form.extendedEssayGrade = payload.extendedEssayGrade ?? "";
    form.casCompleted = payload.casCompleted == null ? "" : payload.casCompleted ? "yes" : "no";
    form.predictedTotal = payload.predictedTotal == null ? "" : String(payload.predictedTotal);
    form.finalTotal = payload.finalTotal == null ? "" : String(payload.finalTotal);
  } else {
    form.ukSubjects = payload.subjects;
    form.curriculumNotes = payload.curriculumNotes ?? "";
  }
  return form;
}

function readError(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return fallback;
}

function AcademicSummary({ record }: { record: AdmissionsAcademicRecordDto }) {
  const payload = record.payload;
  return (
    <div className="space-y-3 text-sm">
      {payload.system === "us" ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryField label="Unweighted GPA" value={payload.unweightedGpa == null ? null : `${payload.unweightedGpa} / ${payload.gpaScale}`} />
          <SummaryField label="Weighted GPA" value={payload.weightedGpa ?? null} />
          <SummaryField label="Core GPA" value={payload.coreGpa ?? null} />
          <SummaryField label="Class rank" value={payload.classRank == null ? null : `${payload.classRank}${payload.classSize ? ` of ${payload.classSize}` : ""}`} />
          <SummaryField label="Course rigor" value={payload.courseRigor ? COURSE_RIGOR_LABELS[payload.courseRigor] : null} />
          <SummaryField label="Four-year plan" value={`${payload.fourYearCoursePlan.length} courses`} />
        </dl>
      ) : payload.system === "ib" ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryField label="Program" value={payload.program.toUpperCase().replace("_", " + ")} />
          <SummaryField label="Predicted" value={payload.predictedTotal == null ? null : `${payload.predictedTotal} / 45`} />
          <SummaryField label="Final" value={payload.finalTotal == null ? null : `${payload.finalTotal} / 45`} />
          <SummaryField label="Subjects" value={payload.subjects.length} />
          <SummaryField label="TOK / EE" value={[payload.tokGrade, payload.extendedEssayGrade].filter(Boolean).join(" / ") || null} />
          <SummaryField label="CAS" value={payload.casCompleted == null ? null : payload.casCompleted ? "Complete" : "Not complete"} />
        </dl>
      ) : (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryField label="Subjects" value={payload.subjects.length} />
          <SummaryField label="Qualifications" value={[...new Set(payload.subjects.map((subject) => subject.qualification.toUpperCase().replace("_", " ")))].join(", ") || null} />
          <SummaryField label="Notes" value={payload.curriculumNotes ?? null} />
        </dl>
      )}
      <div className="flex flex-wrap gap-3">
        {payload.transcriptUrl ? <RecordLink href={payload.transcriptUrl} label="Transcript" /> : null}
        {payload.schoolProfileUrl ? <RecordLink href={payload.schoolProfileUrl} label="School profile" /> : null}
      </div>
    </div>
  );
}

function SummaryField({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value ?? "—"}</dd>
    </div>
  );
}

function RecordLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
      <ExternalLinkIcon aria-hidden className="size-3.5" />
      {label}
    </a>
  );
}

function legacyAcademicLabel(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function legacyAcademicValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

function CommonLinks({ form, setForm }: { form: AcademicFormState; setForm: React.Dispatch<React.SetStateAction<AcademicFormState>> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-xs font-medium">
        Transcript link
        <Input type="url" value={form.transcriptUrl} onChange={(event) => setForm((current) => ({ ...current, transcriptUrl: event.target.value }))} placeholder="https://drive.google.com/…" />
      </label>
      <label className="space-y-1 text-xs font-medium">
        School profile link
        <Input type="url" value={form.schoolProfileUrl} onChange={(event) => setForm((current) => ({ ...current, schoolProfileUrl: event.target.value }))} placeholder="https://…" />
      </label>
    </div>
  );
}

function UsFields({ form, setForm }: { form: AcademicFormState; setForm: React.Dispatch<React.SetStateAction<AcademicFormState>> }) {
  const numberFields: Array<[keyof Pick<AcademicFormState, "gpaScale" | "unweightedGpa" | "weightedGpa" | "coreGpa" | "classRank" | "classSize">, string]> = [
    ["gpaScale", "GPA scale"], ["unweightedGpa", "Unweighted GPA"], ["weightedGpa", "Weighted GPA"],
    ["coreGpa", "Core GPA"], ["classRank", "Class rank"], ["classSize", "Class size"],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {numberFields.map(([key, label]) => (
          <label key={key} className="space-y-1 text-xs font-medium">
            {label}
            <Input type="number" min="0" step={key === "classRank" || key === "classSize" ? "1" : "0.01"} required={key === "gpaScale"} value={form[key]} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} />
          </label>
        ))}
        <label className="space-y-1 text-xs font-medium sm:col-span-2">
          Course rigor
          <select className={SELECT_FIELD_CLASSES} value={form.courseRigor} onChange={(event) => setForm((current) => ({ ...current, courseRigor: event.target.value as AcademicFormState["courseRigor"] }))}>
            <option value="">Not set</option>
            {Object.entries(COURSE_RIGOR_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <CoursePlanEditor rows={form.fourYearCoursePlan} onChange={(rows) => setForm((current) => ({ ...current, fourYearCoursePlan: rows }))} />
    </div>
  );
}

function CoursePlanEditor({ rows, onChange }: { rows: AdmissionsCoursePlanItem[]; onChange: (rows: AdmissionsCoursePlanItem[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <legend className="text-sm font-semibold">Four-year course plan</legend>
        <Button type="button" size="xs" variant="outline" onClick={() => onChange([...rows, { gradeLevel: "9", courseTitle: "", level: null, credits: null, finalGrade: null, planned: true }])}>
          <PlusIcon aria-hidden /> Add course
        </Button>
      </div>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">No courses added yet.</p> : null}
      {rows.map((row, index) => (
        <div key={index} className="grid gap-2 rounded-lg border border-border/70 p-2 sm:grid-cols-[6rem_1fr_8rem_7rem_auto]">
          <select aria-label={`Course ${index + 1} grade`} className={SELECT_FIELD_CLASSES} value={row.gradeLevel} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, gradeLevel: event.target.value as AdmissionsCoursePlanItem["gradeLevel"] } : item))}>
            {(["9", "10", "11", "12", "postgraduate"] as const).map((grade) => <option key={grade} value={grade}>Grade {grade === "postgraduate" ? "PG" : grade}</option>)}
          </select>
          <Input aria-label={`Course ${index + 1} title`} placeholder="Course title" required value={row.courseTitle} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, courseTitle: event.target.value } : item))} />
          <Input aria-label={`Course ${index + 1} level`} placeholder="AP / Honors" value={row.level ?? ""} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, level: event.target.value } : item))} />
          <Input aria-label={`Course ${index + 1} grade result`} placeholder="Grade" value={row.finalGrade ?? ""} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, finalGrade: event.target.value } : item))} />
          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove course ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2Icon aria-hidden /></Button>
        </div>
      ))}
    </fieldset>
  );
}

function IbFields({ form, setForm }: { form: AcademicFormState; setForm: React.Dispatch<React.SetStateAction<AcademicFormState>> }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="space-y-1 text-xs font-medium">Program<select className={SELECT_FIELD_CLASSES} value={form.ibProgram} onChange={(event) => setForm((current) => ({ ...current, ibProgram: event.target.value as AcademicFormState["ibProgram"] }))}><option value="myp">MYP</option><option value="dp">DP</option><option value="myp_dp">MYP + DP</option></select></label>
        <label className="space-y-1 text-xs font-medium">Predicted /45<Input type="number" min="0" max="45" value={form.predictedTotal} onChange={(event) => setForm((current) => ({ ...current, predictedTotal: event.target.value }))} /></label>
        <label className="space-y-1 text-xs font-medium">Final /45<Input type="number" min="0" max="45" value={form.finalTotal} onChange={(event) => setForm((current) => ({ ...current, finalTotal: event.target.value }))} /></label>
        <label className="space-y-1 text-xs font-medium">CAS<select className={SELECT_FIELD_CLASSES} value={form.casCompleted} onChange={(event) => setForm((current) => ({ ...current, casCompleted: event.target.value as AcademicFormState["casCompleted"] }))}><option value="">Not set</option><option value="yes">Complete</option><option value="no">Not complete</option></select></label>
        <label className="space-y-1 text-xs font-medium">TOK grade<select className={SELECT_FIELD_CLASSES} value={form.tokGrade} onChange={(event) => setForm((current) => ({ ...current, tokGrade: event.target.value as AcademicFormState["tokGrade"] }))}><option value="">Not set</option>{["A", "B", "C", "D", "E"].map((grade) => <option key={grade}>{grade}</option>)}</select></label>
        <label className="space-y-1 text-xs font-medium">Extended Essay grade<select className={SELECT_FIELD_CLASSES} value={form.extendedEssayGrade} onChange={(event) => setForm((current) => ({ ...current, extendedEssayGrade: event.target.value as AcademicFormState["extendedEssayGrade"] }))}><option value="">Not set</option>{["A", "B", "C", "D", "E"].map((grade) => <option key={grade}>{grade}</option>)}</select></label>
      </div>
      <IbSubjectEditor rows={form.ibSubjects} onChange={(rows) => setForm((current) => ({ ...current, ibSubjects: rows }))} />
    </div>
  );
}

function IbSubjectEditor({ rows, onChange }: { rows: AdmissionsIbSubject[]; onChange: (rows: AdmissionsIbSubject[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <div className="flex items-center justify-between gap-3"><legend className="text-sm font-semibold">IB subjects</legend><Button type="button" size="xs" variant="outline" onClick={() => onChange([...rows, { subject: "", level: "HL", predictedGrade: null, finalGrade: null }])}><PlusIcon aria-hidden /> Add subject</Button></div>
      {rows.map((row, index) => (
        <div key={index} className="grid gap-2 rounded-lg border border-border/70 p-2 sm:grid-cols-[1fr_6rem_7rem_7rem_auto]">
          <Input aria-label={`IB subject ${index + 1}`} placeholder="Subject" required value={row.subject} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, subject: event.target.value } : item))} />
          <select aria-label={`IB subject ${index + 1} level`} className={SELECT_FIELD_CLASSES} value={row.level} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, level: event.target.value as AdmissionsIbSubject["level"] } : item))}><option>MYP</option><option>SL</option><option>HL</option></select>
          <Input aria-label={`IB subject ${index + 1} predicted`} type="number" min="1" max="7" placeholder="Predicted" value={row.predictedGrade ?? ""} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, predictedGrade: event.target.value ? Number(event.target.value) : null } : item))} />
          <Input aria-label={`IB subject ${index + 1} final`} type="number" min="1" max="7" placeholder="Final" value={row.finalGrade ?? ""} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, finalGrade: event.target.value ? Number(event.target.value) : null } : item))} />
          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove IB subject ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2Icon aria-hidden /></Button>
        </div>
      ))}
    </fieldset>
  );
}

function UkFields({ form, setForm }: { form: AcademicFormState; setForm: React.Dispatch<React.SetStateAction<AcademicFormState>> }) {
  return (
    <div className="space-y-4">
      <UkSubjectEditor rows={form.ukSubjects} onChange={(rows) => setForm((current) => ({ ...current, ukSubjects: rows }))} />
      <label className="block space-y-1 text-xs font-medium">Curriculum notes<Textarea value={form.curriculumNotes} onChange={(event) => setForm((current) => ({ ...current, curriculumNotes: event.target.value }))} /></label>
    </div>
  );
}

function UkSubjectEditor({ rows, onChange }: { rows: AdmissionsUkSubject[]; onChange: (rows: AdmissionsUkSubject[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <div className="flex items-center justify-between gap-3"><legend className="text-sm font-semibold">Subjects and grades</legend><Button type="button" size="xs" variant="outline" onClick={() => onChange([...rows, { qualification: "a_level", subject: "", board: "", predictedGrade: null, achievedGrade: null }])}><PlusIcon aria-hidden /> Add subject</Button></div>
      {rows.map((row, index) => (
        <div key={index} className="grid gap-2 rounded-lg border border-border/70 p-2 sm:grid-cols-[8rem_1fr_9rem_7rem_7rem_auto]">
          <select aria-label={`UK subject ${index + 1} qualification`} className={SELECT_FIELD_CLASSES} value={row.qualification} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, qualification: event.target.value as AdmissionsUkSubject["qualification"] } : item))}><option value="igcse">IGCSE</option><option value="as">AS</option><option value="a_level">A-level</option></select>
          <Input aria-label={`UK subject ${index + 1}`} placeholder="Subject" required value={row.subject} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, subject: event.target.value } : item))} />
          <Input aria-label={`UK subject ${index + 1} board`} placeholder="Exam board" required value={row.board} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, board: event.target.value } : item))} />
          <Input aria-label={`UK subject ${index + 1} predicted`} placeholder="Predicted" value={row.predictedGrade ?? ""} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, predictedGrade: event.target.value } : item))} />
          <Input aria-label={`UK subject ${index + 1} achieved`} placeholder="Achieved" value={row.achievedGrade ?? ""} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, achievedGrade: event.target.value } : item))} />
          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove UK subject ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2Icon aria-hidden /></Button>
        </div>
      ))}
    </fieldset>
  );
}

export function AcademicsPanel({ caseId, viewerRole }: { caseId: string; viewerRole: CaseRole }) {
  const canEdit = roleAtLeast(viewerRole, "counselor");
  const [records, setRecords] = useState<AdmissionsAcademicRecordDto[]>([]);
  const [legacyImport, setLegacyImport] = useState<LegacyAcademicWorksheetDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AcademicFormState>(() => emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/academics`);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Academic records could not be loaded."));
      const responsePayload = payload && typeof payload === "object"
        ? payload as { records?: unknown; legacyImport?: unknown }
        : null;
      const next = responsePayload && Array.isArray(responsePayload.records)
        ? responsePayload.records as AdmissionsAcademicRecordDto[]
        : [];
      setRecords(next);
      const imported = responsePayload?.legacyImport;
      setLegacyImport(
        imported && typeof imported === "object" && "payload" in imported && "importedAt" in imported
          ? imported as LegacyAcademicWorksheetDto
          : null,
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Academic records could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  const editingRecord = useMemo(() => records.find((record) => record.id === editingId) ?? null, [editingId, records]);

  const startCreate = () => { setForm(emptyForm()); setEditingId(null); setError(null); setFormOpen(true); };
  const startEdit = (record: AdmissionsAcademicRecordDto) => { setForm(formFromRecord(record)); setEditingId(record.id); setError(null); setFormOpen(true); };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/academics`, {
        method: editingRecord ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingRecord
          ? { recordId: editingRecord.id, expectedUpdatedAt: editingRecord.updatedAt, effectiveDate: form.effectiveDate, payload: buildAcademicPayload(form) }
          : { effectiveDate: form.effectiveDate, payload: buildAcademicPayload(form) }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Academic record could not be saved."));
      setFormOpen(false);
      setEditingId(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Academic record could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (record: AdmissionsAcademicRecordDto) => {
    if (!window.confirm(`Remove the ${SYSTEM_LABELS[record.system]} record dated ${record.effectiveDate}?`)) return;
    setError(null);
    const response = await fetch(`/api/admissions/cases/${caseId}/academics?recordId=${record.id}`, { method: "DELETE" });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) { setError(readError(payload, "Academic record could not be removed.")); return; }
    await load();
  };

  return (
    <div className="space-y-4" data-testid="academics-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-base font-semibold">Academic record</h2><p className="text-sm text-muted-foreground">Official and counselor-verified GPA, curriculum, course rigor, and transcript links.</p></div>
        {canEdit && !formOpen ? <Button size="sm" onClick={startCreate}><PlusIcon aria-hidden /> Add record</Button> : null}
      </div>
      {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
      {legacyImport ? (
        <Card data-testid="legacy-academics-import">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Imported worksheet</Badge>
              <span className="text-sm">Read-only source values</span>
            </CardTitle>
            <CardDescription>
              These labels came from the one-time legacy workbook import. Verify them, then add a structured US, IB, or A-level/IGCSE record above; the archived values remain available for reference.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <details open={records.length === 0}>
              <summary className="cursor-pointer text-sm font-medium">
                Review {Object.keys(legacyImport.payload).length} imported academic fields
              </summary>
              <dl className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(legacyImport.payload)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([key, value]) => (
                    <div key={key} className="min-w-0 rounded-md border border-border/70 bg-muted/20 p-2">
                      <dt className="text-xs text-muted-foreground">{legacyAcademicLabel(key)}</dt>
                      <dd className="mt-0.5 break-words text-sm font-medium">{legacyAcademicValue(value)}</dd>
                    </div>
                  ))}
              </dl>
            </details>
          </CardContent>
        </Card>
      ) : null}
      {formOpen ? (
        <Card>
          <CardHeader><CardTitle>{editingRecord ? "Edit academic record" : "Add academic record"}</CardTitle><CardDescription>Choose the student&apos;s curriculum and capture its validated fields.</CardDescription></CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-medium">Academic system<select className={SELECT_FIELD_CLASSES} value={form.system} disabled={editingRecord !== null} onChange={(event) => setForm((current) => ({ ...current, system: event.target.value as AdmissionsAcademicSystem }))}>{Object.entries(SYSTEM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label className="space-y-1 text-xs font-medium">Effective date<Input type="date" required value={form.effectiveDate} onChange={(event) => setForm((current) => ({ ...current, effectiveDate: event.target.value }))} /></label>
              </div>
              {form.system === "us" ? <UsFields form={form} setForm={setForm} /> : null}
              {form.system === "ib" ? <IbFields form={form} setForm={setForm} /> : null}
              {form.system === "a_level_igcse" ? <UkFields form={form} setForm={setForm} /> : null}
              <CommonLinks form={form} setForm={setForm} />
              <div className="flex gap-2"><Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save record"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setFormOpen(false); setEditingId(null); }} disabled={saving}>Cancel</Button></div>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {loading ? <Card><CardContent><p className="text-sm text-muted-foreground">Loading academic records…</p></CardContent></Card> : null}
      {!loading && records.length === 0 ? <Card><CardContent><p className="text-sm text-muted-foreground">No academic record has been added yet.</p></CardContent></Card> : null}
      <div className="space-y-3">
        {records.map((record) => (
          <Card key={record.id}>
            <CardHeader><CardTitle className="flex flex-wrap items-center gap-2 text-sm"><Badge variant="secondary">{SYSTEM_LABELS[record.system]}</Badge><span>Effective {record.effectiveDate}</span></CardTitle>{canEdit ? <CardAction className="flex gap-1"><Button size="xs" variant="ghost" onClick={() => startEdit(record)}><PencilIcon aria-hidden /> Edit</Button><Button size="icon-sm" variant="ghost" aria-label={`Remove ${SYSTEM_LABELS[record.system]} record`} onClick={() => void remove(record)}><Trash2Icon aria-hidden /></Button></CardAction> : null}</CardHeader>
            <CardContent><AcademicSummary record={record} /></CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

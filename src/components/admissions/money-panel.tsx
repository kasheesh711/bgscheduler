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
  FinancialAidOfferDto,
  ScholarshipDto,
} from "@/lib/admissions/college-details";
import type { AdmissionsCollegeListRowDto } from "@/lib/admissions/colleges";
import {
  SCHOLARSHIP_STATUSES,
  type ScholarshipStatus,
} from "@/lib/admissions/shared/college-details";
import type { CaseRole } from "@/lib/admissions/types";

const SCHOLARSHIP_LABELS: Record<ScholarshipStatus, string> = {
  researching: "Researching",
  planned: "Planned",
  in_progress: "In progress",
  submitted: "Submitted",
  awarded: "Awarded",
  declined: "Declined",
  not_selected: "Not selected",
};

interface ScholarshipFormState {
  listItemId: string;
  name: string;
  provider: string;
  url: string;
  requirements: string;
  deadline: string;
  status: ScholarshipStatus;
  outcome: string;
  offeredAmount: string;
  notes: string;
}

const EMPTY_SCHOLARSHIP: ScholarshipFormState = {
  listItemId: "",
  name: "",
  provider: "",
  url: "",
  requirements: "",
  deadline: "",
  status: "researching",
  outcome: "",
  offeredAmount: "",
  notes: "",
};

interface AidFormState {
  currency: string;
  awardYear: string;
  tuition: string;
  housing: string;
  fees: string;
  otherCosts: string;
  grants: string;
  scholarships: string;
  loans: string;
  workStudyAmount: string;
  netCost: string;
  remainingBalance: string;
  notes: string;
}

function defaultAidForm(): AidFormState {
  return {
    currency: "USD",
    awardYear: String(new Date().getUTCFullYear()),
    tuition: "",
    housing: "",
    fees: "",
    otherCosts: "",
    grants: "",
    scholarships: "",
    loans: "",
    workStudyAmount: "",
    netCost: "",
    remainingBalance: "",
    notes: "",
  };
}

function moneyInput(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function scholarshipFormFromDto(item: ScholarshipDto): ScholarshipFormState {
  return {
    listItemId: item.listItemId ?? "",
    name: item.name,
    provider: item.provider ?? "",
    url: item.url ?? "",
    requirements: item.requirements ?? "",
    deadline: item.deadline ?? "",
    status: item.status,
    outcome: item.outcome ?? "",
    offeredAmount: item.offeredAmount ?? "",
    notes: item.notes ?? "",
  };
}

function aidFormFromDto(item: FinancialAidOfferDto | null): AidFormState {
  if (!item) return defaultAidForm();
  const read = (record: Record<string, number | null>, key: string) => record[key] == null ? "" : String(record[key]);
  return {
    currency: item.currency,
    awardYear: String(item.awardYear),
    tuition: read(item.costBreakdown, "Tuition"),
    housing: read(item.costBreakdown, "Housing and meals"),
    fees: read(item.costBreakdown, "Fees"),
    otherCosts: read(item.costBreakdown, "Other costs"),
    grants: read(item.giftAidBreakdown, "Grants"),
    scholarships: read(item.giftAidBreakdown, "Scholarships"),
    loans: read(item.loanBreakdown, "Loans"),
    workStudyAmount: item.workStudyAmount ?? "",
    netCost: item.netCost ?? "",
    remainingBalance: item.remainingBalance ?? "",
    notes: item.notes ?? "",
  };
}

function readError(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && "error" in payload && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : fallback;
}

function formatMoney(value: number | string | null, currency = "USD"): string {
  if (value == null || value === "") return "—";
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return String(value);
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(number);
}

export function MoneyPanel({
  caseId,
  colleges,
  viewerRole,
}: {
  caseId: string;
  colleges: AdmissionsCollegeListRowDto[];
  viewerRole: CaseRole;
}) {
  const canEditScholarships = roleAtLeast(viewerRole, "student");
  const canEditAid = roleAtLeast(viewerRole, "counselor");
  const [scholarships, setScholarships] = useState<ScholarshipDto[]>([]);
  const [offers, setOffers] = useState<Record<string, FinancialAidOfferDto | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scholarshipForm, setScholarshipForm] = useState<ScholarshipFormState>({ ...EMPTY_SCHOLARSHIP });
  const [scholarshipEditingId, setScholarshipEditingId] = useState<string | null>(null);
  const [scholarshipFormOpen, setScholarshipFormOpen] = useState(false);
  const [aidCollegeId, setAidCollegeId] = useState("");
  const [aidForm, setAidForm] = useState<AidFormState>(() => defaultAidForm());
  const [aidFormOpen, setAidFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const collegeById = useMemo(() => new Map(colleges.map((college) => [college.id, college])), [colleges]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [scholarshipResponse, offerResults] = await Promise.all([
        fetch(`/api/admissions/cases/${caseId}/scholarships`),
        Promise.all(colleges.map(async (college) => {
          const response = await fetch(`/api/admissions/cases/${caseId}/colleges/${college.id}/financial-aid`);
          const payload: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error(readError(payload, `Financial aid for ${college.instName} could not be loaded.`));
          return [college.id, (payload as { offer: FinancialAidOfferDto | null }).offer] as const;
        })),
      ]);
      const scholarshipPayload: unknown = await scholarshipResponse.json().catch(() => null);
      if (!scholarshipResponse.ok) throw new Error(readError(scholarshipPayload, "Scholarships could not be loaded."));
      setScholarships(scholarshipPayload && typeof scholarshipPayload === "object" && "scholarships" in scholarshipPayload && Array.isArray((scholarshipPayload as { scholarships?: unknown }).scholarships)
        ? (scholarshipPayload as { scholarships: ScholarshipDto[] }).scholarships
        : []);
      setOffers(Object.fromEntries(offerResults));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Money records could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [caseId, colleges]);

  useEffect(() => { void load(); }, [load]);

  const editingScholarship = useMemo(() => scholarships.find((item) => item.id === scholarshipEditingId) ?? null, [scholarships, scholarshipEditingId]);

  const startScholarship = (item?: ScholarshipDto) => {
    setScholarshipForm(item ? scholarshipFormFromDto(item) : { ...EMPTY_SCHOLARSHIP });
    setScholarshipEditingId(item?.id ?? null);
    setScholarshipFormOpen(true);
    setError(null);
  };

  const saveScholarship = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const fields = {
      listItemId: scholarshipForm.listItemId || null,
      name: scholarshipForm.name.trim(),
      provider: nullable(scholarshipForm.provider),
      url: nullable(scholarshipForm.url),
      requirements: nullable(scholarshipForm.requirements),
      deadline: scholarshipForm.deadline || null,
      status: scholarshipForm.status,
      notes: nullable(scholarshipForm.notes),
      ...(canEditAid ? {
        outcome: nullable(scholarshipForm.outcome),
        offeredAmount: nullable(scholarshipForm.offeredAmount),
      } : {}),
    };
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/scholarships`, {
        method: editingScholarship ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingScholarship
          ? { scholarshipId: editingScholarship.id, expectedUpdatedAt: editingScholarship.updatedAt, ...fields }
          : fields),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Scholarship could not be saved."));
      setScholarshipFormOpen(false);
      setScholarshipEditingId(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Scholarship could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const removeScholarship = async (item: ScholarshipDto) => {
    if (!window.confirm(`Remove “${item.name}”?`)) return;
    const response = await fetch(`/api/admissions/cases/${caseId}/scholarships?scholarshipId=${item.id}`, { method: "DELETE" });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) { setError(readError(payload, "Scholarship could not be removed.")); return; }
    await load();
  };

  const startAid = (collegeId: string) => {
    setAidCollegeId(collegeId);
    setAidForm(aidFormFromDto(offers[collegeId] ?? null));
    setAidFormOpen(true);
    setError(null);
  };

  const saveAid = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!aidCollegeId) return;
    setSaving(true);
    setError(null);
    const current = offers[aidCollegeId];
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/colleges/${aidCollegeId}/financial-aid`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedUpdatedAt: current?.updatedAt,
          currency: aidForm.currency.toUpperCase(),
          awardYear: Number(aidForm.awardYear),
          costBreakdown: { "Tuition": moneyInput(aidForm.tuition), "Housing and meals": moneyInput(aidForm.housing), "Fees": moneyInput(aidForm.fees), "Other costs": moneyInput(aidForm.otherCosts) },
          giftAidBreakdown: { "Grants": moneyInput(aidForm.grants), "Scholarships": moneyInput(aidForm.scholarships) },
          loanBreakdown: { "Loans": moneyInput(aidForm.loans) },
          workStudyAmount: nullable(aidForm.workStudyAmount),
          netCost: nullable(aidForm.netCost),
          remainingBalance: nullable(aidForm.remainingBalance),
          notes: nullable(aidForm.notes),
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Financial aid could not be saved."));
      setAidFormOpen(false);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Financial aid could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="money-panel">
      <section className="space-y-3" aria-labelledby="aid-comparison-heading">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="aid-comparison-heading" className="text-base font-semibold">Financial aid comparison</h2><p className="text-sm text-muted-foreground">Compare cost of attendance, gift aid, loans, work-study, and remaining family balance.</p></div></div>
        {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
        {loading ? <Card><CardContent><p className="text-sm text-muted-foreground">Loading financial records…</p></CardContent></Card> : null}
        {!loading && colleges.length === 0 ? <Card><CardContent><p className="text-sm text-muted-foreground">Add colleges before recording aid offers.</p></CardContent></Card> : null}
        {!loading && colleges.length > 0 ? (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="min-w-[780px] w-full text-sm">
                <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-4 py-3 font-medium">College</th><th className="px-3 py-3 font-medium">Total COA</th><th className="px-3 py-3 font-medium">Gift aid</th><th className="px-3 py-3 font-medium">Net cost</th><th className="px-3 py-3 font-medium">Loans</th><th className="px-3 py-3 font-medium">Remaining</th>{canEditAid ? <th className="px-3 py-3"><span className="sr-only">Actions</span></th> : null}</tr></thead>
                <tbody>{colleges.map((college) => { const offer = offers[college.id] ?? null; return <tr key={college.id} className="border-b last:border-0"><td className="px-4 py-3 font-medium">{college.instName}</td><td className="px-3 py-3 tabular-nums">{offer ? formatMoney(offer.totalCost, offer.currency) : "—"}</td><td className="px-3 py-3 tabular-nums text-available">{offer ? formatMoney(offer.totalGiftAid, offer.currency) : "—"}</td><td className="px-3 py-3 tabular-nums">{offer ? formatMoney(offer.derivedNetCost, offer.currency) : "—"}</td><td className="px-3 py-3 tabular-nums">{offer ? formatMoney(offer.totalLoans, offer.currency) : "—"}</td><td className="px-3 py-3 tabular-nums font-semibold">{offer ? formatMoney(offer.derivedRemainingBalance, offer.currency) : "—"}</td>{canEditAid ? <td className="px-3 py-3 text-right"><Button size="xs" variant="outline" onClick={() => startAid(college.id)}><PencilIcon aria-hidden /> {offer ? "Edit" : "Add"}</Button></td> : null}</tr>; })}</tbody>
              </table>
            </CardContent>
          </Card>
        ) : null}
        {aidFormOpen ? (
          <Card><CardHeader><CardTitle>{offers[aidCollegeId] ? "Edit" : "Add"} aid offer · {collegeById.get(aidCollegeId)?.instName}</CardTitle><CardDescription>Blank derived totals are calculated from the breakdowns.</CardDescription></CardHeader><CardContent><form onSubmit={saveAid} className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><label className="space-y-1 text-xs font-medium">Currency<Input required pattern="[A-Za-z]{3}" maxLength={3} value={aidForm.currency} onChange={(event) => setAidForm((current) => ({ ...current, currency: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Award year<Input required type="number" min="2000" max="2200" value={aidForm.awardYear} onChange={(event) => setAidForm((current) => ({ ...current, awardYear: event.target.value }))} /></label></div>
            <MoneyFieldset title="Cost of attendance" fields={[["tuition", "Tuition"], ["housing", "Housing & meals"], ["fees", "Fees"], ["otherCosts", "Other costs"]]} form={aidForm} setForm={setAidForm} />
            <MoneyFieldset title="Offer" fields={[["grants", "Grants / gift aid"], ["scholarships", "Institutional scholarships"], ["loans", "Loans"], ["workStudyAmount", "Work-study"]]} form={aidForm} setForm={setAidForm} />
            <MoneyFieldset title="Comparison overrides" fields={[["netCost", "Net cost"], ["remainingBalance", "Remaining balance"]]} form={aidForm} setForm={setAidForm} />
            <label className="block space-y-1 text-xs font-medium">Notes<Textarea value={aidForm.notes} onChange={(event) => setAidForm((current) => ({ ...current, notes: event.target.value }))} /></label>
            <div className="flex gap-2"><Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save aid offer"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setAidFormOpen(false)} disabled={saving}>Cancel</Button></div>
          </form></CardContent></Card>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="scholarships-heading">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="scholarships-heading" className="text-base font-semibold">Scholarships</h2><p className="text-sm text-muted-foreground">Track external and college-linked opportunities from research through outcome.</p></div>{canEditScholarships && !scholarshipFormOpen ? <Button size="sm" onClick={() => startScholarship()}><PlusIcon aria-hidden /> Add scholarship</Button> : null}</div>
        {scholarshipFormOpen ? (
          <Card><CardHeader><CardTitle>{editingScholarship ? "Edit scholarship" : "Add scholarship"}</CardTitle></CardHeader><CardContent><form onSubmit={saveScholarship} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs font-medium">Scholarship name <span aria-hidden className="text-destructive">*</span><Input required value={scholarshipForm.name} onChange={(event) => setScholarshipForm((current) => ({ ...current, name: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Provider<Input value={scholarshipForm.provider} onChange={(event) => setScholarshipForm((current) => ({ ...current, provider: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Related college<select className={SELECT_FIELD_CLASSES} value={scholarshipForm.listItemId} onChange={(event) => setScholarshipForm((current) => ({ ...current, listItemId: event.target.value }))}><option value="">External / not linked</option>{colleges.map((college) => <option key={college.id} value={college.id}>{college.instName}</option>)}</select></label><label className="space-y-1 text-xs font-medium">Link<Input type="url" value={scholarshipForm.url} onChange={(event) => setScholarshipForm((current) => ({ ...current, url: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Deadline<Input type="date" value={scholarshipForm.deadline} onChange={(event) => setScholarshipForm((current) => ({ ...current, deadline: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Status<select className={SELECT_FIELD_CLASSES} value={scholarshipForm.status} onChange={(event) => setScholarshipForm((current) => ({ ...current, status: event.target.value as ScholarshipStatus }))}>{SCHOLARSHIP_STATUSES.map((status) => <option key={status} value={status}>{SCHOLARSHIP_LABELS[status]}</option>)}</select></label>{canEditAid ? <><label className="space-y-1 text-xs font-medium">Offered amount (USD)<Input inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" value={scholarshipForm.offeredAmount} onChange={(event) => setScholarshipForm((current) => ({ ...current, offeredAmount: event.target.value }))} /></label><label className="space-y-1 text-xs font-medium">Outcome<Input value={scholarshipForm.outcome} onChange={(event) => setScholarshipForm((current) => ({ ...current, outcome: event.target.value }))} /></label></> : null}</div>
            <label className="block space-y-1 text-xs font-medium">Requirements<Textarea value={scholarshipForm.requirements} onChange={(event) => setScholarshipForm((current) => ({ ...current, requirements: event.target.value }))} /></label><label className="block space-y-1 text-xs font-medium">Notes<Textarea value={scholarshipForm.notes} onChange={(event) => setScholarshipForm((current) => ({ ...current, notes: event.target.value }))} /></label>
            <div className="flex gap-2"><Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save scholarship"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setScholarshipFormOpen(false); setScholarshipEditingId(null); }} disabled={saving}>Cancel</Button></div>
          </form></CardContent></Card>
        ) : null}
        {scholarships.length === 0 && !loading ? <Card><CardContent><p className="text-sm text-muted-foreground">No scholarships tracked yet.</p></CardContent></Card> : null}
        <div className="grid gap-3 md:grid-cols-2">{scholarships.map((item) => <Card key={item.id}><CardHeader><CardTitle className="flex flex-wrap items-center gap-2 text-sm"><span>{item.name}</span><Badge variant={item.status === "awarded" ? "default" : "secondary"}>{SCHOLARSHIP_LABELS[item.status]}</Badge></CardTitle><CardDescription>{[item.provider, item.deadline].filter(Boolean).join(" · ") || "No provider or deadline"}</CardDescription>{canEditScholarships ? <CardAction className="flex gap-1"><Button size="xs" variant="ghost" onClick={() => startScholarship(item)}><PencilIcon aria-hidden /> Edit</Button><Button size="icon-sm" variant="ghost" aria-label={`Remove ${item.name}`} onClick={() => void removeScholarship(item)}><Trash2Icon aria-hidden /></Button></CardAction> : null}</CardHeader><CardContent className="space-y-2 text-sm">{item.listItemId ? <p className="text-xs text-muted-foreground">{collegeById.get(item.listItemId)?.instName ?? "Linked college"}</p> : null}{item.offeredAmount ? <p className="font-semibold text-available">Offered {formatMoney(item.offeredAmount)}</p> : null}{item.requirements ? <p className="whitespace-pre-wrap">{item.requirements}</p> : null}{item.url ? <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLinkIcon aria-hidden className="size-3.5" /> Open scholarship</a> : null}</CardContent></Card>)}</div>
      </section>
    </div>
  );
}

function MoneyFieldset({ title, fields, form, setForm }: { title: string; fields: Array<[keyof AidFormState, string]>; form: AidFormState; setForm: React.Dispatch<React.SetStateAction<AidFormState>> }) {
  return <fieldset className="space-y-2"><legend className="text-sm font-semibold">{title}</legend><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{fields.map(([key, label]) => <label key={key} className="space-y-1 text-xs font-medium">{label}<Input inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" value={form[key]} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div></fieldset>;
}

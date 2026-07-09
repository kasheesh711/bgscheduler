"use client";

// ----------------------------------------------------------------------------
// Admissions caseload — "New case" dialog (design §5.1, PRD CM-01). Client
// validation mirrors the POST /api/admissions/cases body schema (route.ts
// CreateCaseSchema): student identity, cohort, repeatable parent emails, and
// a counselor selection; the student≠parent rule is enforced here too so the
// form surfaces it before the server does. parseCreateCaseForm is a pure
// exported helper so validation stays unit-testable without a DOM.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { z } from "zod";
import { Loader2, Plus, X } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdmissionsCohortDto, AdmissionsCounselorDto } from "@/lib/admissions/types";

const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address");

/**
 * Client mirror of the POST /api/admissions/cases body schema, plus the
 * counselor/family-overlap rule createCase enforces server-side (Conflict).
 */
export const createCaseFormSchema = z
  .object({
    student: z.object({
      fullName: z.string().trim().min(1, "Student name is required"),
      preferredName: z.string().trim().optional(),
      studentEmail: emailSchema,
      phone: z.string().trim().optional(),
      school: z.string().trim().optional(),
    }),
    cohortId: z.string().uuid("Select a cohort"),
    parentEmails: z.array(emailSchema).max(20, "Too many parent emails"),
    counselorEmails: z.array(emailSchema).min(1, "Select a counselor").max(20),
  })
  .superRefine((value, ctx) => {
    if (value.parentEmails.includes(value.student.studentEmail)) {
      ctx.addIssue({
        code: "custom",
        path: ["parentEmails"],
        message: "A parent email cannot equal the student email",
      });
    }
    if (new Set(value.parentEmails).size !== value.parentEmails.length) {
      ctx.addIssue({
        code: "custom",
        path: ["parentEmails"],
        message: "Duplicate parent emails",
      });
    }
    const familyEmails = new Set([value.student.studentEmail, ...value.parentEmails]);
    if (value.counselorEmails.some((email) => familyEmails.has(email))) {
      ctx.addIssue({
        code: "custom",
        path: ["counselorEmails"],
        message: "A counselor email cannot equal a family email",
      });
    }
  });

/** Raw form state as typed by the user (blank strings allowed everywhere). */
export interface CreateCaseFormValues {
  fullName: string;
  preferredName: string;
  studentEmail: string;
  phone: string;
  school: string;
  cohortId: string;
  parentEmails: string[];
  counselorEmail: string;
}

/** Empty initial form state. */
export const EMPTY_CREATE_CASE_FORM: CreateCaseFormValues = {
  fullName: "",
  preferredName: "",
  studentEmail: "",
  phone: "",
  school: "",
  cohortId: "",
  parentEmails: [],
  counselorEmail: "",
};

/** Validated POST body for /api/admissions/cases. */
export type CreateCasePayload = z.infer<typeof createCaseFormSchema>;

/** parseCreateCaseForm result: payload on success, keyed messages on failure. */
export type CreateCaseFormResult =
  | { ok: true; payload: CreateCasePayload }
  | { ok: false; errors: Record<string, string> };

/**
 * Validates raw form values against createCaseFormSchema (pure).
 *
 * 1. Drop blank parent-email rows and blank optional student fields.
 * 2. Wrap the selected counselor email into counselorEmails (empty selection
 *    → empty array → "Select a counselor").
 * 3. safeParse; on failure collapse issues to one message per dotted path
 *    (first issue wins; array-index issues also populate the parent key so
 *    the UI can show a single row-level message).
 */
export function parseCreateCaseForm(values: CreateCaseFormValues): CreateCaseFormResult {
  const candidate = {
    student: {
      fullName: values.fullName,
      preferredName: values.preferredName.trim() ? values.preferredName : undefined,
      studentEmail: values.studentEmail,
      phone: values.phone.trim() ? values.phone : undefined,
      school: values.school.trim() ? values.school : undefined,
    },
    cohortId: values.cohortId,
    parentEmails: values.parentEmails.filter((email) => email.trim().length > 0),
    counselorEmails: values.counselorEmail.trim() ? [values.counselorEmail] : [],
  };

  const parsed = createCaseFormSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, payload: parsed.data };

  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".") || "form";
    if (!(path in errors)) errors[path] = issue.message;
    const head = String(issue.path[0] ?? "");
    if (issue.path.length > 1 && head && !(head in errors)) {
      errors[head] = issue.message;
    }
  }
  return { ok: false, errors };
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

export interface CreateCaseFormProps {
  cohorts: AdmissionsCohortDto[];
  counselors: AdmissionsCounselorDto[];
  onCreated: () => void;
  onCancel: () => void;
}

/**
 * The create-case form body (rendered inside CreateCaseDialog; exported
 * separately so tests can render it without the dialog portal).
 */
export function CreateCaseForm({ cohorts, counselors, onCreated, onCancel }: CreateCaseFormProps) {
  const [values, setValues] = useState<CreateCaseFormValues>(EMPTY_CREATE_CASE_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const activeCounselors = counselors.filter((counselor) => counselor.active);

  const setField = <K extends keyof CreateCaseFormValues>(
    key: K,
    value: CreateCaseFormValues[K],
  ) => setValues((current) => ({ ...current, [key]: value }));

  const setParentEmail = (index: number, email: string) =>
    setValues((current) => ({
      ...current,
      parentEmails: current.parentEmails.map((value, i) => (i === index ? email : value)),
    }));

  const removeParentEmail = (index: number) =>
    setValues((current) => ({
      ...current,
      parentEmails: current.parentEmails.filter((_, i) => i !== index),
    }));

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setApiError(null);

    const result = parseCreateCaseForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSubmitting(true);

    try {
      const res = await fetch("/api/admissions/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.payload),
      });
      if (res.ok) {
        onCreated();
        return;
      }
      if (res.status === 409) {
        setApiError(
          "Conflict — this student already has a live case, or an email is reused across roles.",
        );
        return;
      }
      const data: { error?: unknown } = await res.json().catch(() => ({}));
      setApiError(
        typeof data.error === "string" ? data.error : "Case creation failed. Please try again.",
      );
    } catch {
      setApiError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="create-case-full-name" className="text-xs font-medium text-muted-foreground">
            Student name *
          </label>
          <Input
            id="create-case-full-name"
            value={values.fullName}
            onChange={(event) => setField("fullName", event.target.value)}
            placeholder="Full name"
            aria-invalid={errors["student.fullName"] ? true : undefined}
          />
          <FieldError message={errors["student.fullName"]} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="create-case-preferred-name" className="text-xs font-medium text-muted-foreground">
            Preferred name
          </label>
          <Input
            id="create-case-preferred-name"
            value={values.preferredName}
            onChange={(event) => setField("preferredName", event.target.value)}
            placeholder="Nickname"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="create-case-student-email" className="text-xs font-medium text-muted-foreground">
            Student email *
          </label>
          <Input
            id="create-case-student-email"
            type="email"
            value={values.studentEmail}
            onChange={(event) => setField("studentEmail", event.target.value)}
            placeholder="student@email.com"
            aria-invalid={errors["student.studentEmail"] ? true : undefined}
          />
          <FieldError message={errors["student.studentEmail"]} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="create-case-school" className="text-xs font-medium text-muted-foreground">
            School
          </label>
          <Input
            id="create-case-school"
            value={values.school}
            onChange={(event) => setField("school", event.target.value)}
            placeholder="Current school"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Cohort *</label>
          <Select
            value={values.cohortId === "" ? null : values.cohortId}
            onValueChange={(value) => setField("cohortId", (value as string | null) ?? "")}
          >
            <SelectTrigger className="w-full bg-background" aria-label="Cohort">
              <SelectValue placeholder="Select a cohort" />
            </SelectTrigger>
            <SelectContent>
              {cohorts.map((cohort) => (
                <SelectItem key={cohort.id} value={cohort.id}>
                  {cohort.name} · {cohort.graduationYear}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={errors["cohortId"]} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Counselor *</label>
          <Select
            value={values.counselorEmail === "" ? null : values.counselorEmail}
            onValueChange={(value) => setField("counselorEmail", (value as string | null) ?? "")}
          >
            <SelectTrigger className="w-full bg-background" aria-label="Counselor">
              <SelectValue placeholder="Select a counselor" />
            </SelectTrigger>
            <SelectContent>
              {activeCounselors.map((counselor) => (
                <SelectItem key={counselor.id} value={counselor.email}>
                  {counselor.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={errors["counselorEmails"]} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Parent emails</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setField("parentEmails", [...values.parentEmails, ""])}
          >
            <Plus aria-hidden className="size-3" />
            Add parent
          </Button>
        </div>
        {values.parentEmails.length === 0 ? (
          <p className="text-xs text-muted-foreground">No parent emails added yet.</p>
        ) : (
          values.parentEmails.map((email, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                type="email"
                aria-label={`Parent email ${index + 1}`}
                value={email}
                onChange={(event) => setParentEmail(index, event.target.value)}
                placeholder="parent@email.com"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove parent email ${index + 1}`}
                onClick={() => removeParentEmail(index)}
              >
                <X aria-hidden />
              </Button>
            </div>
          ))
        )}
        <FieldError message={errors["parentEmails"]} />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="create-case-phone" className="text-xs font-medium text-muted-foreground">
          Phone
        </label>
        <Input
          id="create-case-phone"
          value={values.phone}
          onChange={(event) => setField("phone", event.target.value)}
          placeholder="Optional"
        />
      </div>

      {apiError ? (
        <div className="rounded-md border border-conflict/30 bg-conflict/10 px-3 py-2 text-sm text-conflict" role="alert">
          {apiError}
        </div>
      ) : null}

      <DialogFooter className="mt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
          {submitting ? "Creating…" : "Create case"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface CreateCaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cohorts: AdmissionsCohortDto[];
  counselors: AdmissionsCounselorDto[];
  onCreated: () => void;
}

/** Controlled "New case" dialog; form state resets whenever it reopens. */
export function CreateCaseDialog({
  open,
  onOpenChange,
  cohorts,
  counselors,
  onCreated,
}: CreateCaseDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New case</DialogTitle>
          <DialogDescription>
            Create an admissions case: student, cohort, parent emails, and the owning counselor.
          </DialogDescription>
        </DialogHeader>
        <CreateCaseForm
          key={open ? "open" : "closed"}
          cohorts={cohorts}
          counselors={counselors}
          onCreated={onCreated}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

"use client";

// ----------------------------------------------------------------------------
// Admissions counselor registry manager (design §3 — admissions_counselors).
// Renders the FULL registry (active and inactive rows) as a table with an
// inline add form, per-row rename, and deactivate/reactivate controls. The
// registry grants counselor sign-in capability, so Deactivate is guarded by
// a confirmation dialog (destructive-action rule); Reactivate is a plain
// action.
//
// Role gate: none client-side — a wiring shell mounts this on an admin-only
// surface and the API re-resolves admin rights from Postgres on every write
// (requireAdmissionsAdmin, design §2.2). Mutations POST/PATCH
// /api/admissions/counselors then router.refresh() so the server-fetched
// registry re-hydrates.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { UsersIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AdmissionsCounselorDto } from "@/lib/admissions/types";

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** Counselor add-form model; email is normalized on submit, not on type. */
export interface CounselorFormValues {
  email: string;
  name: string;
}

/** Blank add form. */
export const EMPTY_COUNSELOR_FORM: CounselorFormValues = { email: "", name: "" };

// Pragmatic email shape check mirroring the route's z.string().email()
// (which re-validates on every request): local part, @, dotted domain.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** buildCounselorPayload result — a ready request body or an inline error. */
export type CounselorPayloadResult =
  | { ok: true; body: { email: string; name: string } }
  | { ok: false; error: string };

/**
 * Validates the add form and builds the POST body. The email is trimmed and
 * lowercased (the registry keys rows by lowercase email) and the name must
 * be non-empty after trimming — mirroring the route's Zod schema.
 */
export function buildCounselorPayload(form: CounselorFormValues): CounselorPayloadResult {
  const email = form.email.trim().toLowerCase();
  const name = form.name.trim();
  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (!name) return { ok: false, error: "Counselor name is required." };
  return { ok: true, body: { email, name } };
}

/** Outcome of one counselor mutation request. */
export type CounselorMutationResult = { ok: true } | { ok: false; error: string };

function readErrorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return fallback;
}

async function sendCounselorRequest(
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
  fallback: string,
): Promise<CounselorMutationResult> {
  try {
    const response = await fetch("/api/admissions/counselors", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: readErrorMessage(payload, fallback) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : fallback };
  }
}

/**
 * Add flow — POST creates (or upserts by lowercase email) an active registry
 * row. Validates client-side first; an invalid form never reaches the wire.
 */
export async function requestCounselorCreate(
  form: CounselorFormValues,
): Promise<CounselorMutationResult> {
  const result = buildCounselorPayload(form);
  if (!result.ok) return { ok: false, error: result.error };
  return sendCounselorRequest(
    "POST",
    { ...result.body, active: true },
    "Failed to add the counselor.",
  );
}

/**
 * Rename flow — PATCH upsert with the CURRENT active flag preserved (the
 * route's update variant requires an explicit `active`; it never guesses).
 */
export async function requestCounselorRename(
  counselor: Pick<AdmissionsCounselorDto, "email" | "active">,
  name: string,
): Promise<CounselorMutationResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Counselor name is required." };
  return sendCounselorRequest(
    "PATCH",
    { email: counselor.email, name: trimmed, active: counselor.active },
    "Failed to rename the counselor.",
  );
}

/**
 * Deactivate flow — PATCH `{ email, active: false }` (the route's pure
 * deactivation variant). Revokes counselor sign-in capability immediately.
 */
export async function requestCounselorDeactivate(
  email: string,
): Promise<CounselorMutationResult> {
  return sendCounselorRequest(
    "PATCH",
    { email, active: false },
    "Failed to deactivate the counselor.",
  );
}

/**
 * Reactivate flow — PATCH `{ email, name, active: true }` (the route's
 * upsert variant, re-sending the existing name). Restores sign-in capability.
 */
export async function requestCounselorReactivate(
  counselor: Pick<AdmissionsCounselorDto, "email" | "name">,
): Promise<CounselorMutationResult> {
  return sendCounselorRequest(
    "PATCH",
    { email: counselor.email, name: counselor.name, active: true },
    "Failed to reactivate the counselor.",
  );
}

// ── Registry row ────────────────────────────────────────────────────────

/** Props for one registry row. Hook-free so tests can invoke it directly. */
export interface CounselorRowProps {
  counselor: AdmissionsCounselorDto;
  busy: boolean;
  editing: boolean;
  /** Draft name while `editing` (state lives in the manager). */
  editName: string;
  onEditNameChange: (name: string) => void;
  onStartEdit: (counselor: AdmissionsCounselorDto) => void;
  onCancelEdit: () => void;
  onSaveEdit: (counselor: AdmissionsCounselorDto) => void;
  /** Opens the shared deactivate-confirmation dialog (never fires directly). */
  onRequestDeactivate: (counselor: AdmissionsCounselorDto) => void;
  onReactivate: (counselor: AdmissionsCounselorDto) => void;
}

/**
 * One counselor registry row: name (or the inline rename form), email,
 * Active/Inactive badge, and the row actions. Inactive rows render muted.
 */
export function CounselorRow({
  counselor,
  busy,
  editing,
  editName,
  onEditNameChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRequestDeactivate,
  onReactivate,
}: CounselorRowProps) {
  return (
    <TableRow
      data-testid={`counselor-row-${counselor.id}`}
      className={counselor.active ? undefined : "text-muted-foreground"}
    >
      <TableCell>
        {editing ? (
          <form
            data-testid={`counselor-edit-form-${counselor.id}`}
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onSaveEdit(counselor);
            }}
          >
            <label className="flex items-center gap-2 text-xs font-medium text-foreground">
              Name
              <Input
                value={editName}
                onChange={(event) => onEditNameChange(event.target.value)}
                className="h-8 w-40"
              />
            </label>
            <Button
              type="submit"
              size="sm"
              data-testid={`counselor-save-${counselor.id}`}
              disabled={editName.trim().length === 0 || busy}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancelEdit}>
              Cancel
            </Button>
          </form>
        ) : (
          <span className="font-medium">{counselor.name}</span>
        )}
      </TableCell>
      <TableCell>{counselor.email}</TableCell>
      <TableCell>
        {counselor.active ? (
          <Badge variant="secondary">Active</Badge>
        ) : (
          <Badge variant="outline">Inactive</Badge>
        )}
      </TableCell>
      <TableCell>
        {editing ? null : (
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`counselor-edit-${counselor.id}`}
              disabled={busy}
              onClick={() => onStartEdit(counselor)}
            >
              Edit name
            </Button>
            {counselor.active ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid={`counselor-deactivate-${counselor.id}`}
                className="text-destructive"
                disabled={busy}
                onClick={() => onRequestDeactivate(counselor)}
              >
                Deactivate
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid={`counselor-reactivate-${counselor.id}`}
                disabled={busy}
                onClick={() => onReactivate(counselor)}
              >
                Reactivate
              </Button>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

// ── Manager ─────────────────────────────────────────────────────────────

/** Props for CounselorsManager — the registry is server-fetched (admin only). */
export interface CounselorsManagerProps {
  /** Full counselor registry, active AND inactive rows. */
  counselors: AdmissionsCounselorDto[];
}

/**
 * Counselor registry manager (admin settings surface). Table of every
 * registry row with an add form, inline rename, and deactivate/reactivate.
 * Deactivation revokes staff sign-in instantly (rights are re-resolved from
 * Postgres per request), so it is guarded by a confirmation dialog — one
 * stray tap must never lock a counselor out. Successful mutations reset the
 * relevant form and router.refresh() so the server registry re-hydrates.
 */
export function CounselorsManager({ counselors }: CounselorsManagerProps) {
  const router = useRouter();

  const [addForm, setAddForm] = useState<CounselorFormValues>(EMPTY_COUNSELOR_FORM);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeactivate, setPendingDeactivate] =
    useState<AdmissionsCounselorDto | null>(null);

  const canSubmitAdd = buildCounselorPayload(addForm).ok;

  const handleCreate = useCallback(async () => {
    setSaving(true);
    setError(null);
    const result = await requestCounselorCreate(addForm);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAddForm(EMPTY_COUNSELOR_FORM);
    router.refresh();
  }, [addForm, router]);

  const handleSaveEdit = useCallback(
    async (counselor: AdmissionsCounselorDto) => {
      setBusyId(counselor.id);
      setError(null);
      const result = await requestCounselorRename(counselor, editName);
      setBusyId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditingId(null);
      router.refresh();
    },
    [editName, router],
  );

  /** Runs only from the confirmation dialog — never from the row button. */
  const handleDeactivateConfirmed = useCallback(async () => {
    const counselor = pendingDeactivate;
    if (!counselor) return;
    setBusyId(counselor.id);
    setError(null);
    const result = await requestCounselorDeactivate(counselor.email);
    setBusyId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPendingDeactivate(null);
    router.refresh();
  }, [pendingDeactivate, router]);

  const handleReactivate = useCallback(
    async (counselor: AdmissionsCounselorDto) => {
      setBusyId(counselor.id);
      setError(null);
      const result = await requestCounselorReactivate(counselor);
      setBusyId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    },
    [router],
  );

  return (
    <Card data-testid="counselors-manager">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <UsersIcon aria-hidden className="size-4" />
          Counselors
        </CardTitle>
        <CardDescription>
          The counselor registry — active rows can sign in to the staff workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          data-testid="counselor-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
          className="space-y-3 rounded-lg border border-border/60 p-3"
        >
          <p className="text-sm font-medium text-foreground">Add a counselor</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-xs font-medium text-foreground">
              Email
              <span aria-hidden className="text-destructive">
                {" "}
                *
              </span>
              <Input
                type="email"
                placeholder="name@example.com"
                value={addForm.email}
                onChange={(event) => setAddForm({ ...addForm, email: event.target.value })}
              />
            </label>
            <label className="block space-y-1 text-xs font-medium text-foreground">
              Name
              <span aria-hidden className="text-destructive">
                {" "}
                *
              </span>
              <Input
                value={addForm.name}
                onChange={(event) => setAddForm({ ...addForm, name: event.target.value })}
              />
            </label>
          </div>
          <Button
            type="submit"
            size="sm"
            data-testid="counselor-submit"
            disabled={!canSubmitAdd || saving}
          >
            {saving ? "Adding…" : "Add counselor"}
          </Button>
        </form>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {counselors.length > 0 ? (
          <Table data-testid="counselors-table">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {counselors.map((counselor) => (
                <CounselorRow
                  key={counselor.id}
                  counselor={counselor}
                  busy={busyId === counselor.id}
                  editing={editingId === counselor.id}
                  editName={editName}
                  onEditNameChange={setEditName}
                  onStartEdit={(target) => {
                    setEditingId(target.id);
                    setEditName(target.name);
                  }}
                  onCancelEdit={() => setEditingId(null)}
                  onSaveEdit={(target) => void handleSaveEdit(target)}
                  onRequestDeactivate={setPendingDeactivate}
                  onReactivate={(target) => void handleReactivate(target)}
                />
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">
            No counselors yet. Add the first one above.
          </p>
        )}

        {/* ── Deactivate confirmation (destructive action guard) ── */}
        <Dialog
          open={pendingDeactivate !== null}
          onOpenChange={(open) => {
            if (!open) setPendingDeactivate(null);
          }}
        >
          <DialogContent data-testid="counselor-deactivate-dialog">
            <DialogHeader>
              <DialogTitle>Deactivate this counselor?</DialogTitle>
              <DialogDescription>
                {pendingDeactivate
                  ? `${pendingDeactivate.name} (${pendingDeactivate.email}) will lose staff sign-in immediately. Their case assignments are kept, and you can reactivate them later.`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPendingDeactivate(null)}
                disabled={busyId !== null}
              >
                Keep active
              </Button>
              <Button
                variant="destructive"
                size="sm"
                data-testid="counselor-deactivate-confirm"
                onClick={() => void handleDeactivateConfirmed()}
                disabled={busyId !== null}
              >
                {busyId !== null ? "Deactivating…" : "Deactivate"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

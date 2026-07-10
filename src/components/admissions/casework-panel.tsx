"use client";

// ----------------------------------------------------------------------------
// Counselor case operations: lifecycle, case links, people/access, and the
// admin-only audit trail. The panel intentionally talks only to the existing
// case, members, and audit routes. Every successful mutation refreshes the
// server-rendered case DTO; the route remains the authorization boundary.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ExternalLinkIcon,
  FolderOpenIcon,
  HistoryIcon,
  MailPlusIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserPlusIcon,
  UserRoundXIcon,
  UsersIcon,
} from "lucide-react";

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { WorkbookImportWizard } from "@/components/admissions/workbook-import-wizard";
import {
  CASE_STATUS_BADGE_CLASSES,
  CASE_STATUS_LABELS,
} from "@/components/admissions/case-status";
import { cn } from "@/lib/utils";
import type {
  AdmissionsAuditLogEntryDto,
  AdmissionsAuditLogPage,
} from "@/lib/admissions/audit";
import type {
  AdmissionsCaseStatus,
  AdmissionsMemberDto,
  AdmissionsMemberStatus,
  CaseRole,
} from "@/lib/admissions/types";
import { normalizeAdmissionsUrl } from "@/lib/admissions/shared/urls";

// ── Shared request helpers ──────────────────────────────────────────────

export type CaseworkRequestResult =
  | { ok: true }
  | { ok: false; error: string; conflict?: boolean };

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

async function sendJson(
  url: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
  fallback: string,
): Promise<CaseworkRequestResult> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        error: readErrorMessage(payload, fallback),
        conflict: response.status === 409,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : fallback,
    };
  }
}

export async function requestMemberAdd(input: {
  caseId: string;
  email: string;
  role: "parent" | "counselor";
}): Promise<CaseworkRequestResult> {
  const result = await sendJson(
    `/api/admissions/cases/${input.caseId}/members`,
    "POST",
    { email: input.email.trim().toLowerCase(), role: input.role },
    "Failed to add this person.",
  );
  if (!result.ok && result.conflict) {
    return {
      ...result,
      error: "This email is already on the case or conflicts with the student's login email.",
    };
  }
  return result;
}

type MemberActionRequest =
  | { caseId: string; action: "revoke"; memberId: string }
  | {
      caseId: string;
      action: "reinvite";
      memberId: string;
      expectedUpdatedAt: string;
    }
  | {
      caseId: string;
      action: "change_email";
      memberId: string;
      newEmail: string;
    };

export async function requestMemberAction(
  input: MemberActionRequest,
): Promise<CaseworkRequestResult> {
  const result = await sendJson(
    `/api/admissions/cases/${input.caseId}/members`,
    "PATCH",
    {
      action: input.action,
      memberId: input.memberId,
      ...(input.action === "change_email"
        ? { newEmail: input.newEmail.trim().toLowerCase() }
        : {}),
      ...(input.action === "reinvite"
        ? { expectedUpdatedAt: input.expectedUpdatedAt }
        : {}),
    },
    "Failed to update this person's access.",
  );
  if (!result.ok && result.conflict) {
    const conflictMessage = input.action === "change_email"
      ? "That email already belongs to this case or cannot be used for this role."
      : input.action === "reinvite"
        ? "Only invited or bounced memberships can be re-invited."
        : "This membership can no longer be revoked.";
    return { ...result, error: conflictMessage };
  }
  return result;
}

/**
 * Existing member POST semantics reinstate a revoked parent/counselor row in
 * place. Student membership is case-created and therefore deliberately not
 * accepted by this helper or the route.
 */
export async function requestMemberReactivate(input: {
  caseId: string;
  member: AdmissionsMemberDto;
}): Promise<CaseworkRequestResult> {
  if (input.member.role === "student") {
    return {
      ok: false,
      error: "Student access cannot be recreated from the add-member route.",
    };
  }
  return requestMemberAdd({
    caseId: input.caseId,
    email: input.member.email,
    role: input.member.role,
  });
}

export async function requestLifecycleChange(input: {
  caseId: string;
  status: AdmissionsCaseStatus;
  expectedUpdatedAt: string;
}): Promise<CaseworkRequestResult> {
  const result = await sendJson(
    `/api/admissions/cases/${input.caseId}`,
    "PATCH",
    { status: input.status, expectedUpdatedAt: input.expectedUpdatedAt },
    "Failed to update the case lifecycle.",
  );
  if (!result.ok && result.conflict) {
    return {
      ...result,
      error: "This case changed in another session. Refresh and review the latest status before trying again.",
    };
  }
  return result;
}

export async function requestDriveFolderChange(input: {
  caseId: string;
  driveFolder: string | null;
  expectedUpdatedAt: string;
}): Promise<CaseworkRequestResult> {
  const result = await sendJson(
    `/api/admissions/cases/${input.caseId}`,
    "PATCH",
    {
      driveFolder: input.driveFolder,
      expectedUpdatedAt: input.expectedUpdatedAt,
    },
    "Failed to save the Drive folder.",
  );
  if (!result.ok && result.conflict) {
    return {
      ...result,
      error: "This case changed in another session. Refresh before saving the folder again.",
    };
  }
  return result;
}

export async function requestExternalLinksChange(input: {
  caseId: string;
  externalLinks: Record<string, string>;
  expectedUpdatedAt: string;
}): Promise<CaseworkRequestResult> {
  const result = await sendJson(
    `/api/admissions/cases/${input.caseId}`,
    "PATCH",
    {
      student: { externalLinks: input.externalLinks },
      expectedUpdatedAt: input.expectedUpdatedAt,
    },
    "Failed to save the external links.",
  );
  if (!result.ok && result.conflict) {
    return {
      ...result,
      error: "This case changed in another session. Refresh before saving the links again.",
    };
  }
  return result;
}

export async function requestFamilyPortalChange(input: {
  caseId: string;
  familyPortalOpen: boolean;
  expectedUpdatedAt: string;
}): Promise<CaseworkRequestResult> {
  const result = await sendJson(
    `/api/admissions/cases/${input.caseId}`,
    "PATCH",
    {
      familyPortalOpen: input.familyPortalOpen,
      expectedUpdatedAt: input.expectedUpdatedAt,
    },
    "Failed to update the family portal.",
  );
  if (!result.ok && result.conflict) {
    return {
      ...result,
      error: "This case changed in another session. Refresh before changing family access.",
    };
  }
  return result;
}

// ── Pure display/validation helpers ────────────────────────────────────

export interface LifecycleAction {
  status: AdmissionsCaseStatus;
  label: string;
  description: string;
  destructive: boolean;
}

/**
 * Only explicit non-commit lifecycle actions are offered here. The active →
 * committed transition is intentionally performed by recording the final
 * college in Applications, keeping the college pointer and event canonical.
 */
export function getLifecycleActions(
  status: AdmissionsCaseStatus,
): readonly LifecycleAction[] {
  switch (status) {
    case "active":
      return [
        {
          status: "withdrawn",
          label: "Mark withdrawn",
          description: "Close family access because the student is no longer applying with BeGifted.",
          destructive: true,
        },
      ];
    case "committed":
      return [
        {
          status: "completed",
          label: "Mark completed",
          description: "Finish active casework after the student's commitment is settled.",
          destructive: false,
        },
      ];
    case "completed":
    case "withdrawn":
      return [
        {
          status: "archived",
          label: "Archive case",
          description: "Remove the case from normal operational views.",
          destructive: true,
        },
      ];
    case "archived":
      return [];
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateMemberEmail(value: string): string | null {
  return EMAIL_PATTERN.test(value.trim().toLowerCase())
    ? null
    : "Enter a valid email address.";
}

/** Blank clears the value; non-blank links must be absolute http(s) URLs. */
export function normalizeCaseLink(value: string):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  try {
    const parsed = normalizeAdmissionsUrl(trimmed, "link");
    if (!parsed) return { ok: true, value: null };
    return { ok: true, value: parsed };
  } catch {
    return {
      ok: false,
      error: "Enter a complete http(s) link without a username or password.",
    };
  }
}

export interface DisplayExternalLink {
  key: string;
  label: string;
  url: string;
}

function prettifyLinkLabel(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return spaced
    ? spaced.replace(/\b\w/g, (character) => character.toUpperCase())
    : "External link";
}

/** Unknown/non-string/non-http values stay hidden instead of becoming links. */
export function getDisplayExternalLinks(
  externalLinks: Record<string, unknown>,
): DisplayExternalLink[] {
  return Object.entries(externalLinks).flatMap(([key, value]) => {
    if (typeof value !== "string") return [];
    const normalized = normalizeCaseLink(value);
    if (!normalized.ok || normalized.value === null) return [];
    return [{ key, label: prettifyLinkLabel(key), url: normalized.value }];
  });
}

export interface ExternalLinkDraft {
  key: string;
  url: string;
}

export function normalizeExternalLinkDrafts(drafts: readonly ExternalLinkDraft[]):
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string } {
  if (drafts.length > 20) {
    return { ok: false, error: "Keep at most 20 external links." };
  }
  const value: Record<string, string> = {};
  for (const draft of drafts) {
    const key = draft.key.trim().replace(/\s+/g, "_");
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key)) {
      return {
        ok: false,
        error: "Link names must start with a letter and use only letters, numbers, spaces, _ or -.",
      };
    }
    if (Object.hasOwn(value, key)) {
      return { ok: false, error: `Link name “${draft.key.trim()}” is duplicated.` };
    }
    const normalized = normalizeCaseLink(draft.url);
    if (!normalized.ok || normalized.value === null) {
      return {
        ok: false,
        error: normalized.ok ? "Every link needs a URL." : normalized.error,
      };
    }
    value[key] = normalized.value;
  }
  return { ok: true, value };
}

const MEMBER_STATUS_LABELS: Record<AdmissionsMemberStatus, string> = {
  invited: "Invited",
  active: "Active",
  revoked: "Revoked",
  bounced: "Bounced",
};

const MEMBER_STATUS_CLASSES: Record<AdmissionsMemberStatus, string> = {
  invited: "bg-primary/10 text-primary",
  active: "bg-available/15 text-available",
  revoked: "bg-muted text-muted-foreground",
  bounced: "bg-conflict/10 text-conflict",
};

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

// ── Audit viewer ───────────────────────────────────────────────────────

function AuditEntry({ entry }: { entry: AdmissionsAuditLogEntryDto }) {
  const fields = Object.entries(entry.diff ?? {});
  return (
    <li className="border-b border-border/70 py-3 last:border-b-0" data-testid="audit-entry">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div>
          <p className="text-sm font-medium text-foreground">
            {humanize(entry.action)} · {humanize(entry.entityType)}
          </p>
          <p className="text-xs text-muted-foreground">
            {entry.actorEmail} ({humanize(entry.actorRole)})
          </p>
        </div>
        <time className="text-xs tabular-nums text-muted-foreground" dateTime={entry.createdAt}>
          {formatTimestamp(entry.createdAt)}
        </time>
      </div>
      {fields.length > 0 ? (
        <dl className="mt-2 grid gap-1.5">
          {fields.map(([field, change]) => (
            <div key={field} className="grid gap-0.5 text-xs sm:grid-cols-[9rem_1fr] sm:gap-2">
              <dt className="font-medium text-muted-foreground">{humanize(field)}</dt>
              <dd className="min-w-0 break-words text-foreground">
                <span className="line-through opacity-60">{formatAuditValue(change.old)}</span>
                <span aria-hidden className="px-1.5 text-muted-foreground">→</span>
                <span>{formatAuditValue(change.new)}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

function AuditHistory({
  caseId,
  reloadVersion,
}: {
  caseId: string;
  reloadVersion: number;
}) {
  const [page, setPage] = useState(1);
  const [auditPage, setAuditPage] = useState<AdmissionsAuditLogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/admissions/audit/${caseId}?page=${page}&pageSize=25`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(readErrorMessage(payload, "Failed to load audit history."));
        }
        return payload as AdmissionsAuditLogPage;
      })
      .then((payload) => setAuditPage(payload))
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Failed to load audit history.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [caseId, page, reloadVersion, retryVersion]);

  const lastPage = auditPage
    ? Math.max(1, Math.ceil(auditPage.totalCount / auditPage.pageSize))
    : 1;

  return (
    <Card data-testid="audit-history">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HistoryIcon aria-hidden className="size-4" />
          Audit history
        </CardTitle>
        <CardDescription>
          Append-only record of case and access changes. Visible to admins only.
        </CardDescription>
        <CardAction>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh audit history"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setError(null);
              setRetryVersion((current) => current + 1);
            }}
          >
            <RefreshCwIcon aria-hidden />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading audit history…</p>
        ) : error ? (
          <div className="flex flex-wrap items-center justify-between gap-2" role="alert">
            <p className="text-sm text-destructive">{error}</p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setLoading(true);
                setError(null);
                setRetryVersion((current) => current + 1);
              }}
            >
              <RefreshCwIcon aria-hidden /> Retry
            </Button>
          </div>
        ) : auditPage && auditPage.entries.length > 0 ? (
          <>
            <ul>{auditPage.entries.map((entry) => <AuditEntry key={entry.id} entry={entry} />)}</ul>
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                Page {page} of {lastPage} · {auditPage.totalCount} events
              </p>
              <div className="flex gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => {
                    setLoading(true);
                    setError(null);
                    setPage((current) => Math.max(1, current - 1));
                  }}
                >
                  Previous
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={page >= lastPage}
                  onClick={() => {
                    setLoading(true);
                    setError(null);
                    setPage((current) => Math.min(lastPage, current + 1));
                  }}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No audit events recorded yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────

export interface CaseworkPanelProps {
  caseId: string;
  status: AdmissionsCaseStatus;
  updatedAt: string;
  driveFolder: string | null;
  familyPortalOpen: boolean;
  familyPortalOpenedAt: string | null;
  familyPortalOpenedByEmail: string | null;
  externalLinks: Record<string, unknown>;
  members: AdmissionsMemberDto[];
  viewerRole: CaseRole;
  viewerEmail: string;
}

export function CaseworkPanel({
  caseId,
  status,
  updatedAt,
  driveFolder,
  familyPortalOpen,
  familyPortalOpenedAt,
  familyPortalOpenedByEmail,
  externalLinks,
  members,
  viewerRole,
  viewerEmail,
}: CaseworkPanelProps) {
  const router = useRouter();
  const lifecycleActions = getLifecycleActions(status);
  const displayLinks = useMemo(() => getDisplayExternalLinks(externalLinks), [externalLinks]);
  const currentFolderLink = useMemo(() => {
    const normalized = normalizeCaseLink(driveFolder ?? "");
    return normalized.ok ? normalized.value : null;
  }, [driveFolder]);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelNotice, setPanelNotice] = useState<string | null>(null);
  const [auditReloadVersion, setAuditReloadVersion] = useState(0);

  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState<"parent" | "counselor">("parent");
  const [counselorOptions, setCounselorOptions] = useState<Array<{
    email: string;
    name: string;
  }>>([]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admissions/counselors")
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload: unknown) => {
        if (cancelled || !payload || typeof payload !== "object" || !("counselors" in payload)) return;
        const values = Array.isArray((payload as { counselors?: unknown }).counselors)
          ? (payload as { counselors: Array<{ email?: unknown; name?: unknown; active?: unknown }> }).counselors
          : [];
        setCounselorOptions(values.flatMap((value) =>
          value.active === false || typeof value.email !== "string"
            ? []
            : [{
                email: value.email,
                name: typeof value.name === "string" ? value.name : value.email,
              }],
        ));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const [emailMember, setEmailMember] = useState<AdmissionsMemberDto | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [revokeMember, setRevokeMember] = useState<AdmissionsMemberDto | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<LifecycleAction | null>(null);
  const [portalTarget, setPortalTarget] = useState<boolean | null>(null);

  const [folderDraft, setFolderDraft] = useState(driveFolder ?? "");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [externalLinkDrafts, setExternalLinkDrafts] = useState<ExternalLinkDraft[]>(
    () => displayLinks.map(({ key, url }) => ({ key, url })),
  );
  const [externalLinksError, setExternalLinksError] = useState<string | null>(null);

  function finishMutation(notice: string) {
    setPanelNotice(notice);
    setPanelError(null);
    setAuditReloadVersion((current) => current + 1);
    router.refresh();
  }

  async function runMemberMutation(
    key: string,
    request: () => Promise<CaseworkRequestResult>,
    notice: string,
  ) {
    setBusyKey(key);
    setPanelError(null);
    setPanelNotice(null);
    const result = await request();
    setBusyKey(null);
    if (!result.ok) {
      setPanelError(result.error);
      return false;
    }
    finishMutation(notice);
    return true;
  }

  async function handleAddMember() {
    const validationError = validateMemberEmail(addEmail);
    if (validationError) {
      setPanelError(validationError);
      return;
    }
    const success = await runMemberMutation(
      "add-member",
      () => requestMemberAdd({ caseId, email: addEmail, role: addRole }),
      addRole === "parent"
        ? "Parent invited."
        : "Counselor added to this case.",
    );
    if (success) setAddEmail("");
  }

  async function handleChangeEmail() {
    if (!emailMember) return;
    const validationError = validateMemberEmail(emailDraft);
    if (validationError) {
      setPanelError(validationError);
      return;
    }
    const success = await runMemberMutation(
      `email-${emailMember.id}`,
      () => requestMemberAction({
        caseId,
        action: "change_email",
        memberId: emailMember.id,
        newEmail: emailDraft,
      }),
      emailMember.role === "counselor"
        ? "Counselor email changed and access remains active."
        : "Email changed and a new invitation queued.",
    );
    if (success) setEmailMember(null);
  }

  async function handleRevoke() {
    if (!revokeMember) return;
    const target = revokeMember;
    const success = await runMemberMutation(
      `revoke-${target.id}`,
      () => requestMemberAction({ caseId, action: "revoke", memberId: target.id }),
      `${target.email} no longer has access.`,
    );
    if (success) setRevokeMember(null);
  }

  async function handleLifecycleChange() {
    if (!lifecycleAction) return;
    const target = lifecycleAction;
    setBusyKey("lifecycle");
    setPanelError(null);
    setPanelNotice(null);
    const result = await requestLifecycleChange({
      caseId,
      status: target.status,
      expectedUpdatedAt: updatedAt,
    });
    setBusyKey(null);
    if (!result.ok) {
      setPanelError(result.error);
      return;
    }
    setLifecycleAction(null);
    finishMutation(`Case marked ${CASE_STATUS_LABELS[target.status].toLowerCase()}.`);
  }

  async function handleFolderSave() {
    const normalized = normalizeCaseLink(folderDraft);
    if (!normalized.ok) {
      setFolderError(normalized.error);
      return;
    }
    setBusyKey("drive-folder");
    setFolderError(null);
    setPanelError(null);
    setPanelNotice(null);
    const result = await requestDriveFolderChange({
      caseId,
      driveFolder: normalized.value,
      expectedUpdatedAt: updatedAt,
    });
    setBusyKey(null);
    if (!result.ok) {
      setFolderError(result.error);
      return;
    }
    finishMutation(normalized.value ? "Drive folder saved." : "Drive folder cleared.");
  }

  async function handleExternalLinksSave() {
    const normalized = normalizeExternalLinkDrafts(externalLinkDrafts);
    if (!normalized.ok) {
      setExternalLinksError(normalized.error);
      return;
    }
    setBusyKey("external-links");
    setExternalLinksError(null);
    setPanelError(null);
    setPanelNotice(null);
    const result = await requestExternalLinksChange({
      caseId,
      externalLinks: normalized.value,
      expectedUpdatedAt: updatedAt,
    });
    setBusyKey(null);
    if (!result.ok) {
      setExternalLinksError(result.error);
      return;
    }
    finishMutation(
      externalLinkDrafts.length > 0
        ? "External links saved."
        : "External links cleared.",
    );
  }

  async function handlePortalChange() {
    if (portalTarget === null) return;
    const nextOpen = portalTarget;
    setBusyKey("family-portal");
    setPanelError(null);
    setPanelNotice(null);
    const result = await requestFamilyPortalChange({
      caseId,
      familyPortalOpen: nextOpen,
      expectedUpdatedAt: updatedAt,
    });
    setBusyKey(null);
    if (!result.ok) {
      setPanelError(result.error);
      return;
    }
    setPortalTarget(null);
    finishMutation(
      nextOpen
        ? "Family portal opened."
        : "Family portal closed.",
    );
  }

  return (
    <div className="space-y-4" data-testid="casework-panel">
      <div>
        <h2 className="text-base font-semibold text-foreground">Casework & access</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Manage the case lifecycle, shared workspace, and who can open this record.
        </p>
      </div>

      {panelError ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {panelError}
        </p>
      ) : null}
      {panelNotice ? (
        <p role="status" className="rounded-lg border border-available/30 bg-available/5 px-3 py-2 text-sm text-available">
          {panelNotice}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card data-testid="case-lifecycle-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheckIcon aria-hidden className="size-4" />
              Lifecycle
            </CardTitle>
            <CardDescription>Only the next valid case actions are available.</CardDescription>
            <CardAction>
              <Badge className={CASE_STATUS_BADGE_CLASSES[status]}>
                {CASE_STATUS_LABELS[status]}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            {status === "active" ? (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium">Ready to record a commitment?</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Choose the final college in Applications so the decision event and college stay linked.
                </p>
                <Button
                  className="mt-2"
                  size="xs"
                  variant="outline"
                  render={<Link href={`/admissions/${caseId}?tab=applications`} />}
                >
                  Open Applications
                </Button>
              </div>
            ) : null}
            {lifecycleActions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {lifecycleActions.map((action) => (
                  <Button
                    key={action.status}
                    size="sm"
                    variant={action.destructive ? "destructive" : "outline"}
                    onClick={() => setLifecycleAction(action)}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            ) : status !== "active" ? (
              <p className="text-sm text-muted-foreground">
                {status === "archived"
                  ? "Archived cases have no further lifecycle actions."
                  : "No lifecycle action is currently available."}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card data-testid="case-links-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderOpenIcon aria-hidden className="size-4" />
              Case links
            </CardTitle>
            <CardDescription>Keep the shared case workspace one click away.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void handleFolderSave();
              }}
            >
              <label className="space-y-1 text-xs font-medium text-foreground">
                Google Drive folder
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="url"
                    inputMode="url"
                    placeholder="https://drive.google.com/drive/folders/…"
                    value={folderDraft}
                    onChange={(event) => setFolderDraft(event.target.value)}
                    aria-invalid={folderError ? true : undefined}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busyKey === "drive-folder" || folderDraft.trim() === (driveFolder ?? "")}
                  >
                    {busyKey === "drive-folder" ? "Saving…" : "Save"}
                  </Button>
                </div>
              </label>
              {folderError ? <p className="text-xs text-destructive" role="alert">{folderError}</p> : null}
              {currentFolderLink ? (
                <a
                  href={currentFolderLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Open current folder <ExternalLinkIcon aria-hidden className="size-3" />
                </a>
              ) : null}
            </form>

            <form
              className="space-y-2 border-t border-border pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                void handleExternalLinksSave();
              }}
              data-testid="external-links-editor"
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-foreground">Student external links</p>
                  <p className="text-xs text-muted-foreground">Common App, portfolio, school portal, or other shared resources.</p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={externalLinkDrafts.length >= 20}
                  onClick={() => {
                    const used = new Set(externalLinkDrafts.map((draft) => draft.key));
                    let index = externalLinkDrafts.length + 1;
                    while (used.has(`link_${index}`)) index += 1;
                    setExternalLinkDrafts((current) => [
                      ...current,
                      { key: `link_${index}`, url: "" },
                    ]);
                  }}
                >
                  <PlusIcon aria-hidden /> Add link
                </Button>
              </div>
              {externalLinkDrafts.length > 0 ? (
                <div className="space-y-2">
                  {externalLinkDrafts.map((draft, index) => (
                    <div
                      key={index}
                      className="grid gap-2 rounded-lg border border-border/70 p-2 sm:grid-cols-[minmax(8rem,0.7fr)_minmax(0,1.3fr)_auto] sm:items-end"
                    >
                      <label className="space-y-1 text-xs font-medium text-foreground">
                        Name
                        <Input
                          value={draft.key}
                          maxLength={40}
                          onChange={(event) => setExternalLinkDrafts((current) => current.map(
                            (item, itemIndex) => itemIndex === index
                              ? { ...item, key: event.target.value }
                              : item,
                          ))}
                          placeholder="Common App"
                        />
                      </label>
                      <label className="space-y-1 text-xs font-medium text-foreground">
                        URL
                        <Input
                          type="url"
                          inputMode="url"
                          value={draft.url}
                          onChange={(event) => setExternalLinkDrafts((current) => current.map(
                            (item, itemIndex) => itemIndex === index
                              ? { ...item, url: event.target.value }
                              : item,
                          ))}
                          placeholder="https://…"
                        />
                      </label>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${prettifyLinkLabel(draft.key)} link`}
                        onClick={() => setExternalLinkDrafts((current) => current.filter(
                          (_item, itemIndex) => itemIndex !== index,
                        ))}
                      >
                        <Trash2Icon aria-hidden />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No additional external links are saved.</p>
              )}
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={busyKey === "external-links"}>
                  {busyKey === "external-links" ? "Saving…" : "Save links"}
                </Button>
                {externalLinksError ? (
                  <p className="text-xs text-destructive" role="alert">{externalLinksError}</p>
                ) : null}
              </div>
              {displayLinks.length > 0 ? (
                <ul className="flex flex-wrap gap-2" aria-label="Saved external links">
                  {displayLinks.map((link) => (
                    <li key={link.key}>
                      <Button
                        size="xs"
                        variant="outline"
                        render={<a href={link.url} target="_blank" rel="noreferrer" />}
                      >
                        {link.label} <ExternalLinkIcon aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </form>
          </CardContent>
        </Card>
      </div>

      <WorkbookImportWizard caseId={caseId} />

      <Card data-testid="people-access-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UsersIcon aria-hidden className="size-4" />
            People & access
          </CardTitle>
          <CardDescription>
            Add the replacement counselor before revoking the current assignment. The student&apos;s membership is created with the case.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={cn(
              "flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between",
              familyPortalOpen
                ? "border-available/30 bg-available/5"
                : "border-border bg-muted/20",
            )}
            data-testid="family-portal-control"
          >
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">Family portal</p>
                <Badge
                  className={familyPortalOpen
                    ? "bg-available/15 text-available"
                    : "bg-muted text-muted-foreground"}
                >
                  {familyPortalOpen ? "Open" : "Closed"}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {familyPortalOpen
                  ? "Student and parent memberships may use their role-specific portal."
                  : "Family deep links stay closed even when an invitation membership exists."}
              </p>
              {familyPortalOpenedAt ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Last opened {formatTimestamp(familyPortalOpenedAt)}
                  {familyPortalOpenedByEmail ? ` by ${familyPortalOpenedByEmail}` : ""}
                </p>
              ) : null}
            </div>
            <Button
              size="sm"
              variant={familyPortalOpen ? "outline" : "default"}
              disabled={
                busyKey === "family-portal" ||
                (!familyPortalOpen && (status === "withdrawn" || status === "archived"))
              }
              onClick={() => setPortalTarget(!familyPortalOpen)}
            >
              {familyPortalOpen ? "Close portal" : "Open portal"}
            </Button>
          </div>

          <form
            className="grid gap-2 rounded-lg border border-border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAddMember();
            }}
          >
            <label className="space-y-1 text-xs font-medium text-foreground">
              {addRole === "counselor" ? "Counselor" : "Email"}
              {addRole === "counselor" ? (
                <select
                  className={SELECT_FIELD_CLASSES}
                  value={addEmail}
                  onChange={(event) => setAddEmail(event.target.value)}
                >
                  <option value="">Select an active counselor</option>
                  {counselorOptions.map((counselor) => (
                    <option key={counselor.email} value={counselor.email}>
                      {counselor.name} ({counselor.email})
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  type="email"
                  placeholder="person@example.com"
                  value={addEmail}
                  onChange={(event) => setAddEmail(event.target.value)}
                />
              )}
            </label>
            <label className="space-y-1 text-xs font-medium text-foreground">
              Role
              <select
                className={SELECT_FIELD_CLASSES}
                value={addRole}
                onChange={(event) => {
                  setAddRole(event.target.value as "parent" | "counselor");
                  setAddEmail("");
                }}
              >
                <option value="parent">Parent</option>
                <option value="counselor">Counselor</option>
              </select>
            </label>
            <Button type="submit" size="sm" disabled={busyKey === "add-member"}>
              <UserPlusIcon aria-hidden />
              {busyKey === "add-member" ? "Adding…" : "Add person"}
            </Button>
          </form>

          <ul className="divide-y divide-border rounded-lg border border-border" data-testid="member-list">
            {members.map((member) => {
              const isSelf = member.email.toLowerCase() === viewerEmail.toLowerCase();
              const isBusy = busyKey?.endsWith(member.id) ?? false;
              const statusTimestamp = member.status === "active"
                ? formatTimestamp(member.activatedAt)
                : member.status === "revoked"
                  ? formatTimestamp(member.revokedAt)
                  : formatTimestamp(member.invitedAt);
              return (
                <li
                  key={member.id}
                  className={cn(
                    "flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between",
                    member.status === "revoked" && "bg-muted/25 text-muted-foreground",
                  )}
                  data-testid={`member-row-${member.id}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-sm font-medium text-foreground">{member.email}</p>
                      <Badge variant="outline">{humanize(member.role)}</Badge>
                      <Badge className={MEMBER_STATUS_CLASSES[member.status]}>
                        {MEMBER_STATUS_LABELS[member.status]}
                      </Badge>
                      {isSelf ? <Badge variant="secondary">You</Badge> : null}
                    </div>
                    {statusTimestamp ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {member.status === "active"
                          ? "Activated"
                          : member.status === "revoked"
                            ? "Revoked"
                            : "Invited"}{" "}
                        {statusTimestamp}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    {familyPortalOpen &&
                    (member.status === "invited" || member.status === "bounced") ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={isBusy}
                        onClick={() => void runMemberMutation(
                          `reinvite-${member.id}`,
                          () => requestMemberAction({
                            caseId,
                            action: "reinvite",
                            memberId: member.id,
                            expectedUpdatedAt: member.updatedAt,
                          }),
                          `Invitation re-sent to ${member.email}.`,
                        )}
                      >
                        <MailPlusIcon aria-hidden /> Re-invite
                      </Button>
                    ) : null}
                    {member.status !== "revoked" && member.role !== "student" ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={isBusy}
                        onClick={() => {
                          setEmailMember(member);
                          setEmailDraft(member.email);
                          setPanelError(null);
                        }}
                      >
                        <PencilIcon aria-hidden /> Change email
                      </Button>
                    ) : member.role !== "student" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={isBusy}
                        onClick={() => void runMemberMutation(
                          `reactivate-${member.id}`,
                          () => requestMemberReactivate({ caseId, member }),
                          member.role === "parent"
                            ? `A fresh invitation was queued for ${member.email}.`
                            : `${member.email} was restored to this case.`,
                        )}
                      >
                        <RefreshCwIcon aria-hidden /> Reactivate
                      </Button>
                    ) : (
                      <span className="self-center text-xs text-muted-foreground">
                        Student restoration requires a case-level access repair.
                      </span>
                    )}
                    {member.status !== "revoked" ? (
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={isBusy}
                        onClick={() => setRevokeMember(member)}
                      >
                        <UserRoundXIcon aria-hidden /> Revoke
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {viewerRole === "admin" ? (
        <AuditHistory caseId={caseId} reloadVersion={auditReloadVersion} />
      ) : null}

      <Dialog open={emailMember !== null} onOpenChange={(open) => { if (!open) setEmailMember(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change member email</DialogTitle>
            <DialogDescription>
              The old membership will be revoked. The new address must use its own invitation to sign in.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1 text-xs font-medium text-foreground">
            New email
            <Input
              type="email"
              value={emailDraft}
              onChange={(event) => setEmailDraft(event.target.value)}
              autoFocus
            />
          </label>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEmailMember(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!emailMember || busyKey === `email-${emailMember.id}` || emailDraft.trim().toLowerCase() === emailMember.email.toLowerCase()}
              onClick={() => void handleChangeEmail()}
            >
              {emailMember && busyKey === `email-${emailMember.id}` ? "Changing…" : "Change email"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeMember !== null} onOpenChange={(open) => { if (!open) setRevokeMember(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke access?</DialogTitle>
            <DialogDescription>
              {revokeMember?.email.toLowerCase() === viewerEmail.toLowerCase()
                ? "You are revoking your own membership and will lose access to this case on the next request. Your membership history stays in the audit log."
                : `${revokeMember?.email ?? "This person"} will lose access on their next request. Their membership history stays in the audit log.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRevokeMember(null)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={!revokeMember || busyKey === `revoke-${revokeMember.id}`} onClick={() => void handleRevoke()}>
              {revokeMember && busyKey === `revoke-${revokeMember.id}` ? "Revoking…" : "Revoke access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={lifecycleAction !== null} onOpenChange={(open) => { if (!open) setLifecycleAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{lifecycleAction?.label}?</DialogTitle>
            <DialogDescription>{lifecycleAction?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setLifecycleAction(null)}>
              Cancel
            </Button>
            <Button
              variant={lifecycleAction?.destructive ? "destructive" : "default"}
              size="sm"
              disabled={!lifecycleAction || busyKey === "lifecycle"}
              onClick={() => void handleLifecycleChange()}
            >
              {busyKey === "lifecycle" ? "Updating…" : lifecycleAction?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={portalTarget !== null} onOpenChange={(open) => { if (!open) setPortalTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {portalTarget ? "Open the family portal?" : "Close the family portal?"}
            </DialogTitle>
            <DialogDescription>
              {portalTarget
                ? "Student and parent role-specific portals will become available. Review invitation status below and re-invite pending members when needed."
                : "Student and parent deep links will stop working immediately. Membership history and invitations are retained."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPortalTarget(null)}>
              Cancel
            </Button>
            <Button
              variant={portalTarget ? "default" : "destructive"}
              size="sm"
              disabled={portalTarget === null || busyKey === "family-portal"}
              onClick={() => void handlePortalChange()}
            >
              {busyKey === "family-portal"
                ? "Updating…"
                : portalTarget
                  ? "Open portal"
                  : "Close portal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

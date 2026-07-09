"use client";

// ----------------------------------------------------------------------------
// Admissions announcements panel (design §3/§4, PRD CM-90) — rendered in the
// case Overview tab. Lists the announcements visible on the case (case-scoped
// rows merged with the case's cohort broadcasts, newest first — the server
// does the merge) and, for counselor/admin viewers, a composer that posts to
// POST /api/admissions/announcements.
//
// The composer's scope radio (this case vs whole cohort) has deliberately NO
// preselection — mirroring the notes-visibility rule: a cohort broadcast
// reaches every family in the cohort, so the author must make that choice
// explicitly before submit unlocks (fail-closed against accidental
// broadcasts). The API re-checks the role and the exactly-one-scope rule on
// every request; this gate is presentation only.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { MegaphoneIcon } from "lucide-react";

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
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { roleAtLeast } from "@/lib/admissions/config";
import type { AdmissionsAnnouncementDto } from "@/lib/admissions/announcements";
import type { CaseRole } from "@/lib/admissions/types";

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** Composer scope choice; null until the author picks one (no default). */
export type AnnouncementScopeChoice = "case" | "cohort" | null;

/** Announcement composer form model. */
export interface AnnouncementFormValues {
  title: string;
  body: string;
  scope: AnnouncementScopeChoice;
}

/** Blank composer form — scope deliberately unset (explicit choice required). */
export const EMPTY_ANNOUNCEMENT_FORM: AnnouncementFormValues = {
  title: "",
  body: "",
  scope: null,
};

/** True when the viewer may compose announcements (counselor/admin, §2.2). */
export function canComposeAnnouncement(viewerRole: CaseRole): boolean {
  return roleAtLeast(viewerRole, "counselor");
}

/** POST body for /api/admissions/announcements (exactly one scope id set). */
export interface AnnouncementRequestBody {
  caseId?: string;
  cohortId?: string;
  title: string;
  body: string;
}

/** buildAnnouncementPayload result — a ready request body or an inline error. */
export type AnnouncementPayloadResult =
  | { ok: true; body: AnnouncementRequestBody }
  | { ok: false; error: string };

/**
 * Validates the composer form and builds the POST body (CM-90). Returns an
 * inline error instead of guessing: blank title/body and a missing scope
 * choice are rejected, and the body carries exactly one of caseId/cohortId —
 * mirroring the route's XOR refine.
 */
export function buildAnnouncementPayload(
  form: AnnouncementFormValues,
  caseId: string,
  cohortId: string,
): AnnouncementPayloadResult {
  const title = form.title.trim();
  const body = form.body.trim();
  if (!title) return { ok: false, error: "Announcement title is required." };
  if (!body) return { ok: false, error: "Announcement body is required." };
  if (form.scope === null) {
    return { ok: false, error: "Choose who the announcement is for before posting." };
  }
  return {
    ok: true,
    body:
      form.scope === "case"
        ? { caseId, title, body }
        : { cohortId, title, body },
  };
}

/** ISO timestamp → "D/M/YYYY, HH:mm" on the Asia/Bangkok clock. */
function formatBangkokTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

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

// ── Panel ───────────────────────────────────────────────────────────────

/** Props for AnnouncementsPanel — announcements are server-fetched by the page. */
export interface AnnouncementsPanelProps {
  caseId: string;
  cohortId: string;
  cohortName: string;
  /** Case + cohort announcements visible on this case, newest first (CM-90). */
  announcements: AdmissionsAnnouncementDto[];
  viewerRole: CaseRole;
}

/**
 * Announcements list + counselor/admin composer (CM-90). Family viewers get
 * the read-only list; the composer requires an explicit case-vs-cohort scope
 * choice before submit unlocks. Successful posts reset the form and
 * router.refresh() so the server-fetched list re-hydrates.
 */
export function AnnouncementsPanel({
  caseId,
  cohortId,
  cohortName,
  announcements,
  viewerRole,
}: AnnouncementsPanelProps) {
  const router = useRouter();
  const canCompose = canComposeAnnouncement(viewerRole);

  const [form, setForm] = useState<AnnouncementFormValues>(EMPTY_ANNOUNCEMENT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = buildAnnouncementPayload(form, caseId, cohortId).ok;

  const handleSubmit = useCallback(async () => {
    const result = buildAnnouncementPayload(form, caseId, cohortId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/admissions/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readErrorMessage(payload, "Failed to post the announcement."));
        return;
      }
      setForm(EMPTY_ANNOUNCEMENT_FORM);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post the announcement.");
    } finally {
      setSaving(false);
    }
  }, [form, caseId, cohortId, router]);

  return (
    <Card data-testid="announcements-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <MegaphoneIcon aria-hidden className="size-4" />
          Announcements
        </CardTitle>
        <CardDescription>
          Visible to everyone on this case — counselors, student, and parents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canCompose ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
            className="space-y-3 rounded-lg border border-border/60 p-3"
          >
            <label className="block space-y-1 text-xs font-medium text-foreground">
              Title
              <span aria-hidden className="text-destructive">
                {" "}
                *
              </span>
              <Input
                value={form.title}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, title: event.target.value }))
                }
              />
            </label>
            <label className="block space-y-1 text-xs font-medium text-foreground">
              Message
              <span aria-hidden className="text-destructive">
                {" "}
                *
              </span>
              <Textarea
                aria-label="Announcement body"
                placeholder="Write the announcement…"
                value={form.body}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, body: event.target.value }))
                }
              />
            </label>
            <fieldset>
              <legend className="text-xs font-medium text-foreground">
                Audience
                <span aria-hidden className="text-destructive">
                  {" "}
                  *
                </span>
              </legend>
              <div className="mt-1.5 flex flex-col gap-1.5">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="announcement-scope"
                    value="case"
                    checked={form.scope === "case"}
                    onChange={() =>
                      setForm((previous) => ({ ...previous, scope: "case" }))
                    }
                    className="mt-1"
                  />
                  <span>
                    This case only
                    <span className="block text-xs text-muted-foreground">
                      Visible to this student&apos;s case members.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="announcement-scope"
                    value="cohort"
                    checked={form.scope === "cohort"}
                    onChange={() =>
                      setForm((previous) => ({ ...previous, scope: "cohort" }))
                    }
                    className="mt-1"
                  />
                  <span>
                    Whole cohort ({cohortName})
                    <span className="block text-xs text-muted-foreground">
                      Broadcast to every case in the cohort.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              size="sm"
              data-testid="announcement-submit"
              disabled={!canSubmit || saving}
            >
              {saving ? "Posting…" : "Post announcement"}
            </Button>
          </form>
        ) : null}

        {announcements.length > 0 ? (
          <ul className="space-y-3">
            {announcements.map((announcement) => (
              <li
                key={announcement.id}
                data-testid="announcement-item"
                className="space-y-1 rounded-lg border border-border/60 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {announcement.title}
                  </span>
                  {announcement.cohortId !== null ? (
                    <Badge variant="outline">Cohort broadcast</Badge>
                  ) : (
                    <Badge variant="secondary">This case</Badge>
                  )}
                </div>
                <p className="text-sm whitespace-pre-wrap">{announcement.body}</p>
                <p className="text-xs text-muted-foreground">
                  {announcement.authorEmail} ·{" "}
                  {formatBangkokTimestamp(announcement.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {canCompose
              ? "No announcements yet. Post the first one above."
              : "No announcements yet."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

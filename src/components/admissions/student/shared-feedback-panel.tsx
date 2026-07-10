"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquareTextIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AdmissionsNoteDto } from "@/lib/admissions/types";

function readError(payload: unknown): string {
  return payload && typeof payload === "object" && "error" in payload && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : "Shared feedback could not be loaded.";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function SharedFeedbackPanel({ caseId }: { caseId: string }) {
  const [notes, setNotes] = useState<AdmissionsNoteDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/notes`);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload));
      const rows = payload && typeof payload === "object" && "notes" in payload && Array.isArray((payload as { notes?: unknown }).notes)
        ? (payload as { notes: AdmissionsNoteDto[] }).notes
        : [];
      setNotes(rows.filter((note) => note.visibility === "shared_with_family"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Shared feedback could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-3" data-testid="shared-feedback-panel">
      <header><h2 className="text-base font-semibold">Shared feedback</h2><p className="text-sm text-muted-foreground">Counselor notes deliberately shared with you and your family.</p></header>
      {loading ? <Card><CardContent><p className="text-sm text-muted-foreground">Loading feedback…</p></CardContent></Card> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!loading && notes.length === 0 ? <Card><CardContent className="flex items-start gap-3"><MessageSquareTextIcon aria-hidden className="mt-0.5 size-5 text-muted-foreground" /><p className="text-sm text-muted-foreground">No shared feedback yet.</p></CardContent></Card> : null}
      {notes.map((note) => <Card key={note.id}><CardHeader><CardTitle className="text-sm">{note.authorEmail}</CardTitle><CardDescription>{formatDate(note.createdAt)}</CardDescription></CardHeader><CardContent><p className="text-sm whitespace-pre-wrap">{note.body}</p></CardContent></Card>)}
    </div>
  );
}


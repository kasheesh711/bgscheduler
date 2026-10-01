"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { OffboardingPersonRow } from "@/lib/tutor-offboarding/types";

const SNOOZES = [{ days: 90, label: "90 days" }, { days: 365, label: "1 year" }] as const;

function errorMessage(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : fallback;
}

function StillWithUsForm({ row, onClose, onSaved }: { row: OffboardingPersonRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [snoozeDays, setSnoozeDays] = useState<90 | 365>(90);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/tutor-offboarding/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalKey: row.signals.canonicalKey, note: note.trim() || null, snoozeDays }),
      });
      if (!response.ok) {
        setError(errorMessage(await response.json().catch(() => null), "The decision could not be saved."));
        return;
      }
      await onSaved();
      onClose();
    } catch {
      setError("The decision could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{row.signals.displayName} is still with us</DialogTitle>
        <DialogDescription>Hide them from the review list. They come back if they are still idle when this ends.</DialogDescription>
      </DialogHeader>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">Hide for</legend>
        <div className="flex gap-2">
          {SNOOZES.map((option) => (
            <Button key={option.days} type="button" size="sm" variant={snoozeDays === option.days ? "default" : "outline"}
              aria-pressed={snoozeDays === option.days} onClick={() => setSnoozeDays(option.days)}>
              {option.label}
            </Button>
          ))}
        </div>
      </fieldset>
      <label className="block space-y-1.5 text-xs font-medium">
        Note (optional)
        <Textarea value={note} maxLength={1_000} onChange={(event) => setNote(event.target.value)} placeholder="e.g. On a term break, back in January" />
      </label>
      {error ? <p role="alert" className="text-xs text-conflict">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="button" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </DialogFooter>
    </>
  );
}

export function StillWithUsDialog({ row, onClose, onSaved }: { row: OffboardingPersonRow | null; onClose: () => void; onSaved: () => Promise<void> }) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {row ? <StillWithUsForm key={row.signals.canonicalKey} row={row} onClose={onClose} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}

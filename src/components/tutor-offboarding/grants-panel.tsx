"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GrantRecord } from "@/lib/tutor-offboarding/types";
import { Panel, Upper } from "./atoms";
import { formatDay } from "./format";

/** OFF-11: the owner chooses which admins may remove tutors from Wise (used by PR 2's Remove button). */
export function GrantsPanel({ grants, onChanged }: { grants: GrantRecord[]; onChanged: (next: GrantRecord[]) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(action: "grant" | "revoke", target: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/tutor-offboarding/grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, email: target }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown; grants?: GrantRecord[] } | null;
      if (!response.ok || !body?.grants) {
        setError(typeof body?.error === "string" ? body.error : "The removal access could not be changed.");
        return;
      }
      onChanged(body.grants);
      if (action === "grant") setEmail("");
    } catch {
      setError("The removal access could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="px-5 py-4">
      <Upper>Who can remove</Upper>
      <p className="mt-1 text-xs text-muted-foreground">Admins allowed to remove departed tutors from Wise. Only you can change this.</p>
      <ul className="mt-3 space-y-1.5">
        {grants.length === 0 ? <li className="text-xs text-muted-foreground">Nobody yet.</li> : null}
        {grants.map((grant) => (
          <li key={grant.email} className="flex items-center justify-between gap-2 text-xs">
            <span>{grant.email} <span className="text-muted-foreground">· since {formatDay(grant.grantedAt)}</span></span>
            <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void change("revoke", grant.email)}>Remove</Button>
          </li>
        ))}
      </ul>
      <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (email.trim()) void change("grant", email.trim()); }}>
        <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@email" aria-label="Admin email" />
        <Button type="submit" size="sm" disabled={busy || !email.trim()}>Allow</Button>
      </form>
      {error ? <p role="alert" className="mt-2 text-xs text-conflict">{error}</p> : null}
    </Panel>
  );
}

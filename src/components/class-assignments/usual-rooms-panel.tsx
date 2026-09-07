"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ClassroomRoom } from "./types";

interface Profile {
  canonicalKey: string; tutorDisplayName: string; revision: number; roomIds: string[];
  preferredRoom: string | null; source: string; rooms: ClassroomRoom[];
}

export function UsualRoomsPanel() {
  const [data, setData] = useState<{ profiles: Profile[]; rooms: ClassroomRoom[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function load() {
    const response = await fetch("/api/class-assignments/room-profiles");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Unable to load usual rooms");
    setData(body);
  }
  useEffect(() => { let active = true; void fetch("/api/class-assignments/room-profiles").then(async response => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Unable to load usual rooms");
    if (active) setData(body);
  }).catch(error => { if (active) setError(String(error.message)); }); return () => { active = false; }; }, []);
  async function save(profile: Profile, form: HTMLFormElement) {
    setSaving(profile.canonicalKey); setError(null); setMessage(null);
    try {
      const values = new FormData(form);
      const roomIds = ["primary", "secondary", "third"].map(key => String(values.get(key) ?? "")).filter(Boolean);
      const response = await fetch(`/api/class-assignments/room-profiles/${encodeURIComponent(profile.canonicalKey)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomIds, revision: profile.revision }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to save usual rooms");
      await load(); setMessage(`${profile.tutorDisplayName}’s usual rooms saved. They apply when assignments are next generated.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save usual rooms"); }
    finally { setSaving(null); }
  }
  return <div className="h-full overflow-auto rounded-lg border bg-card p-4">
    <h2 className="text-lg font-semibold">Usual rooms</h2>
    <p className="mt-1 mb-4 max-w-3xl text-sm text-muted-foreground">Each teacher has up to three familiar rooms. Sets stay the same week to week, and existing preferred rooms stay first. Keeping consecutive classes together takes priority when another room is needed.</p>
    {error && <p role="alert" className="mb-4 rounded-md border border-destructive p-3 text-sm">{error}</p>}
    {message && <p role="status" className="mb-4 rounded-md border p-3 text-sm">{message}</p>}
    {!data && !error && <p>Loading usual rooms…</p>}
    {data?.profiles.length === 0 && <p className="py-8 text-sm text-muted-foreground">Room sets will be established automatically the next time assignments are generated.</p>}
    <div className="grid gap-3 lg:grid-cols-2">{data?.profiles.map(profile => <form key={`${profile.canonicalKey}:${profile.revision}`} onSubmit={event => { event.preventDefault(); void save(profile, event.currentTarget); }} className="rounded-lg border p-4">
      <div className="mb-3 flex justify-between gap-3"><h3 className="font-semibold">{profile.tutorDisplayName}</h3><span className="text-xs text-muted-foreground">{profile.source === "admin" ? "Edited by team" : "Automatically selected"}</span></div>
      <div className="grid gap-2 sm:grid-cols-3">{["primary", "secondary", "third"].map((key, index) => <label key={key} className="grid gap-1 text-sm">
        {index === 0 ? "Primary room" : `Usual room ${index + 1}`}
        <select name={key} aria-label={index === 0 ? "Primary room" : `Usual room ${index + 1}`} defaultValue={profile.roomIds[index] ?? ""} className="w-full min-w-0 rounded-md border bg-background p-2" required={index === 0}>
          {index > 0 && <option value="">None</option>}
          {data.rooms.filter(room => room.category === "standard" && (room.active || profile.roomIds.includes(room.id))).map(room => <option key={room.id} value={room.id} disabled={!room.active}>{room.name}{!room.active ? " (unavailable)" : ""}</option>)}
        </select>
      </label>)}</div>
      {profile.preferredRoom && <p className="mt-2 text-xs text-muted-foreground">Existing preference: {profile.preferredRoom}</p>}
      {profile.rooms.some(room => !room.active) && <p className="mt-2 text-sm text-amber-800">A usual room is unavailable. Update this set.</p>}
      <Button className="mt-3" size="sm" disabled={saving !== null} type="submit">{saving === profile.canonicalKey ? "Saving…" : "Save usual rooms"}</Button>
    </form>)}</div>
  </div>;
}

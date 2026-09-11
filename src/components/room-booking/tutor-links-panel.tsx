"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
interface Link {
  lineUserId: string;
  canonicalKey: string | null;
  displayName: string;
  status: string;
  reviewedBy: string | null;
}
interface Directory {
  links: Link[];
  tutors: Array<{ canonicalKey: string; displayName: string }>;
}
export function TutorRoomLinksPanel() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Directory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Record<string, string>>({});
  async function load() {
    try {
      const res = await fetch("/api/tutor-profiles/line-links");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load tutor links.");
    }
  }
  async function update(link: Link, status: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tutor-profiles/line-links", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineUserId: link.lineUserId,
          status,
          ...(status === "approved"
            ? { canonicalKey: selected[link.lineUserId] ?? link.canonicalKey }
            : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update access.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="mb-2"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        Tutor LINE access
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Tutor room access</DialogTitle>
            <DialogDescription>
              Tutors request access by sending /room privately in LINE. Verify
              their identity, then link the correct tutor profile. Revocation
              cancels remaining reservations and invalidates personal links.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button variant="outline" onClick={() => void load()}>
            Refresh requests
          </Button>
          {!data && <p>Loading requests…</p>}
          {data && !data.links.length && (
            <p className="text-muted-foreground">
              No tutor access requests yet.
            </p>
          )}
          {data?.links.map((link) => (
            <article
              key={link.lineUserId}
              className="space-y-3 rounded-lg border p-4"
            >
              <div>
                <h3 className="font-medium">{link.displayName}</h3>
                <p className="text-xs text-muted-foreground">
                  {link.status} · LINE …{link.lineUserId.slice(-8)}
                </p>
                {link.reviewedBy && (
                  <p className="text-xs text-muted-foreground">
                    Reviewed by {link.reviewedBy}
                  </p>
                )}
              </div>
              <label className="grid gap-1 text-sm">
                Tutor profile
                <select
                  className="min-h-10 rounded border bg-background p-2"
                  value={selected[link.lineUserId] ?? link.canonicalKey ?? ""}
                  onChange={(e) =>
                    setSelected({
                      ...selected,
                      [link.lineUserId]: e.target.value,
                    })
                  }
                >
                  <option value="">Choose a tutor</option>
                  {data.tutors.map((t) => (
                    <option key={t.canonicalKey} value={t.canonicalKey}>
                      {t.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    busy || !(selected[link.lineUserId] ?? link.canonicalKey)
                  }
                  onClick={() => void update(link, "approved")}
                >
                  Approve link
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void update(
                      link,
                      link.status === "approved" ? "revoked" : "rejected",
                    )
                  }
                >
                  {link.status === "approved"
                    ? "Revoke access"
                    : "Reject request"}
                </Button>
              </div>
            </article>
          ))}
        </DialogContent>
      </Dialog>
    </>
  );
}

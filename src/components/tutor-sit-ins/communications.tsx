"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Communication } from "@/lib/tutor-sit-ins/client-types";
import { api, control, Notice, when } from "./shared";
export function CommunicationList({
  rows,
  canAcknowledge,
  canResolve = false,
  onChange,
}: {
  rows: Communication[];
  canAcknowledge: boolean;
  canResolve?: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  async function acknowledge(
    row: Communication,
    audience: "parent" | "student",
  ) {
    setBusy(row.id + audience);
    setError("");
    try {
      await api(
        "/communications/" + row.id,
        { expectedRevision: row.revision, audience },
        "PATCH",
      );
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function resolve(
    row: Communication,
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(row.id);
    setError("");
    try {
      await api(
        "/communications/" + row.id,
        {
          action: "resolve",
          expectedRevision: row.revision,
          parentName: form.get("parentName"),
          familyKey: form.get("familyKey"),
          reason: form.get("reason"),
        },
        "PATCH",
      );
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="space-y-3">
      {error && <Notice error>{error}</Notice>}
      {!rows.length && (
        <p className="py-4 text-sm text-muted-foreground">
          No family communication tasks.
        </p>
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          className={
            "rounded-lg border p-4 " + (row.supersededAt ? "opacity-65" : "")
          }
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium">
                {row.participants.map((p) => p.studentName).join(", ") ||
                  "Students need review"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Parent: {row.participants[0]?.parentName || "Unresolved"}
              </p>
            </div>
            <span className="text-xs font-medium">
              {row.supersededAt
                ? "Previous arrangement"
                : row.kind === "cancelled"
                  ? "Cancellation notice required"
                  : "Observation notice"}
            </span>
          </div>
          {row.unresolved && (
            <div className="mt-3">
              <Notice>
                Family identity needs administrator review before this task can
                be completed.
              </Notice>
              {canResolve && !row.supersededAt && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer font-medium">
                    Resolve this family
                  </summary>
                  <form
                    onSubmit={(e) => void resolve(row, e)}
                    className="mt-3 grid gap-3 sm:grid-cols-2"
                  >
                    <label>
                      Verified parent name
                      <input name="parentName" required className={control} />
                    </label>
                    <label>
                      Family reference
                      <input
                        name="familyKey"
                        required
                        className={control}
                        placeholder="Verified family name or reference"
                      />
                    </label>
                    <label className="sm:col-span-2">
                      Reason and evidence
                      <input
                        name="reason"
                        required
                        minLength={3}
                        className={control}
                      />
                    </label>
                    <Button type="submit" disabled={!!busy}>
                      Save family identity
                    </Button>
                  </form>
                </details>
              )}
            </div>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(["parent", "student"] as const).map((audience) => {
              const at =
                audience === "parent"
                  ? row.parentInformedAt
                  : row.studentInformedAt;
              const by =
                audience === "parent"
                  ? row.parentInformedBy
                  : row.studentInformedBy;
              return (
                <div key={audience} className="rounded-md bg-muted/50 p-3">
                  <p className="mb-2 text-sm font-medium capitalize">
                    {audience} {at ? "informed" : "to inform"}
                  </p>
                  {at ? (
                    <p className="break-words text-xs text-muted-foreground">
                      {when(at)} · {by}
                    </p>
                  ) : canAcknowledge && !row.supersededAt ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!busy || row.unresolved}
                      onClick={() => void acknowledge(row, audience)}
                    >
                      {busy === row.id + audience
                        ? "Saving…"
                        : "Mark " + audience + " informed"}
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {row.supersededAt
                        ? "Superseded"
                        : "Awaiting operations staff"}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

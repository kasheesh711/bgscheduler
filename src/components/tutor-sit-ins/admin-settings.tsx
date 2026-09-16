"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { HEADS, type Department } from "@/lib/tutor-sit-ins/model";
import type { SettingsData } from "@/lib/tutor-sit-ins/client-types";
import { api, control, Notice, panel } from "./shared";
function Departments({
  value,
  change,
}: {
  value: string[];
  change: (v: Department[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {HEADS.map((h) => (
        <label
          key={h.department}
          className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm"
        >
          <input
            type="checkbox"
            checked={value.includes(h.department)}
            onChange={(e) =>
              change(
                (e.target.checked
                  ? [...value, h.department]
                  : value.filter((v) => v !== h.department)) as Department[],
              )
            }
          />
          {h.label}
        </label>
      ))}
    </div>
  );
}
function Mapping({
  row,
  saved,
  onSave,
}: {
  row: SettingsData["classes"][number];
  saved?: SettingsData["mappings"][number];
  onSave: () => void;
}) {
  const [value, setValue] = useState<string[]>(
      saved?.departments || row.departments,
    ),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/settings", {
        action: "mapping",
        classId: row.classId,
        departments: value,
        expectedRevision: saved?.revision || 0,
        reason,
      });
      onSave();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm">
        <strong>{row.title}</strong> · {row.tutorName}
        <span className="ml-2 text-muted-foreground">
          {row.unresolved
            ? "Needs review"
            : value
                .map((v) => HEADS.find((h) => h.department === v)?.label)
                .join(" + ") || "Excluded"}
        </span>
      </summary>
      <div className="mt-4 space-y-3">
        <Departments value={value} change={setValue} />
        <p className="text-xs text-muted-foreground">
          Select every applicable subject. ISEB has its own obligation. An empty
          selection explicitly excludes this class.
        </p>
        <label className="block text-sm">
          Reason for mapping
          <input
            className={control + " mt-1"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {error && <Notice error>{error}</Notice>}
        <Button
          size="sm"
          disabled={busy || reason.trim().length < 3}
          onClick={() => void save()}
        >
          Save class mapping
        </Button>
      </div>
    </details>
  );
}
export function AdminSettings({
  quarter,
  onChange,
}: {
  quarter: string;
  onChange: () => void;
}) {
  const [data, setData] = useState<SettingsData | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState("");
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("observer"),
    [departments, setDepartments] = useState<string[]>([]),
    [canonicalKey, setCanonicalKey] = useState(""),
    [active, setActive] = useState(true),
    [reason, setReason] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await api<SettingsData>("/settings?quarter=" + quarter));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [quarter]);
  useEffect(() => {
    void load();
  }, [load]); // Fresh settings are reloaded for the selected quarter.
  function select(email: string) {
    const grant = data?.grants.find((g) => g.email === email);
    setEmail(email);
    setRole(grant?.role || "observer");
    setDepartments(grant?.departments || []);
    setCanonicalKey(grant?.canonicalKey || "");
    setActive(grant?.active ?? true);
    setReason("");
  }
  async function mutate(value: unknown) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/settings", value);
      await load();
      onChange();
      setMessage("Saved. Refresh availability to apply scheduling changes.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function addAssignment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = new FormData(e.currentTarget);
    await mutate({
      action: "assignment",
      quarter,
      canonicalKey: values.get("tutor"),
      department: values.get("department"),
      reason: values.get("reason"),
    });
  }
  return (
    <div className="space-y-5">
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <section className={panel}>
        <h2 className="text-lg font-semibold">Heads and staff access</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Bind each observer to their verified tutor identity. Online and onsite
          Wise accounts are checked together. A head’s own assessment needs an
          alternate observer.
        </p>
        {!data ? (
          <p className="mt-4 text-sm">Loading access…</p>
        ) : (
          <>
            <div className="mt-4 grid gap-2 md:grid-cols-2">
              {data.grants.map((g) => (
                <button
                  type="button"
                  key={g.email}
                  onClick={() => select(g.email)}
                  className={
                    "rounded-lg border p-3 text-left text-sm hover:bg-muted " +
                    (email === g.email ? "border-primary bg-primary/5" : "")
                  }
                >
                  <span className="block break-all font-medium">{g.email}</span>
                  <span className="text-xs text-muted-foreground">
                    {g.active ? g.role : "Revoked"} ·{" "}
                    {g.departments.join(", ") || "Operations"}
                    {g.role === "observer" && !g.canonicalKey
                      ? " · Identity needs review"
                      : ""}
                  </span>
                </button>
              ))}
            </div>
            <form
              className="mt-5 space-y-4 border-t pt-5"
              onSubmit={(e) => {
                e.preventDefault();
                void mutate({
                  action: "grant",
                  email,
                  role,
                  departments,
                  canonicalKey: canonicalKey || null,
                  active,
                  expectedRevision:
                    data.grants.find((g) => g.email === email)?.revision || 0,
                  reason,
                });
              }}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-sm">
                  Google sign-in email
                  <input
                    type="email"
                    required
                    className={control + " mt-1"}
                    value={email}
                    onChange={(e) => select(e.target.value.toLowerCase())}
                  />
                </label>
                <label className="text-sm">
                  Access role
                  <select
                    className={control + " mt-1"}
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    <option value="observer">Department observer</option>
                    <option value="coordinator">
                      Operations — communication only
                    </option>
                    <option value="manager">
                      Administrator — all departments
                    </option>
                  </select>
                </label>
              </div>
              <fieldset>
                <legend className="mb-2 text-sm">
                  Departments eligible to observe
                </legend>
                <Departments value={departments} change={setDepartments} />
              </fieldset>
              <label className="block text-sm">
                Verified tutor identity
                <select
                  className={control + " mt-1"}
                  value={canonicalKey}
                  onChange={(e) => setCanonicalKey(e.target.value)}
                >
                  <option value="">Unbound / not an observer</option>
                  {data.contacts.map((c) => (
                    <option key={c.canonicalKey} value={c.canonicalKey}>
                      {c.name} · {c.canonicalKey}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                Access enabled
              </label>
              <label className="block text-sm">
                Reason
                <input
                  required
                  minLength={3}
                  className={control + " mt-1"}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <Button disabled={busy || !email} type="submit">
                Save access grant
              </Button>
            </form>
          </>
        )}
      </section>
      <section className={panel}>
        <h2 className="text-lg font-semibold">Class-to-department mappings</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Review uncertain titles and correct class mappings. Level bands alone
          do not assign departments.
        </p>
        {data?.sourceError && (
          <div className="mt-3">
            <Notice error>{data.sourceError}</Notice>
          </div>
        )}
        <label className="mt-4 block text-sm">
          Find a class
          <input
            className={control + " mt-1"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Title or tutor name"
          />
        </label>
        <div className="mt-4 space-y-2">
          {data?.classes
            .filter((c) =>
              (c.title + " " + c.tutorName)
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .sort((a, b) => Number(b.unresolved) - Number(a.unresolved))
            .slice(0, 60)
            .map((c) => (
              <Mapping
                key={
                  c.classId +
                  ":" +
                  (data.mappings.find((m) => m.classId === c.classId)
                    ?.revision || 0)
                }
                row={c}
                saved={data.mappings.find((m) => m.classId === c.classId)}
                onSave={() => {
                  void load();
                  onChange();
                }}
              />
            ))}
        </div>
        {data && !data.classes.length && (
          <p className="mt-4 text-sm text-muted-foreground">
            No classes found in {quarter}. Upcoming classes will appear after
            the source sync.
          </p>
        )}
        {!!data?.classes.length && (
          <p className="mt-3 text-xs text-muted-foreground">
            Showing up to 60 matches. Narrow your search to find more.
          </p>
        )}
      </section>
      <section className={panel}>
        <h2 className="text-lg font-semibold">Add a quarterly obligation</h2>
        <form
          onSubmit={(e) => void addAssignment(e)}
          className="mt-4 grid gap-3 md:grid-cols-2"
        >
          <label className="text-sm">
            Tutor
            <select required name="tutor" className={control + " mt-1"}>
              <option value="">Choose a tutor</option>
              {data?.contacts.map((c) => (
                <option key={c.canonicalKey} value={c.canonicalKey}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Department
            <select name="department" className={control + " mt-1"}>
              {HEADS.map((h) => (
                <option key={h.department} value={h.department}>
                  {h.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm md:col-span-2">
            Reason
            <input
              name="reason"
              required
              minLength={3}
              className={control + " mt-1"}
            />
          </label>
          <Button type="submit" disabled={busy}>
            Add to {quarter}
          </Button>
        </form>
      </section>
    </div>
  );
}

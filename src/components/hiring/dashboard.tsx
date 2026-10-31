"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  GOOGLE_SCOPES,
  SUBJECTS,
  type HiringConfig,
  type Subject,
} from "@/lib/hiring/model";
import type { dashboard } from "@/lib/hiring/service";

type Data = Awaited<ReturnType<typeof dashboard>> & {
  google: { connected: boolean; email: string; lastError: string | null };
};
const weightLabels = {
  degree: "Degree relevance",
  subject: "Subject evidence",
  curriculum: "Curriculum experience",
  teaching: "Teaching experience",
  english: "English evidence",
  prestige: "University prestige",
};
const date = (value: unknown) =>
  value
    ? new Date(String(value)).toLocaleString("en-GB", {
        timeZone: "Asia/Bangkok",
      })
    : "Not yet";

export function HiringDashboard() {
  const [data, setData] = useState<Data | null>(null),
    [config, setConfig] = useState<HiringConfig | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [subjects, setSubjects] = useState<Subject[]>([]),
    [reason, setReason] = useState("");
  async function load() {
    const response = await fetch("/api/hiring", { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    setData(value);
    setConfig(value.config);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function command(body: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/hiring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      await load();
      setNotice("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    setBusy(true);
    setError("");
    try {
      if (!config) return;
      await signIn(
        "google",
        { callbackUrl: "/hiring" },
        {
          prompt: "consent",
          access_type: "offline",
          include_granted_scopes: "true",
          login_hint: config.connectedEmail,
          scope: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/drive.file",
            ...GOOGLE_SCOPES,
          ].join(" "),
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect.");
      setBusy(false);
    }
  }
  const candidate = data?.candidates.find((c) => c.id === selected);
  const total = config
    ? Object.values(config.profileWeights).reduce((a, b) => a + b, 0)
    : 0;
  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 overflow-y-auto p-4 md:p-8">
      <header>
        <h1 className="text-3xl font-semibold">Tutor hiring</h1>
        <p className="mt-2 text-muted-foreground">
          Applications → pre-screening → paper assessment → mock teaching
        </p>
      </header>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-3 text-red-900"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-green-700">
          {notice}
        </p>
      )}
      {!data || !config ? (
        <p role="status">
          {error
            ? "Check the hiring setup and reload this page."
            : "Loading hiring…"}
        </p>
      ) : (
        <>
          <section className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4">
            <strong>
              {config.enabled ? "Automation enabled" : "Automation paused"}
            </strong>
            <span>
              {config.deliveryEnabled ? "Messages enabled" : "Messages paused"}
            </span>
            <span>Last worker run: {date(data.workerAt)}</span>
            {data.workerSummary && (
              <span>
                SEEK: {data.workerSummary.scanned} read;{" "}
                {data.workerSummary.remaining} waiting for import.
              </span>
            )}
            {!data.writeGate && (
              <span className="text-amber-700">
                Production write gate is off.
              </span>
            )}
            {data.workerError && (
              <p role="alert" className="w-full text-red-700">
                {data.workerError}
              </p>
            )}
          </section>
          <details className="rounded-xl border bg-card p-5" open>
            <summary className="cursor-pointer text-lg font-semibold">
              Screening rules and setup
            </summary>
            <p className="my-3 text-sm text-muted-foreground">
              Change the weights and invitation threshold here. Weights must
              total 100. Degree and subject evidence must meet the rule. Lower
              scores go to review.
            </p>
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
              {(
                Object.keys(weightLabels) as Array<keyof typeof weightLabels>
              ).map((key) => (
                <label key={key} className="space-y-1 text-sm">
                  {weightLabels[key]}
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={config.profileWeights[key]}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        profileWeights: {
                          ...config.profileWeights,
                          [key]: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              ))}
              <label className="space-y-1 text-sm font-semibold">
                Invitation threshold
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={config.profileThreshold}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      profileThreshold: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <p
              className={`mt-2 text-sm ${total !== 100 ? "text-red-700" : "text-muted-foreground"}`}
            >
              Weight total: {total}/100. Current invitation threshold:{" "}
              {config.profileThreshold}/100.
            </p>
            <details className="mt-4 rounded-lg border p-3">
              <summary className="cursor-pointer font-semibold">
                University prestige rules and reference data
              </summary>
              <p className="my-3 text-sm">
                US/UK universities receive 40% of this category before ranking
                points. Global ranks 1–10 add 60%; 11–50 add 50%; 51–100 add
                40%; 101–200 add 30%; 201–500 add 20%; 501–1000 add 10%.
                Chulalongkorn, Thammasat, and Mahidol receive 60%. Use overall
                US News Best Global Universities ranks from the stated edition.
                An unverified rank receives no ranking points.
              </p>
              <div className="max-h-96 space-y-4 overflow-auto">
                {config.universities.map((u, i) => (
                  <fieldset
                    className="grid gap-2 rounded border p-3 sm:grid-cols-2 lg:grid-cols-3"
                    key={i}
                  >
                    <legend>{u.name || "New university"}</legend>
                    <label className="text-sm">
                      University
                      <Input
                        value={u.name}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            universities: config.universities.map((v, j) =>
                              j === i ? { ...v, name: e.target.value } : v,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="text-sm">
                      Country code (US, GB, TH…)
                      <Input
                        value={u.country}
                        maxLength={2}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            universities: config.universities.map((v, j) =>
                              j === i
                                ? {
                                    ...v,
                                    country: e.target.value.toUpperCase(),
                                  }
                                : v,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="text-sm">
                      Overall global rank (blank if unverified)
                      <Input
                        type="number"
                        min={1}
                        value={u.rank ?? ""}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            universities: config.universities.map((v, j) =>
                              j === i
                                ? {
                                    ...v,
                                    rank: e.target.value
                                      ? Number(e.target.value)
                                      : null,
                                  }
                                : v,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="text-sm">
                      Edition
                      <Input
                        value={u.edition}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            universities: config.universities.map((v, j) =>
                              j === i ? { ...v, edition: e.target.value } : v,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="text-sm">
                      Source URL
                      <Input
                        type="url"
                        value={u.sourceUrl}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            universities: config.universities.map((v, j) =>
                              j === i ? { ...v, sourceUrl: e.target.value } : v,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="text-sm">
                      Other names (separate with semicolons)
                      <Input
                        value={u.aliases.join("; ")}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            universities: config.universities.map((v, j) =>
                              j === i
                                ? {
                                    ...v,
                                    aliases: e.target.value
                                      .split(";")
                                      .map((a) => a.trim())
                                      .filter(Boolean),
                                  }
                                : v,
                            ),
                          })
                        }
                      />
                    </label>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setConfig({
                          ...config,
                          universities: config.universities.filter(
                            (_, j) => j !== i,
                          ),
                        })
                      }
                    >
                      Remove university
                    </Button>
                  </fieldset>
                ))}
              </div>
              <Button
                className="mt-3"
                variant="outline"
                onClick={() =>
                  setConfig({
                    ...config,
                    universities: [
                      ...config.universities,
                      {
                        name: "",
                        country: "",
                        rank: null,
                        edition: "2026-2027",
                        sourceUrl: "",
                        aliases: [],
                      },
                    ],
                  })
                }
              >
                Add verified university
              </Button>
            </details>
            <div className="my-4 grid gap-4 md:grid-cols-2">
              <label className="text-sm">
                Google organizer email
                <Input
                  type="email"
                  value={config.connectedEmail}
                  onChange={(e) =>
                    setConfig({ ...config, connectedEmail: e.target.value })
                  }
                />
              </label>
              <label className="text-sm">
                SEEK job ID
                <Input
                  value={config.seekJobId}
                  onChange={(e) =>
                    setConfig({ ...config, seekJobId: e.target.value })
                  }
                />
              </label>
              <label className="text-sm">
                Office location
                <Input
                  value={config.location}
                  onChange={(e) =>
                    setConfig({ ...config, location: e.target.value })
                  }
                />
              </label>
              <label className="text-sm">
                Closed dates (YYYY-MM-DD, separated by commas)
                <Input
                  value={config.holidays.join(", ")}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      holidays: e.target.value
                        .split(",")
                        .map((v) => v.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
            </div>
            <p className="mb-3 text-sm">
              Google:{" "}
              {data.google.connected
                ? "Calendar and Sheets connected"
                : "Calendar consent needed"}
              .{" "}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={connect}
              >
                Connect Google
              </Button>
            </p>
            <div className="space-y-3">
              <h2 className="font-semibold">Mock interviewers</h2>
              <p className="text-sm text-muted-foreground">
                Give Peat and Ek both Mathematics and Physics. Only a
                registered, enabled tutor LINE group can receive a booking.
              </p>
              {config.interviewers.map((interviewer, i) => (
                <fieldset className="rounded-lg border p-3" key={i}>
                  <legend className="px-1 text-sm">Interviewer {i + 1}</legend>
                  <div className="flex flex-wrap gap-2">
                    <select
                      aria-label={`Interviewer ${i + 1}`}
                      className="rounded-md border bg-background p-2"
                      value={interviewer.canonicalKey}
                      onChange={(e) => {
                        const tutor = data.tutors.find(
                          (t) => t.canonicalKey === e.target.value,
                        );
                        setConfig({
                          ...config,
                          interviewers: config.interviewers.map((t, j) =>
                            j === i
                              ? {
                                  ...t,
                                  canonicalKey: e.target.value,
                                  email: tutor?.email ?? "",
                                }
                              : t,
                          ),
                        });
                      }}
                    >
                      <option value="">Choose tutor</option>
                      {data.tutors.map((t) => (
                        <option key={t.canonicalKey} value={t.canonicalKey}>
                          {t.name}
                          {t.lineReady ? "" : " — LINE needs setup"}
                        </option>
                      ))}
                    </select>
                    <Input
                      className="max-w-sm"
                      aria-label={`Interviewer ${i + 1} email`}
                      type="email"
                      value={interviewer.email}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          interviewers: config.interviewers.map((t, j) =>
                            j === i ? { ...t, email: e.target.value } : t,
                          ),
                        })
                      }
                    />
                    <Button
                      variant="outline"
                      onClick={() =>
                        setConfig({
                          ...config,
                          interviewers: config.interviewers.filter(
                            (_, j) => i !== j,
                          ),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                    {SUBJECTS.map((subject) => (
                      <label className="text-sm" key={subject}>
                        <input
                          type="checkbox"
                          className="mr-1"
                          checked={interviewer.subjects.includes(subject)}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              interviewers: config.interviewers.map((t, j) =>
                                j === i
                                  ? {
                                      ...t,
                                      subjects: e.target.checked
                                        ? [...t.subjects, subject]
                                        : t.subjects.filter(
                                            (s) => s !== subject,
                                          ),
                                    }
                                  : t,
                              ),
                            })
                          }
                        />
                        {subject}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              <Button
                variant="outline"
                onClick={() =>
                  setConfig({
                    ...config,
                    interviewers: [
                      ...config.interviewers,
                      { canonicalKey: "", email: "", subjects: [] },
                    ],
                  })
                }
              >
                Add interviewer
              </Button>
            </div>
            <div className="my-4 flex flex-wrap gap-5">
              <p>
                Weekend and weekday-after-15:00 teaching availability are
                required.
              </p>
              <label>
                <input
                  type="checkbox"
                  className="mr-2"
                  checked={config.rubricApproved}
                  onChange={(e) =>
                    setConfig({ ...config, rubricApproved: e.target.checked })
                  }
                />
                Rules approved
              </label>
              <label>
                <input
                  type="checkbox"
                  className="mr-2"
                  checked={config.enabled}
                  onChange={(e) =>
                    setConfig({ ...config, enabled: e.target.checked })
                  }
                />
                Enable automation
              </label>
              <label>
                <input
                  type="checkbox"
                  className="mr-2"
                  checked={config.deliveryEnabled}
                  onChange={(e) =>
                    setConfig({ ...config, deliveryEnabled: e.target.checked })
                  }
                />
                Enable messages
              </label>
            </div>
            <Button
              disabled={busy || total !== 100}
              onClick={() =>
                command({ action: "settings", revision: data.revision, config })
              }
            >
              Save rules and setup
            </Button>
          </details>
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-4">
              <h2 className="text-xl font-semibold">
                Candidates ({data.candidates.length})
              </h2>
              <Input
                className="max-w-md"
                placeholder="Search name, email, or stage"
                aria-label="Search candidates"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="p-3">Candidate</th>
                    <th className="p-3">Stage</th>
                    <th className="p-3">Profile score</th>
                    <th className="p-3">Subjects</th>
                  </tr>
                </thead>
                <tbody>
                  {data.candidates
                    .filter((c) =>
                      `${c.name} ${c.email} ${c.stage}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((c) => (
                      <tr key={c.id} className="border-t">
                        <td className="p-3">
                          <button
                            className="text-primary underline"
                            onClick={() => {
                              setSelected(c.id);
                              setSubjects(c.subjects);
                              setReason("");
                            }}
                          >
                            {c.name}
                          </button>
                          <p className="text-muted-foreground">
                            {c.email || "Email needs review"}
                          </p>
                        </td>
                        <td className="p-3">{c.stage.replaceAll("_", " ")}</td>
                        <td className="p-3">
                          {c.profileScore ?? "Not assessed"}
                        </td>
                        <td className="p-3">{c.subjects.join(", ")}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
          {candidate && (
            <section className="space-y-4 rounded-xl border bg-card p-5">
              <h2 className="text-xl font-semibold">{candidate.name}</h2>
              <p>{candidate.reviewNote}</p>
              {[candidate.profileAssessment, candidate.preScreenAssessment].map(
                (a, i) =>
                  a && (
                    <div key={i}>
                      <h3 className="font-semibold">
                        {i === 0 ? "Profile" : "Pre-screen"} evidence ·{" "}
                        {i === 0
                          ? candidate.profileScore
                          : candidate.preScreenScore}
                        /100
                      </h3>
                      <p className="my-2">{a.summary}</p>
                      {a.criteria.map((c) => (
                        <details key={c.id} className="border-t py-2">
                          <summary>
                            {weightLabels[c.id]}:{" "}
                            {c.result.replaceAll("_", " ")}
                          </summary>
                          <p className="mt-2 text-sm">{c.reason}</p>
                          <blockquote className="mt-2 border-l-2 pl-3 text-sm text-muted-foreground">
                            {c.evidence || "No evidence in source."}
                          </blockquote>
                        </details>
                      ))}
                    </div>
                  ),
              )}
              {candidate.universityAssessment && (
                <div className="rounded-lg border p-3">
                  <h3 className="font-semibold">
                    University prestige:{" "}
                    {Math.round(
                      candidate.universityAssessment.fraction *
                        config.profileWeights.prestige *
                        100,
                    ) / 100}
                    /{config.profileWeights.prestige}
                  </h3>
                  <p>
                    {candidate.universityAssessment.name ??
                      "University not confirmed"}
                  </p>
                  <p className="text-sm">
                    {candidate.universityAssessment.reason}
                  </p>
                  {candidate.universityAssessment.sources.map((source) => (
                    <a
                      className="mr-3 text-sm text-primary underline"
                      href={source}
                      key={source}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Source
                    </a>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                {SUBJECTS.map((subject) => (
                  <label className="text-sm" key={subject}>
                    <input
                      className="mr-1"
                      type="checkbox"
                      checked={subjects.includes(subject)}
                      onChange={(e) =>
                        setSubjects(
                          e.target.checked
                            ? [...subjects, subject]
                            : subjects.filter((v) => v !== subject),
                        )
                      }
                    />
                    {subject}
                  </label>
                ))}
              </div>
              <label className="block">
                Decision evidence or reason
                <textarea
                  className="mt-1 block w-full rounded-md border bg-background p-2"
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="For a paper pass, identify the marked assessment and the passed subjects."
                />
              </label>
              <div className="flex flex-wrap gap-3">
                {(
                  [
                    [
                      "advance",
                      candidate.preScreen
                        ? "Invite to paper assessment"
                        : "Invite to pre-screen",
                    ],
                    ["paper_pass", "Record paper pass and invite to mock"],
                    ["stop", "Stop processing"],
                  ] as const
                ).map(([action, label]) => (
                  <Button
                    key={action}
                    variant={action === "stop" ? "outline" : "default"}
                    disabled={
                      busy ||
                      reason.trim().length < 5 ||
                      (action !== "stop" && !subjects.length)
                    }
                    onClick={() =>
                      command({
                        action,
                        id: candidate.id,
                        revision: candidate.revision,
                        subjects,
                        reason,
                      })
                    }
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">
                These actions record a human decision. Stopping processing sends
                no rejection message.
              </p>
            </section>
          )}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">Appointments</h2>
            {data.bookings.length === 0 ? (
              <p>No appointments yet.</p>
            ) : (
              data.bookings.map((b) => (
                <p key={b.id} className="rounded-lg border p-3">
                  {data.candidates.find((c) => c.id === b.candidateId)?.name} ·{" "}
                  {b.kind} · {b.subjects.join(", ")} · {date(b.startTime)} ·{" "}
                  {b.interviewerKey ?? "Paper assessment"} · {b.status}
                </p>
              ))
            )}
          </section>
          <details className="rounded-xl border p-4">
            <summary className="cursor-pointer font-semibold">
              Message status ({data.outbox.length})
            </summary>
            <ul className="mt-3 space-y-2">
              {data.outbox.slice(0, 100).map((j) => (
                <li key={j.id}>
                  {data.candidates.find((c) => c.id === j.candidateId)?.name} ·{" "}
                  {j.kind} · {j.status}
                  {j.error && (
                    <span className="ml-2 text-red-700">{j.error}</span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </main>
  );
}

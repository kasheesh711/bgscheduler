"use client";

import type { HiringData } from "./dashboard";
import type { Insights } from "./pipeline-charts";
import css from "./dashboard.module.css";

const dateTime = (value: unknown) =>
  value
    ? new Date(String(value)).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Bangkok",
      })
    : "Not yet";

function Status({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <li className={css.statusRow}>
      <span>{label}</span>
      <span className={good ? css.goodWord : css.warnWord}>{value}</span>
    </li>
  );
}

export function OperationsRail({
  data,
  insights,
  busy,
  connect,
  onSelect,
}: {
  data: HiringData;
  insights: Insights;
  busy: boolean;
  connect: () => void;
  onSelect: (id: string) => void;
}) {
  const nameOf = (id: string | null) => data.candidates.find((c) => c.id === id)?.name ?? "Unknown candidate";
  const folders = data.workerSummary?.folders.filter((f) => f.count) ?? [];
  const folderTotal = folders.reduce((n, f) => n + f.count, 0);
  const problems = data.outbox.filter((j) => j.status === "failed" || j.status === "uncertain");
  const appointments = [...data.bookings].sort(
    (a, b) => new Date(String(b.startTime)).getTime() - new Date(String(a.startTime)).getTime(),
  );
  return (
    <aside className={css.rail} aria-label="Operations">
      <section className={css.railSection}>
        <h2 className={css.railTitle}>System</h2>
        <ul className={css.statusList}>
          <Status label="Automation" value={data.config.enabled ? "On" : "Paused"} good={data.config.enabled} />
          <Status label="Messages" value={data.config.deliveryEnabled ? "On" : "Paused"} good={data.config.deliveryEnabled} />
          <Status label="Production writes" value={data.writeGate ? "On" : "Off"} good={data.writeGate} />
          <Status label="Google" value={data.google.connected ? "Connected" : "Consent needed"} good={data.google.connected} />
          <li className={css.statusRow}>
            <span>Last worker run</span>
            <span>{dateTime(data.workerAt)}</span>
          </li>
        </ul>
        {!data.google.connected && (
          <button type="button" className={css.secondary} disabled={busy} onClick={connect}>
            Connect Google
          </button>
        )}
      </section>

      {data.workerSummary && (
        <section className={css.railSection}>
          <h2 className={css.railTitle}>SEEK folders</h2>
          <p className={css.railLede}>
            {data.workerSummary.scanned} read · {data.workerSummary.remaining} waiting for import
          </p>
          <div
            className={css.folderBar}
            role="img"
            aria-label={folders.map((f) => `${f.status} ${f.count}`).join(", ")}
          >
            {folders.map((f, i) => (
              <span key={f.status} data-step={i} style={{ flexGrow: f.count }} />
            ))}
          </div>
          <ul className={css.folderList}>
            {folders.map((f, i) => (
              <li key={f.status}>
                <i data-step={i} aria-hidden="true" />
                <span>{f.status}</span>
                <span className={css.num}>{f.count}</span>
                <span className={css.folderShare}>{Math.round((f.count / folderTotal) * 100)}%</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={css.railSection}>
        <h2 className={css.railTitle}>Interviewers</h2>
        <ul className={css.railList}>
          {data.config.interviewers.map((person) => {
            const tutor = data.tutors.find((t) => t.canonicalKey === person.canonicalKey);
            return (
              <li key={person.canonicalKey} className={css.interviewer}>
                <span className={css.railName}>{tutor?.name ?? person.canonicalKey}</span>
                <span className={css.railMeta}>
                  {person.subjects.length} {person.subjects.length === 1 ? "subject" : "subjects"} · {insights.upcomingByInterviewer[person.canonicalKey]} upcoming
                </span>
                {!tutor?.lineReady && <span className={css.warnWord}>LINE needs setup</span>}
              </li>
            );
          })}
          {!data.config.interviewers.length && <li className={css.railMeta}>No interviewers set.</li>}
        </ul>
      </section>

      <section className={css.railSection}>
        <h2 className={css.railTitle}>Appointments</h2>
        {appointments.length === 0 ? (
          <p className={css.railLede}>No appointments yet.</p>
        ) : (
          <ul className={css.railList}>
            {appointments.map((b) => (
              <li key={b.id}>
                <button type="button" className={css.railLink} onClick={() => onSelect(b.candidateId)}>
                  {nameOf(b.candidateId)}
                </button>
                <span className={css.railMeta}>
                  {dateTime(b.startTime)} · {b.kind === "mock" ? "Mock" : "Paper"} · {b.subjects.join(", ")}
                </span>
                <span className={css.railMeta}>
                  {b.interviewerKey ?? "Paper assessment"} · {b.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={css.railSection}>
        <h2 className={css.railTitle}>Messages</h2>
        <p className={css.railLede}>
          {insights.messages.sent} sent · {insights.messages.waiting} waiting · {insights.messages.problems} problems
        </p>
        {problems.length > 0 && (
          <ul className={css.railList}>
            {problems.map((j) => (
              <li key={j.id}>
                <span className={css.railName}>{nameOf(j.candidateId)}</span>
                <span className={css.railMeta}>{j.kind} · {j.status}</span>
                {j.error && <span className={css.errorText}>{j.error}</span>}
              </li>
            ))}
          </ul>
        )}
        {data.outbox.length > 0 && (
          <details className={css.railDetails}>
            <summary>Latest {Math.min(100, data.outbox.length)} of {data.outbox.length} messages</summary>
            <ul className={css.railList}>
              {data.outbox.slice(0, 100).map((j) => (
                <li key={j.id}>
                  <span className={css.railName}>{nameOf(j.candidateId)}</span>
                  <span className={css.railMeta}>{j.kind} · {j.status}</span>
                  {j.error && <span className={css.errorText}>{j.error}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className={css.railSection}>
        <h2 className={css.railTitle}>Recent activity</h2>
        <ul className={css.railList}>
          {data.audit.slice(0, 12).map((row) => (
            <li key={row.id}>
              <span className={css.railName}>{row.action.replaceAll("-", " ").replaceAll("_", " ")}</span>
              <span className={css.railMeta}>
                {row.candidateId ? `${nameOf(row.candidateId)} · ` : ""}{dateTime(row.createdAt)}
              </span>
            </li>
          ))}
          {!data.audit.length && <li className={css.railMeta}>No activity yet.</li>}
        </ul>
      </section>
    </aside>
  );
}

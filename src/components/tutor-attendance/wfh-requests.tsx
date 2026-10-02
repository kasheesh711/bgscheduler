"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { AttendanceOverview } from "@/lib/tutor-attendance/data";
import css from "./workspace.module.css";

export type AttendanceSave = (
  url: string,
  body: unknown,
  message: string,
  method?: string,
) => Promise<boolean>;
type WfhRequest = AttendanceOverview["wfhRequests"][number];
const api = "/api/tutor-attendance/wfh";
const displayDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  });

export function WfhRequests({
  payload,
  busy,
  save,
}: {
  payload: AttendanceOverview;
  busy: boolean;
  save: AttendanceSave;
}) {
  const [date, setDate] = useState(payload.today);
  const [reason, setReason] = useState("");
  const id = useId();
  const requestKey = useRef<{ body: string; key: string } | null>(null);
  const alreadyRequested = payload.wfhRequests.some(
    (r) =>
      r.canonicalKey === payload.access.canonicalKey &&
      r.date === date &&
      (r.status === "pending" || r.status === "approved"),
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = JSON.stringify({ date, reason: reason.trim() });
    if (requestKey.current?.body !== body)
      requestKey.current = { body, key: crypto.randomUUID() };
    if (
      await save(
        api,
        { date, reason, idempotencyKey: requestKey.current.key },
        "WFH requested. Wait for approval before clocking from home.",
      )
    ) {
      setReason("");
      requestKey.current = null;
    }
  }
  const requests = [...payload.wfhRequests].sort(
    (a, b) =>
      Number(b.status === "pending" && b.date >= payload.today) -
      Number(a.status === "pending" && a.date >= payload.today),
  );
  return (
    <>
      {payload.access.canonicalKey && (
        <section className={css.panel}>
          <h2>Request a WFH day</h2>
          <p className={css.muted}>
            Choose one whole day and give a reason. Your usual hours apply. An
            administrator must approve before you clock from home.
          </p>
          <form className={css.form} onSubmit={submit}>
            <div className={css.field}>
              <label htmlFor={`${id}-date`}>WFH date (Bangkok)</label>
              <input
                id={`${id}-date`}
                className={css.input}
                type="date"
                min={payload.today}
                required
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
            <div className={css.field}>
              <label htmlFor={`${id}-reason`}>Reason for WFH</label>
              <textarea
                id={`${id}-reason`}
                className={css.input}
                rows={3}
                required
                minLength={3}
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            {alreadyRequested && (
              <p className={css.muted}>
                You already have a pending or approved request for this date.
              </p>
            )}
            <div className={css.actions}>
              <Button
                type="submit"
                disabled={
                  busy ||
                  alreadyRequested ||
                  date < payload.today ||
                  reason.trim().length < 3
                }
              >
                Request WFH
              </Button>
            </div>
          </form>
        </section>
      )}
      <section className={css.panel}>
        <h2>
          {payload.access.admin ? "Review WFH requests" : "Your WFH requests"}
        </h2>
        <p className={css.muted}>
          Approved WFH can be cancelled before attendance is recorded. Once
          clocking starts, the day’s work location is fixed.
        </p>
        <div className={`${css.list} mt-5`}>
          {requests.map((request) => (
            <WfhRequestCard
              key={`${request.id}:${request.revision}`}
              request={request}
              today={payload.today}
              name={
                payload.tutors.find(
                  (t) => t.canonicalKey === request.canonicalKey,
                )?.name ?? request.canonicalKey
              }
              busy={busy}
              save={save}
            />
          ))}
          {!requests.length && (
            <p className={css.empty}>No WFH requests yet.</p>
          )}
        </div>
      </section>
    </>
  );
}

function WfhRequestCard({
  request,
  name,
  today,
  busy,
  save,
}: {
  request: WfhRequest;
  name: string;
  today: string;
  busy: boolean;
  save: AttendanceSave;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  const expired = request.status === "pending" && request.date < today;
  const status = expired
    ? "Date passed"
    : {
        pending: "Awaiting approval",
        approved: "Approved",
        rejected: "Rejected",
        cancelled: "Cancelled",
      }[request.status];
  const decide = (decision: "approved" | "rejected" | "cancelled") =>
    save(
      `${api}/${request.id}`,
      {
        decision,
        reason,
        expectedRevision: request.revision,
      },
      `WFH ${decision}.`,
      "PATCH",
    );
  return (
    <article className={css.request} aria-label={`${name} WFH ${request.date}`}>
      <div className={css.requestHead}>
        <div>
          <h3>{name}</h3>
          <span className={css.muted}>
            {displayDate(request.date)} · Whole-day WFH
          </span>
        </div>
        <span
          className={`${css.pill} ${request.status === "approved" ? css.good : ""}`}
        >
          {status}
        </span>
      </div>
      <p className={css.muted}>{request.reason}</p>
      {request.reviewedAt && (
        <p className={css.muted}>
          {request.status === "rejected" ? "Rejected" : "Approved"} by{" "}
          {request.reviewedBy} · {request.reviewReason}
        </p>
      )}
      {request.cancelledAt && (
        <p className={css.muted}>
          Cancelled by {request.cancelledBy} · {request.cancellationReason}
        </p>
      )}
      {request.locationLocked && request.status === "pending" && (
        <p className={css.muted}>
          Attendance has already been recorded. This date can no longer be
          approved for WFH.
        </p>
      )}
      {expired && (
        <p className={css.muted}>
          This date has passed. WFH cannot be approved retrospectively.
        </p>
      )}
      {(request.canReject || request.canCancel) && (
        <div className={css.divider}>
          <div className={css.field}>
            <label htmlFor={id}>
              {request.canReject ? "Review reason" : "Cancellation reason"}
            </label>
            <input
              id={id}
              className={css.input}
              value={reason}
              minLength={3}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <div className={`${css.actions} mt-3`}>
            {request.canReject && (
              <>
                <Button
                  disabled={
                    busy || !request.canApprove || reason.trim().length < 3
                  }
                  onClick={() => void decide("approved")}
                >
                  Approve WFH
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || reason.trim().length < 3}
                  onClick={() => void decide("rejected")}
                >
                  Reject WFH
                </Button>
              </>
            )}
            {request.canCancel && (
              <Button
                variant="ghost"
                disabled={busy || reason.trim().length < 3}
                onClick={() => void decide("cancelled")}
              >
                Cancel WFH
              </Button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

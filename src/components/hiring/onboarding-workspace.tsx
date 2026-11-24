"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { expertsRoster } from "@/lib/hiring/experts";
import type { onboardingRoster } from "@/lib/hiring/onboarding";
import { tutorGroupName, type tutorGroupTemplate } from "@/lib/hiring/onboarding-config";

type Hires = Awaited<ReturnType<typeof onboardingRoster>>;
type Experts = Awaited<ReturnType<typeof expertsRoster>>;
type Template = ReturnType<typeof tutorGroupTemplate>;
type Input = Record<string, unknown>;
type Send = (input: Input) => Promise<void>;

const inputStyle = "min-h-9 w-full rounded-md border px-2 py-1";
const date = (value: Date) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

function Form({ children, label, pending, onSubmit }: {
  children?: ReactNode; label: string; pending: boolean; onSubmit: (values: FormData) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  }
  return <form className="grid max-w-lg gap-2" onSubmit={submit}>
    {children}
    <Button className="w-fit" size="sm" variant="outline" type="submit" disabled={pending}>{label}</Button>
  </form>;
}

function Check({ children }: { children: ReactNode }) {
  return <label className="flex items-start gap-2">
    <input className="mt-1" type="checkbox" name="confirmed" required />
    <span>{children}</span>
  </label>;
}

const reasonLabel = {
  join: "Unknown member joined",
  message: "Message from unknown member",
  "identity-missing": "LINE did not identify a member",
  "bot-left": "Experts bot left the group",
  revoked: "Access revoked",
};

function ExpertCases({ experts, pending, send }: { experts: Experts; pending: boolean; send: Send }) {
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  async function lookup(id: string) {
    setProfiles((previous) => ({ ...previous, [id]: "Checking LINE…" }));
    let label: string;
    try {
      const response = await fetch(`/api/hiring/onboarding?case=${encodeURIComponent(id)}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error();
      label = result.available
        ? result.displayName ?? "LINE returned the account without a display name."
        : "LINE did not return a profile. Check the group member list.";
    } catch {
      label = "Could not check LINE. Try again.";
    }
    setProfiles((previous) => ({ ...previous, [id]: label }));
  }
  return <div className="grid gap-3">
    <h3 className="font-semibold">Open cases ({experts.cases.length})</h3>
    {!experts.cases.length && <p className="text-sm text-muted-foreground">No open cases.</p>}
    {experts.cases.map((row) => <article className="grid gap-2 rounded-lg border p-3 text-sm" id={`case-${row.id}`} key={row.id}>
      <h4 className="font-medium">{reasonLabel[row.reason]}</h4>
      <p>{date(row.occurredAt)} Bangkok · Alert {row.alertStatus === "review" ? "needs delivery review" : row.alertStatus}</p>
      {row.lineUserId && <>
        <code className="break-all text-xs">{row.lineUserId}</code>
        <Button size="sm" variant="ghost" className="w-fit" type="button" onClick={() => void lookup(row.id)}>Look up LINE account</Button>
        {profiles[row.id] && <p role="status">{profiles[row.id]}</p>}
      </>}
      <Form label="Close case" pending={pending} onSubmit={(values) => void send({ action: "resolve-case", caseId: row.id, outcome: values.get("outcome") })}>
        <label className="grid gap-1">
          Result
          <select required name="outcome" className={inputStyle} defaultValue="">
            <option value="" disabled>Select a result</option>
            {row.reason === "bot-left" ? <option value="bot-restored">Official Account restored in LINE</option> : <>
              <option value="removed">Removed in LINE</option>
              <option value="verified-absent">Account already absent</option>
              {!row.lineUserId && <option value="roster-checked">Roster checked in LINE</option>}
            </>}
          </select>
        </label>
      </Form>
    </article>)}
  </div>;
}

function ExpertsPanel({ experts, pending, send }: { experts: Experts; pending: boolean; send: Send }) {
  if (!experts.group) return <p>Configure the exact Experts group and Official Account to start.</p>;
  const unresolved = experts.members.filter((member) => !member.lineUserId && !member.revokedAt);
  const approved = experts.members.filter((member) => !member.revokedAt);
  return <div className="grid gap-4">
    <p className="text-sm">{experts.group.name} · Alerts {experts.alerts && experts.baseline ? "on" : "off"}</p>
    {!experts.baseline ? <Form label="Approve current roster" pending={pending} onSubmit={(values) => void send({
      action: "baseline", count: Number(values.get("count")),
      unresolved: String(values.get("unresolved")).split("\n").map((label) => label.trim()).filter(Boolean),
      confirmed: values.get("confirmed") === "on",
    })}>
      <p>Regenerate the old invite link and QR code in LINE, then turn off link and QR invitations.</p>
      <label className="grid gap-1">Number of current members, excluding the Official Account
        <input className={inputStyle} type="number" name="count" required min="1" max="500" />
      </label>
      <label className="grid gap-1">Members whose account IDs LINE did not return, one per line
        <textarea className={inputStyle} name="unresolved" rows={3} maxLength={60500} />
      </label>
      <Check>I checked the current group and confirmed that link and QR invitations are off.</Check>
    </Form> : <>
      <p className="text-sm">
        Roster captured {date(experts.baseline.capturedAt)} Bangkok. {approved.length} members approved. {unresolved.length} account IDs need review.
      </p>
      {unresolved.length > 0 && <p className="text-sm">Check names on the baseline in LINE before removing a member whose account is unknown.</p>}
      <Button size="sm" variant="outline" className="w-fit" disabled={pending} onClick={() => void send({ action: "reconcile" })}>Compare with LINE roster</Button>
      <ExpertCases experts={experts} pending={pending} send={send} />
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Safe list ({approved.length})</summary>
        <ul className="mt-3 grid gap-3">
          {experts.members.map((member) => <li className="grid gap-2 border-b pb-3 text-sm last:border-0" key={member.id}>
            {member.label && <strong>{member.label}</strong>}
            <span className="break-all">{member.lineUserId ?? "Account ID needs review"} · {member.source === "hire" ? "New hire" : "Original roster"}{member.revokedAt && " · Revoked"}</span>
            {!member.lineUserId && !member.revokedAt && <Form label="Verify account ID" pending={pending} onSubmit={(values) => void send({
              action: "resolve-baseline", memberId: member.id, lineUserId: values.get("lineUserId"),
            })}>
              <label className="grid gap-1">Verified LINE account ID
                <input required name="lineUserId" className={inputStyle} pattern="U[0-9a-f]{32}" maxLength={33} />
              </label>
              <Check>I verified this is the same person from the original roster.</Check>
            </Form>}
            {!member.revokedAt && <Button className="w-fit" size="sm" variant="outline" disabled={pending} onClick={() => {
              if (window.confirm("Revoke Experts approval and open a removal case?")) void send({ action: "revoke", memberId: member.id });
            }}>Revoke access</Button>}
          </li>)}
        </ul>
      </details>
    </>}
  </div>;
}

function Hire({ item, template, pending, send }: { item: Hires[number]; template: Template; pending: boolean; send: Send }) {
  const { record, approvedAt, revokedAt, binding, stage } = item;
  const { intake, candidateId } = record;
  const preflight = record.signedAt && record.lineUserId;
  const approved = !!approvedAt && !revokedAt;
  const action = (name: string, extra?: Input) => void send({ action: name, candidateId, ...extra });
  const fields = [
    ["Legal name", intake.legalName], ["Preferred name", intake.preferredName], ["Phone", intake.phone],
    ["Onsite Wise email", intake.onsiteEmail], ["Online Wise email", intake.onlineEmail],
    ["Searchable LINE ID", intake.lineId], ["Earliest start", intake.earliestStart],
  ];
  return <details className="rounded-lg border p-4">
    <summary className="cursor-pointer font-medium">{item.name} · {record.tutorGroupReadyAt ? "Tutor group ready"
      : record.joinedAt && approved ? "In Experts" : approved ? "Experts approved" : preflight ? "Review access" : "Onboarding submitted"}</summary>
    <div className="mt-4 grid gap-4 text-sm">
      <dl className="grid gap-2 sm:grid-cols-2">
        {fields.map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}
        <div><dt className="text-muted-foreground">Verified LINE account</dt>
          <dd className="break-all">{record.lineUserId ? [record.lineName, record.lineUserId].filter(Boolean).join(" · ") : "Awaiting LINE sign-in"}</dd></div>
        <div><dt className="text-muted-foreground">Contract signed</dt><dd>{record.signedAt ? date(record.signedAt) : "Awaiting confirmation"}</dd></div>
      </dl>
      {stage !== "hired" ? <p>This application is no longer active.</p> : <>
        {!record.signedAt && <Form pending={pending} label="Record signed contract" onSubmit={() => action("signed")}>
          <Check>I saw the signed contract.</Check>
        </Form>}
        {record.lineUserId && !approvedAt && <Button className="w-fit" size="sm" variant="outline" disabled={pending} onClick={() => {
          if (window.confirm("Clear the linked account so the candidate can sign in again?")) action("reset-line");
        }}>Clear linked LINE account</Button>}
        {preflight && !approved && <Form pending={pending} label="Approve Experts access" onSubmit={() => action("approve", { verified: true })}>
          <Check>I checked the submitted details and verified the LINE account with the tutor.</Check>
        </Form>}
        {approved && <section className="grid gap-2">
          <h3 className="font-medium">Experts group</h3>
          {record.joinedAt ? <p>Membership confirmed {date(record.joinedAt)}.</p> : record.invitedAt
            ? <><p>Direct invitation recorded {date(record.invitedAt)}.</p><Button className="w-fit" size="sm" variant="outline" disabled={pending} onClick={() => action("joined")}>Verify membership in LINE</Button></>
            : <Form pending={pending} label="Record direct invitation" onSubmit={() => action("invited")}>
              <Check>I invited this account directly in LINE.</Check>
            </Form>}
        </section>}
        {preflight && <section className="grid gap-2">
          <h3 className="font-medium">{tutorGroupName(intake.preferredName)}</h3>
          {record.tutorGroupReadyAt ? <p>Group and Progress Check ready · {date(record.tutorGroupReadyAt)}</p>
            : !template ? <p>Set the approved tutor group template and admin roster first.</p> : <>
              <p>Use {template.name} as the template. Create the group in LINE. Add the tutor, Thea, and these admins.</p>
              <ul className="list-disc pl-5">{template.admins.map((name) => <li key={name}>{name}</li>)}</ul>
              {!record.tutorKey ? <Form pending={pending} label="Save active tutor key" onSubmit={(values) => action("tutor-key", { key: values.get("key") })}>
                <label className="grid gap-1">Tutor key after both Wise accounts appear
                  <input required name="key" className={inputStyle} maxLength={160} />
                </label>
              </Form> : <>
                <p>Have a LINE bot admin send <code>/progress setup {record.tutorKey}</code> in the new group. Check Thea’s reply.</p>
                {binding?.tutorBot && binding.name === tutorGroupName(intake.preferredName) &&
                  <Form pending={pending} label="Mark group ready and enable Progress Check" onSubmit={() => action("ready", { verified: true })}>
                    <Check>I checked the tutor, all listed admins, Thea’s reply, and any applicable subject-group invites.</Check>
                  </Form>}
              </>}
            </>}
        </section>}
      </>}
    </div>
  </details>;
}

export function OnboardingWorkspace({ hires, experts, template, formEnabled }: {
  hires: Hires; experts: Experts; template: Template; formEnabled: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, setPending] = useState(false);

  async function send(input: Input) {
    setPending(true);
    try {
      const response = await fetch("/api/hiring/onboarding", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save the change.");
      setMessage({ text: "Saved.", error: false });
      router.refresh();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Could not save the change.", error: true });
    } finally { setPending(false); }
  }

  return <>
    {message && <p className="sticky top-2 z-10 rounded-md border bg-background p-3 text-sm"
      role={message.error ? "alert" : "status"}>{message.text}</p>}
    <section className="grid gap-3 rounded-xl border p-4 sm:p-5">
      <h2 className="text-lg font-semibold">BeGifted Experts</h2>
      <ExpertsPanel experts={experts} pending={pending} send={(input) => send({ ...input, area: "experts" })} />
    </section>
    <section className="grid gap-3">
      <h2 className="text-lg font-semibold">New hires</h2>
      {!formEnabled && <p className="text-sm text-muted-foreground">The form link is off for new offers.</p>}
      {!hires.length && <p className="text-sm text-muted-foreground">No onboarding forms received.</p>}
      {hires.map((item) => <Hire key={item.record.candidateId} item={item} template={template} pending={pending} send={send} />)}
    </section>
  </>;
}

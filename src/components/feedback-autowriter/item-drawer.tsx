"use client";

import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import { HOLD_REASON_CATEGORY_LABELS, holdReasonCategory, holdReasonLabel } from "@/lib/feedback-autowriter/hold-reasons";
import { failedPostTitle, holdUrgency, incidentTitle, isListedIncident, type InboxItem } from "@/lib/feedback-autowriter/inbox";
import type { AutowriterReview, ReviewQueueItem } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import { Tag, Upper, type Tone } from "./atoms";
import { POSTED_STATES, STATE_TONE, stateLabel } from "./class-states";
import { deadlineCountdown, minutes, usd, when } from "./format";
import { ARM_LABEL } from "./model-labels";
import { FeedbackFields, ReviewDetail } from "./review-detail";
import { AtomEvidencePanel } from "./atom-review";
import { VerdictForm } from "./verdict-form";

// ----------------------------------------------------------------------------
// The detail drawer: one right-hand sheet for whatever the owner opened (a post
// to review, a held class, a failed post, an incident, or any class of the log).
// It reads the page's current payloads, so a reload shows the item as it is now
// — except a post to review, which stays as it was when it opened (see
// `nextReviewPin`): its verdict is checked against what the owner read.
// ----------------------------------------------------------------------------

type Hold = AutowriterDashboard["holds"][number];
type FailedPost = AutowriterDashboard["failedPosts"][number];
type ClassRow = AutowriterDashboard["recent"][number];
type Incident = AutowriterReview["incidents"][number];

/** What the drawer shows, by the key the page's payloads know it by. */
export type DrawerTarget =
  | { kind: "review"; wiseSessionId: string }
  | { kind: "hold"; wiseSessionId: string }
  | { kind: "failed_post"; wiseSessionId: string }
  | { kind: "class"; wiseSessionId: string }
  | { kind: "incident"; incidentId: string };

/** The target's data as the page holds it now; `missing` when a reload no longer has it. */
export type DrawerContent =
  | { kind: "review"; item: ReviewQueueItem }
  | { kind: "hold"; hold: Hold; row: ClassRow | null }
  | { kind: "failed_post"; post: FailedPost; row: ClassRow | null; reviewable: boolean }
  | { kind: "class"; row: ClassRow }
  | { kind: "incident"; incident: Incident; about: { target: DrawerTarget; label: string } | null }
  | { kind: "missing" };

const URGENCY_TONE: Record<InboxItem["urgency"], Tone> = { critical: "red", soon: "amber", normal: "neutral" };

/**
 * Where a class opens: a held one as a hold, a posted one the review data knows as a review, a failed post as such,
 * any other class of the log on its own. Null for a class the page does not hold.
 */
export function targetForClass(
  wiseSessionId: string,
  dashboard: Pick<AutowriterDashboard, "holds" | "failedPosts" | "recent">,
  review: Pick<AutowriterReview, "queue"> | null,
): DrawerTarget | null {
  if (dashboard.holds.some((row) => row.wiseSessionId === wiseSessionId)) return { kind: "hold", wiseSessionId };
  if (review?.queue.some((item) => item.wiseSessionId === wiseSessionId)) return { kind: "review", wiseSessionId };
  if (dashboard.failedPosts.some((row) => row.wiseSessionId === wiseSessionId)) return { kind: "failed_post", wiseSessionId };
  if (dashboard.recent.some((row) => row.wiseSessionId === wiseSessionId)) return { kind: "class", wiseSessionId };
  return null;
}

/** Where a to-do item opens; null for the items later PRs add (decisions, the expansion confirmation). */
export function drawerTargetFor(item: Pick<InboxItem, "id" | "kind" | "wiseSessionId">): DrawerTarget | null {
  if (item.kind === "incident") return { kind: "incident", incidentId: item.id.slice("incident:".length) };
  if (!item.wiseSessionId) return null;
  if (item.kind === "hold" || item.kind === "review" || item.kind === "failed_post") return { kind: item.kind, wiseSessionId: item.wiseSessionId };
  return null;
}

/** The data of a drawer target from the page's current payloads. */
export function resolveDrawer(target: DrawerTarget, dashboard: AutowriterDashboard, review: AutowriterReview | null): DrawerContent {
  if (target.kind === "incident") {
    const incident = review?.incidents.find((entry) => entry.id === target.incidentId);
    if (!incident) return { kind: "missing" };
    const about = incident.wiseSessionId ? targetForClass(incident.wiseSessionId, dashboard, review) : null;
    return { kind: "incident", incident, about: about ? { target: about, label: classLabel(about, dashboard, review) } : null };
  }
  const row = dashboard.recent.find((entry) => entry.wiseSessionId === target.wiseSessionId) ?? null;
  if (target.kind === "review") {
    const item = review?.queue.find((entry) => entry.wiseSessionId === target.wiseSessionId);
    return item ? { kind: "review", item } : { kind: "missing" };
  }
  if (target.kind === "hold") {
    const hold = dashboard.holds.find((entry) => entry.wiseSessionId === target.wiseSessionId);
    return hold ? { kind: "hold", hold, row } : { kind: "missing" };
  }
  if (target.kind === "failed_post") {
    const post = dashboard.failedPosts.find((entry) => entry.wiseSessionId === target.wiseSessionId);
    if (!post) return { kind: "missing" };
    return { kind: "failed_post", post, row, reviewable: Boolean(review?.queue.some((item) => item.wiseSessionId === post.wiseSessionId)) };
  }
  return row ? { kind: "class", row } : { kind: "missing" };
}

/**
 * A post to review as a comparable version: everything the drawer shows of it, the first shot, the current verdict and
 * the open flags a verdict is checked against among them. The lists the database returns in no fixed order are sorted
 * by id, so a reload that brings nothing new is the same version.
 */
export function reviewVersion(item: ReviewQueueItem): string {
  return JSON.stringify({
    ...item,
    openFlags: item.openFlags.toSorted((a, b) => a.id.localeCompare(b.id)),
    fixEvents: item.fixEvents.toSorted((a, b) => a.wiseEventId.localeCompare(b.wiseEventId)),
  });
}

/** A post to review as the drawer holds it: the version it pinned, and how many times the owner reloaded it. */
export interface ReviewPin {
  target: DrawerTarget;
  item: ReviewQueueItem;
  reloads: number;
}

/**
 * The version of a post to review the drawer shows. A target it did not show before is pinned as the page has it now;
 * the same target keeps its pin while the polling brings newer versions (the verdict is checked against what the
 * owner read, as the server's 409 expects), until the owner reloads it (`reload`): then the version the page has now
 * is pinned, and the form starts afresh.
 */
export function nextReviewPin(pin: ReviewPin | null, target: DrawerTarget, current: ReviewQueueItem, reload = false): ReviewPin {
  if (reload) return { target, item: current, reloads: (pin?.target === target ? pin.reloads : 0) + 1 };
  return pin?.target === target ? pin : { target, item: current, reloads: 0 };
}

/** The version the page has now, when it is not the pinned one: the drawer says so instead of swapping it in. */
export function newerReview(pinned: ReviewQueueItem, current: ReviewQueueItem): ReviewQueueItem | null {
  return current === pinned || reviewVersion(current) === reviewVersion(pinned) ? null : current;
}

/** "Anna · Year 9 Maths · 6 Oct, 13:00" for the class a target points at. */
function classLabel(target: DrawerTarget, dashboard: AutowriterDashboard, review: AutowriterReview | null): string {
  if (target.kind === "incident") return "";
  const id = target.wiseSessionId;
  const known = review?.queue.find((item) => item.wiseSessionId === id)
    ?? dashboard.holds.find((row) => row.wiseSessionId === id)
    ?? dashboard.failedPosts.find((row) => row.wiseSessionId === id);
  if (known) return [known.tutor, known.className, when(known.classEndedAt)].filter(Boolean).join(" · ");
  const row = dashboard.recent.find((entry) => entry.wiseSessionId === id);
  return row ? [row.tutor, row.className, when(row.scheduledEndAt)].filter(Boolean).join(" · ") : "";
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-4">
      <Upper className="block">{label}</Upper>
      {children}
    </section>
  );
}

function WiseLink({ href }: { href: string | null }) {
  return href ? <a className="text-xs text-primary underline underline-offset-2" href={href} target="_blank" rel="noreferrer">Open in Wise</a> : null;
}

/** The draft a row stores and what the judge said about it; nothing when the row stores neither. */
function StoredDraft({ row, label }: { row: Pick<ClassRow, "fields" | "judgeUnsupported"> | null; label: string }) {
  if (!row?.fields && !row?.judgeUnsupported.length) return null;
  return (
    <>
      {row.fields ? <Block label={label}><FeedbackFields fields={row.fields} /></Block> : null}
      {row.judgeUnsupported.length > 0 ? (
        <Block label="The judge's problems">
          <ul className="list-disc space-y-1 pl-4 text-xs text-amber-800 dark:text-amber-200">
            {row.judgeUnsupported.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        </Block>
      ) : null}
    </>
  );
}

/**
 * A posted class to judge: the detail, then the owner's verdict form (everyone else reads). `item` is the version the
 * drawer pinned; `newer`, the page's newer version of it: then a notice (kept in view while the body scrolls) offers
 * `onReload`, and nothing is swapped under the form.
 */
export function ReviewBody({ item, newer = null, canControl, onRecorded, onReload }: {
  item: ReviewQueueItem;
  newer?: ReviewQueueItem | null;
  canControl: boolean;
  onRecorded: (outcome: "recorded" | "stale") => Promise<void> | void;
  onReload?: () => void;
}) {
  return (
    <div className="space-y-4">
      {newer ? (
        <div role="status" data-review-changed=""
          className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <span>
            {canControl
              ? "This class changed since you opened it — reload it before recording a verdict."
              : "This class changed since you opened it — reload it to see it as it is now."}
          </span>
          {onReload ? <Button size="sm" variant="outline" className="h-7 bg-background" onClick={onReload}>Reload</Button> : null}
        </div>
      ) : null}
      <ReviewDetail item={item} />
      {canControl
        ? <VerdictForm key={item.wiseSessionId} item={item} onRecorded={onRecorded} />
        : <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Only the owner records verdicts.</p>}
      <WiseLink href={item.wiseUrl} />
    </div>
  );
}

/** A held class: why, until when, what is stored, and what the judge said. */
export function HoldBody({ hold, row, now }: { hold: Hold; row: ClassRow | null; now: Date }) {
  const written = hold.resolvedBy === "tutor_wrote";
  const overdue = hold.deadlineAt !== null && new Date(hold.deadlineAt).getTime() <= now.getTime();
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Upper className="block">Why it is held</Upper>
        <p className="text-sm font-medium">{holdReasonLabel(hold.reason)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Tag>{HOLD_REASON_CATEGORY_LABELS[holdReasonCategory(hold.reason)]}</Tag>
          {written
            ? <Tag tone="green">Written by a person since</Tag>
            : <Tag tone={URGENCY_TONE[holdUrgency(hold.deadlineAt, now)]}>{deadlineCountdown(hold.deadlineAt, now)}</Tag>}
        </div>
        <p className="text-xs text-muted-foreground">
          {written
            ? "The class has feedback in Wise now, written by a person, so it no longer waits for anyone. The autowriter does not touch a held class again."
            : overdue
              ? "Nothing was posted, and the feedback deadline has passed. The class still needs a person to write it."
              : "Nothing was posted. The class needs a person to write it before the deadline."}
        </p>
      </div>
      <Block label="The class">
        <Facts rows={[
          ["Tutor", hold.tutor],
          ["Class", hold.className ?? "—"],
          ["Class ended", when(hold.classEndedAt)],
          ["Feedback deadline", when(hold.deadlineAt)],
          ["Alert emailed", hold.alertSentAt ? when(hold.alertSentAt) : "Not emailed"],
        ]} />
      </Block>
      <StoredDraft row={row} label="Stored draft (not posted)" />
      {hold.hasDraft && !row?.fields ? (
        <Block label="Stored draft (not posted)">
          <p className="text-xs text-muted-foreground">A judged draft is stored with the class; this page loads the text of recent classes only.</p>
        </Block>
      ) : null}
      {hold.reason ? (
        <Block label="Reason as recorded">
          <p className="break-words font-mono text-[11px] text-muted-foreground">{hold.reason}</p>
        </Block>
      ) : null}
      <WiseLink href={hold.wiseUrl} />
    </div>
  );
}

const FAILED_POST_MEANING: Record<FailedPost["state"], string> = {
  verify_failed: "The POST went out, but the class read back from Wise did not match what was sent. Wise may hold the text, or part of it.",
  unknown_outcome: "The POST got no answer we could read, so the text may or may not be in Wise.",
  rejected: "Wise refused the POST. Unless the submission changed at the same moment, nothing of ours is in the class.",
};

/** A post that did not end well: what happened, the class, what was sent. */
export function FailedPostBody({ post, row, reviewable, onOpen }: {
  post: FailedPost;
  row: ClassRow | null;
  reviewable: boolean;
  onOpen?: (target: DrawerTarget) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Upper className="block">What happened</Upper>
        <p className="text-sm font-medium">{failedPostTitle(post.state)}</p>
        <p className="text-xs text-muted-foreground">{FAILED_POST_MEANING[post.state]} Open the class in Wise and check what is there.</p>
      </div>
      <Block label="The class">
        <Facts rows={[
          ["Tutor", post.tutor],
          ["Class", post.className ?? "—"],
          ["Class ended", when(post.classEndedAt)],
          ["Outcome", <Tag key="state" tone="red">{stateLabel(post.state)}</Tag>],
          ...(post.reason && post.reason !== post.state ? [["Reason as recorded", post.reason] as [string, ReactNode]] : []),
        ]} />
      </Block>
      <StoredDraft row={row} label="Text that was sent" />
      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        {reviewable && onOpen ? (
          <Button size="sm" variant="outline" onClick={() => onOpen({ kind: "review", wiseSessionId: post.wiseSessionId })}>Open its review</Button>
        ) : null}
        <WiseLink href={post.wiseUrl} />
      </div>
    </div>
  );
}

/** Any other class of the log: where it stands and what is stored with it. */
export function ClassBody({ row }: { row: ClassRow }) {
  const written = row.arm ? ARM_LABEL[row.arm] ?? row.arm : null;
  const posted = POSTED_STATES.has(row.state);
  return (
    <div className="space-y-4">
      <Facts rows={[
        ["State", <Tag key="state" tone={STATE_TONE[row.state] ?? "neutral"}>{stateLabel(row.state)}</Tag>],
        ["Tutor", row.tutor.replace(/ Online$/u, "")],
        ["Class", row.className ?? "—"],
        ["Class ended", when(row.scheduledEndAt)],
        ...(written ? [["Written by", `${written}${row.evidence === "transcript" ? " · transcript" : " · summary"}`] as [string, ReactNode]] : []),
        ...(row.postStartedAt ? [["Posted", `${when(row.postStartedAt)} · ${minutes(row.latencyMinutes)} after the class`] as [string, ReactNode]] : []),
        ...(row.summaryFallback ? [["Evidence", row.summaryFallback.label] as [string, ReactNode]] : []),
        ["Model cost", usd(row.costUsd)],
        ...(row.reason && !["shadow", "verified"].includes(row.reason) ? [["Reason as recorded", row.reason] as [string, ReactNode]] : []),
      ]} />
      <StoredDraft row={row} label={posted ? "Text that was posted" : "Stored draft (not posted)"} />
      {!row.fields ? <p className="border-t pt-4 text-xs text-muted-foreground">No draft stored.</p> : null}
      {posted ? (
        <p className="text-xs text-muted-foreground">This post is not in the review data the page has: the review job records a new post within the hour.</p>
      ) : null}
      <WiseLink href={row.wiseUrl} />
    </div>
  );
}

function AcknowledgeButton({ incidentId, onAcknowledged }: { incidentId: string; onAcknowledged: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acknowledge = async () => {
    if (!window.confirm("Acknowledge this incident? Its pushes stop and it no longer keeps the review job red.")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/feedback-autowriter/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge", incidentId }),
      });
      if (!response.ok) {
        const json = await response.json().catch(() => null) as { error?: unknown } | null;
        setError(typeof json?.error === "string" ? json.error : `HTTP ${response.status}`);
        return;
      }
      await onAcknowledged();
    } catch {
      setError("Could not acknowledge.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void acknowledge()}>Acknowledge</Button>
      {error ? <span role="status" className="text-xs text-red-700">{error}</span> : null}
    </span>
  );
}

/** An incident: what happened, how the alert went, the class it is about, and the owner's Acknowledge. */
export function IncidentBody({ incident, about, canControl, onAcknowledged, onOpen }: {
  incident: Incident;
  about: { target: DrawerTarget; label: string } | null;
  canControl: boolean;
  onAcknowledged: () => Promise<void> | void;
  onOpen?: (target: DrawerTarget) => void;
}) {
  const open = isListedIncident(incident);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Upper className="block">What happened</Upper>
        <p className="text-sm font-medium">{incidentTitle(incident.kind)}</p>
        <p className="text-xs text-muted-foreground">{incident.summary}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={incident.severity === "critical" ? "red" : "neutral"}>{incident.severity === "critical" ? "Critical" : "Info"}</Tag>
          {incident.acknowledgedAt ? <Tag tone="green">Acknowledged</Tag> : null}
        </div>
      </div>
      <Block label="The record">
        <Facts rows={[
          ["Raised", when(incident.createdAt)],
          ...(incident.severity === "critical"
            ? [["Alert", `push ${incident.pushStatus === "failed" ? "FAILED — not delivered" : incident.pushStatus}${incident.lastPushError ? ` · ${incident.lastPushError}` : ""}`] as [string, ReactNode]]
            : []),
          ...(incident.acknowledgedAt
            ? [["Acknowledged", `acknowledged by ${incident.acknowledgedBy ?? "—"} · ${when(incident.acknowledgedAt)}`] as [string, ReactNode]]
            : []),
        ]} />
      </Block>
      {incident.wiseSessionId ? (
        <Block label="The class">
          {about ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span>{about.label}</span>
              {onOpen ? <Button size="sm" variant="outline" onClick={() => onOpen(about.target)}>Open the class</Button> : null}
            </div>
          ) : <p className="text-xs text-muted-foreground">The class is not among those this page loads (session {incident.wiseSessionId}).</p>}
        </Block>
      ) : null}
      {open ? (
        <div className="space-y-2 border-t pt-4">
          {canControl
            ? <AcknowledgeButton incidentId={incident.id} onAcknowledged={onAcknowledged} />
            : <p className="text-xs text-muted-foreground">Only the owner acknowledges incidents.</p>}
          <p className="text-xs text-muted-foreground">
            {incident.severity === "critical"
              ? "Acknowledging stops the alert's pushes, and an undelivered alert no longer keeps the review job red."
              : "Style results are shown here only, never pushed. Acknowledging takes it off the list."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function headline(content: DrawerContent): { title: string; description: string } {
  switch (content.kind) {
    case "review":
      return { title: `Review · ${content.item.tutor}`, description: [content.item.className, `class ended ${when(content.item.classEndedAt)}`].filter(Boolean).join(" · ") };
    case "hold":
      return { title: `Held · ${content.hold.tutor}`, description: [content.hold.className, `class ended ${when(content.hold.classEndedAt)}`].filter(Boolean).join(" · ") };
    case "failed_post":
      return { title: `Failed post · ${content.post.tutor}`, description: [content.post.className, `class ended ${when(content.post.classEndedAt)}`].filter(Boolean).join(" · ") };
    case "class":
      return { title: `${stateLabel(content.row.state)} · ${content.row.tutor.replace(/ Online$/u, "")}`, description: [content.row.className, `class ended ${when(content.row.scheduledEndAt)}`].filter(Boolean).join(" · ") };
    case "incident":
      return { title: "Incident", description: `Raised ${when(content.incident.createdAt)}` };
    case "missing":
      return { title: "No longer here", description: "The page was refreshed and this item is not on it any more." };
  }
}

const SHEET = "top-0 right-0 left-auto flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-l p-0 data-open:zoom-in-100 data-closed:zoom-out-100";

/**
 * The right-hand sheet. `onChanged` reloads the page data. After a verdict or an acknowledgement went through, the
 * sheet closes, the page says so (`onSaved`) and the data reloads, in that order: a sheet the owner opens meanwhile is
 * not closed by the reload's end. A stale page (HTTP 409) reloads the data and leaves the sheet open on its error,
 * with the newer version of the class behind Reload.
 *
 * A post to review is pinned as it was when it opened (`nextReviewPin`): the 5-minute poll never swaps it under the
 * verdict form, whose request carries the pinned first shot, current verdict and open flags.
 *
 * Opening the sheet puts the focus on its scrolling body, never on a control: the first one of a review is Approve,
 * which records at once, so a Space meant to scroll would approve the post.
 */
export function ItemDrawer({ target, dashboard, review, now, canControl, onChanged, onSaved, onOpen, onClose }: {
  target: DrawerTarget | null;
  dashboard: AutowriterDashboard;
  review: AutowriterReview | null;
  now: Date;
  canControl: boolean;
  onChanged: () => Promise<void> | void;
  /** What the page says once a verdict or an acknowledgement went through: the sheet itself is closed by then. */
  onSaved: (note: string) => void;
  onOpen: (target: DrawerTarget) => void;
  onClose: () => void;
}) {
  // The sheet fades out after `target` is cleared: it keeps what it showed until it is gone, instead of going blank.
  const [held, setHeld] = useState(target);
  if (target !== null && target !== held) setHeld(target);
  const shown = target ?? held;
  const content = shown ? resolveDrawer(shown, dashboard, review) : null;
  const [pin, setPin] = useState<ReviewPin | null>(null);
  const pinned = shown && content?.kind === "review" ? nextReviewPin(pin, shown, content.item) : null;
  if (pinned && pinned !== pin) setPin(pinned);
  const { title, description } = content ? headline(content) : { title: "", description: "" };
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const done = async (note: string) => {
    onClose();
    onSaved(note);
    await onChanged();
  };
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent initialFocus={bodyRef}
        className={cn(SHEET, content?.kind === "review" ? "sm:max-w-[min(960px,calc(100vw-2rem))]" : "sm:max-w-[560px]")}>
        <DialogHeader className="shrink-0 gap-1 border-b px-5 py-4 pr-12">
          <DialogTitle className="text-[15px] font-semibold tracking-tight">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>
        <div ref={bodyRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 outline-none">
          {content?.kind === "review" && shown && pinned ? (
            <ReviewBody key={`${pinned.item.wiseSessionId}:${pinned.reloads}`} item={pinned.item} newer={newerReview(pinned.item, content.item)}
              canControl={canControl} onReload={() => setPin(nextReviewPin(pinned, shown, content.item, true))}
              onRecorded={async (outcome) => { if (outcome === "recorded") await done("Verdict recorded."); else await onChanged(); }} />
          ) : null}
          {content?.kind === "hold" ? <HoldBody hold={content.hold} row={content.row} now={now} /> : null}
          {content?.kind === "failed_post"
            ? <FailedPostBody post={content.post} row={content.row} reviewable={content.reviewable} onOpen={onOpen} /> : null}
          {content?.kind === "class" ? <ClassBody row={content.row} /> : null}
          {content?.kind === "incident" ? (
            <IncidentBody incident={content.incident} about={content.about} canControl={canControl} onAcknowledged={() => done("Incident acknowledged.")}
              onOpen={onOpen} />
          ) : null}
          {target && "wiseSessionId" in target && content?.kind !== "missing" ? <div className="mt-4"><AtomEvidencePanel key={target.wiseSessionId} sessionId={target.wiseSessionId} /></div> : null}
          {content?.kind === "missing" ? <p className="text-xs text-muted-foreground">Close this and look at the list again.</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

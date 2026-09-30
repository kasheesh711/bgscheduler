"use client";

import type { ReactNode } from "react";
import { Check, CircleAlert, Clock, FileText, Split, TriangleAlert, UserPlus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import { INBOX_GROUPS, flagReasons, type InboxItem, type InboxItemKind } from "@/lib/feedback-autowriter/inbox";
import type { AutowriterReview } from "@/lib/feedback-autowriter/review-data";
import { cn } from "@/lib/utils";
import { CountChip, Panel, Tag, Upper, type Tone } from "./atoms";
import { stateLabel } from "./class-states";
import { clock, dayOf, deadlineCountdown, when, whenAfter } from "./format";
import { drawerTargetFor, type DrawerTarget } from "./item-drawer";
import { ARM_LABEL } from "./model-labels";

// ----------------------------------------------------------------------------
// "What needs you": the owner's to-do list, grouped. The items come from
// `buildInbox`; each row adds what the page's payloads know about its class.
// ----------------------------------------------------------------------------

const GROUP_VIEW: Record<InboxItemKind, { icon: LucideIcon; note: string }> = {
  incident: { icon: TriangleAlert, note: "Critical · not acknowledged" },
  hold: { icon: Clock, note: "Not posted · needs a person before the deadline" },
  review: { icon: FileText, note: "Posted · awaiting your verdict" },
  decision: { icon: Split, note: "From the forward scan" },
  failed_post: { icon: CircleAlert, note: "The post did not end well · check Wise" },
  expansion_ready: { icon: UserPlus, note: "The gate passed" },
};

const TILE_TONE: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  blue: "bg-sky-50 text-sky-600 dark:bg-sky-950 dark:text-sky-300",
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300",
  green: "bg-available/10 text-available",
  red: "bg-conflict/10 text-conflict",
};

const ACTION_TONE: Record<Tone, string> = {
  neutral: "",
  blue: "border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 hover:text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  amber: "border-amber-200 bg-amber-50/70 text-amber-800 hover:bg-amber-100 hover:text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  green: "border-available/30 bg-available/10 text-available",
  red: "border-conflict/30 bg-conflict/5 text-conflict hover:bg-conflict/10 hover:text-conflict",
};

const ACTION_LABEL: Record<InboxItem["action"], string> = { open: "Open", review: "Review", decide: "Decide", confirm: "Confirm" };
const URGENCY_TONE: Record<InboxItem["urgency"], Tone> = { critical: "red", soon: "amber", normal: "neutral" };

/** What one row shows: built per kind from the item and the page's payloads. */
interface RowView {
  tile: Tone;
  action: Tone;
  title: ReactNode;
  tags: ReactNode;
  sub: string;
}

function joined(...parts: Array<string | null | false | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function rowView(item: InboxItem, dashboard: AutowriterDashboard, review: AutowriterReview | null, now: Date): RowView {
  // The roster's keys are the names the team calls its tutors by; anyone else shows under their label.
  const name = (tutorKey: string | null, label: string) => tutorKey && dashboard.tutors.some((tutor) => tutor.tutorKey === tutorKey) ? tutorKey : label;
  if (item.kind === "review") {
    const post = review?.queue.find((entry) => entry.wiseSessionId === item.wiseSessionId);
    const flagged = post?.status === "flagged";
    return {
      tile: flagged ? "amber" : "blue",
      action: "blue",
      title: post
        ? <>{name(post.tutorKey, post.tutor)} <span className="font-normal text-muted-foreground">· {when(post.classEndedAt)} class</span></>
        : item.title,
      tags: post ? (
        <>
          <Tag tone={post.firstShot.evidence === "transcript" ? "blue" : "neutral"}>{post.firstShot.evidence === "transcript" ? "Transcript" : "Summary"}</Tag>
          {flagged ? <Tag tone="amber">Flagged</Tag> : null}
        </>
      ) : null,
      sub: post ? joined(
        post.className,
        `Posted ${whenAfter(post.classEndedAt, post.firstShot.postStartedAt)}`,
        post.firstShot.arm ? ARM_LABEL[post.firstShot.arm] ?? post.firstShot.arm : null,
        flagged && flagReasons(post.openFlags),
      ) : item.detail,
    };
  }
  if (item.kind === "hold") {
    const hold = dashboard.holds.find((entry) => entry.wiseSessionId === item.wiseSessionId);
    return {
      tile: item.urgency === "critical" ? "red" : "amber",
      action: item.urgency === "critical" ? "red" : "amber",
      title: hold ? `${name(hold.tutorKey, hold.tutor)} · ${item.title}` : item.title,
      tags: <Tag tone={URGENCY_TONE[item.urgency]}>{deadlineCountdown(item.deadlineAt, now)}</Tag>,
      sub: hold ? joined(
        `${when(hold.classEndedAt)} class`, hold.className, "Held", hold.deadlineAt && `due ${when(hold.deadlineAt)}`, hold.hasDraft && "draft stored",
      ) : item.detail,
    };
  }
  if (item.kind === "incident") {
    const incident = review?.incidents.find((entry) => `incident:${entry.id}` === item.id);
    const tutor = item.tutorKey ? dashboard.tutors.find((entry) => entry.tutorKey === item.tutorKey)?.tutorKey ?? null : null;
    return {
      tile: "red",
      action: "red",
      title: item.title,
      tags: <Tag tone="red">Critical{incident ? ` · ${dayOf(incident.createdAt)}` : ""}</Tag>,
      sub: joined(tutor, item.detail),
    };
  }
  if (item.kind === "failed_post") {
    const post = dashboard.failedPosts.find((entry) => entry.wiseSessionId === item.wiseSessionId);
    return {
      tile: "red",
      action: "neutral",
      title: post ? `${name(post.tutorKey, post.tutor)} · ${item.title}` : item.title,
      tags: post ? <Tag tone="red">{stateLabel(post.state)}</Tag> : null,
      sub: post ? joined(`${when(post.classEndedAt)} class`, post.className) : item.detail,
    };
  }
  return { tile: "blue", action: "neutral", title: item.title, tags: null, sub: item.detail };
}

export function Inbox({ items, dashboard, review, now, filteredTo, reviewUnavailable, onOpen, className }: {
  /** The to-do list in display order (`buildInbox`), already narrowed to the tutor filter. */
  items: readonly InboxItem[];
  dashboard: AutowriterDashboard;
  /** The review data, or null while it is unavailable. */
  review: AutowriterReview | null;
  /** The instant the countdowns are read against (the payload's clock). */
  now: Date;
  /** The name of the tutor the page is filtered to. */
  filteredTo: string | null;
  reviewUnavailable: boolean;
  onOpen: (target: DrawerTarget) => void;
  className?: string;
}) {
  const groups = INBOX_GROUPS.map((group) => ({ ...group, items: items.filter((item) => item.kind === group.kind) })).filter((group) => group.items.length > 0);
  return (
    <Panel aria-labelledby="autowriter-inbox-title" className={cn("flex flex-col", className)}>
      <div className="flex items-center justify-between gap-3 border-b px-5 py-[19px]">
        <div className="flex items-center gap-[9px]">
          <h2 id="autowriter-inbox-title" className="text-sm font-[650] tracking-[-0.02em]">What needs you</h2>
          <CountChip>{items.length} open</CountChip>
        </div>
        <span className="text-[11px] text-muted-foreground">{filteredTo ? `filtered to ${filteredTo}` : "Nothing urgent is hidden below."}</span>
      </div>

      {groups.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 border-b px-5 py-14 text-center">
          <span className="grid size-9 place-items-center rounded-full bg-available/10 text-available"><Check aria-hidden className="size-4" /></span>
          <p className="text-sm font-[550]">Nothing needs you.</p>
          <p className="max-w-xs text-[11px] text-muted-foreground">
            {filteredTo
              ? `${filteredTo} has no post to review, no held class and no failed post.`
              : "New posts to review, held classes and incidents appear here as they happen."}
          </p>
        </div>
      ) : (
        <div className="flex-1">
          {groups.map((group) => {
            const { icon: Icon, note } = GROUP_VIEW[group.kind];
            const critical = group.kind === "incident";
            return (
              <div key={group.kind} data-group={group.kind}>
                <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-5 py-[9px]">
                  <span className="flex items-center gap-[7px]">
                    <Icon aria-hidden className={cn("size-[13px]", critical ? "text-conflict" : "text-muted-foreground")} />
                    <Upper>{group.label}</Upper>
                    <CountChip className={critical ? "bg-conflict/10 text-conflict" : undefined}>{group.items.length}</CountChip>
                  </span>
                  <span className="text-[10px] text-muted-foreground">{note}</span>
                </div>
                <ul>
                  {group.items.map((item) => {
                    const view = rowView(item, dashboard, review, now);
                    const target = drawerTargetFor(item);
                    return (
                      <li key={item.id} data-tutor={item.tutorKey ?? undefined}
                        className={cn("flex min-h-16 items-center gap-[11px] border-b px-5 py-3", critical && "bg-conflict/[0.03]")}>
                        <span className={cn("grid size-[29px] shrink-0 place-items-center rounded-[7px]", TILE_TONE[view.tile])}>
                          <Icon aria-hidden className="size-4" strokeWidth={1.6} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-[1.45] font-[550]">
                            <span>{view.title}</span>
                            {view.tags}
                          </div>
                          <div className="mt-1 text-[10px] leading-[1.4] text-muted-foreground">{view.sub}</div>
                        </div>
                        {target ? (
                          <Button size="sm" variant="outline" onClick={() => onOpen(target)}
                            className={cn("h-7 min-w-[63px] rounded-md px-2.5 text-[11px] font-[550]", ACTION_TONE[view.action])}>
                            {ACTION_LABEL[item.action]}
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {reviewUnavailable ? (
        <p className="border-t bg-amber-50/60 px-5 py-2.5 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          The posts to review and the incidents could not load, so this list has the held classes and the failed posts only.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3 px-5 py-3 text-[10px] text-muted-foreground">
        <span>Sorted by action type, then deadline</span>
        <span className="flex items-center gap-[5px]"><Check aria-hidden className="size-3" /> Synced at {clock(dashboard.generatedAt)}</span>
      </div>
    </Panel>
  );
}

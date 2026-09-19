import type { OverflowAction, OverflowPlan, StudentModeEvidence } from "@/lib/classrooms/overflow-types";

const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const date = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" }).format(new Date(value));
const labels = { minimum_proven: "Minimum proven", best_found: "Best found", no_complete_solution: "No complete solution", unverified: "Unverified" };
const evidenceLabels = { verified_switches: "Verified onsite-to-online switches", online_attendance: "Past online attendance", onsite_only: "Known onsite-only history", unknown: "Unknown history" };
const roomLabel = (room: string) => room === "NO_ROOM_AVAILABLE" ? "No room assigned" : room === "REMOTE_NO_ROOM_NEEDED" ? "Teach elsewhere" : room;

export function StudentEvidence({ evidence }: { evidence: StudentModeEvidence }) {
  return <div className="mt-2 space-y-1 text-xs text-muted-foreground">
    <p className="font-medium text-foreground">{evidenceLabels[evidence.tier]}</p>
    {evidence.tier === "verified_switches" ? <p>{evidence.verifiedSwitches} verified switches / {evidence.observedOnsiteLessons} observed onsite opportunities. Adjusted frequency: {evidence.verifiedSwitches} / ({evidence.observedOnsiteLessons} + 3) = {(evidence.adjustedFrequency * 100).toFixed(1)}%.</p>
      : evidence.tier !== "unknown" ? <p>{evidence.onlineAttended} online / {evidence.attendedLessons} attended lessons. Online attendance is a fallback indicator, not a confirmed switching rate. Adjusted frequency: {evidence.onlineAttended} / ({evidence.attendedLessons} + 3) = {(evidence.adjustedFrequency * 100).toFixed(1)}%.</p>
        : <p>No verified attendance history is available for this student.</p>}
    <p>180-day lookback · {evidence.firstLessonAt && evidence.lastLessonAt ? `Observed lessons: ${date(evidence.firstLessonAt)}–${date(evidence.lastLessonAt)}` : "Observed period unavailable"}.</p>
  </div>;
}

function ActionList({ actions }: { actions: OverflowAction[] }) {
  return <ul className="grid gap-3 md:grid-cols-2">{actions.map(action => <li key={action.wiseSessionId} className="min-w-0 rounded-lg border bg-background p-3">
    <div className="flex flex-wrap justify-between gap-1 text-sm font-medium"><span>{action.student || "Class"} · {action.tutor}</span><span className="font-mono text-xs">{time(action.startMinute)}–{time(action.endMinute)}</span></div>
    <p className="mt-1 break-words text-sm">{roomLabel(action.originalRoom)} → <strong>{action.teachingLocation === "elsewhere" ? "Teach elsewhere — classroom released" : roomLabel(action.room)}</strong></p>
    {action.released && action.teachingLocation !== "elsewhere" && <p className="mt-1 text-xs text-muted-foreground">Dedicated online room. The onsite classroom must be released for the full lesson.</p>}
    {action.evidence && <StudentEvidence evidence={action.evidence} />}
  </li>)}</ul>;
}

export function OverflowPlanSection({ plan, stale = false, headingId = "overflow-plan-title" }: { plan: OverflowPlan | null; stale?: boolean; headingId?: string }) {
  if (!plan) return null;
  const actualOnline = plan.actualActions.filter(action => action.kind === "relocate_online");
  const conversions = plan.proposedActions.filter(action => action.kind === "switch_to_online");
  const proposedOther = plan.proposedActions.filter(action => action.kind !== "switch_to_online");
  const actualOther = plan.actualActions.filter(action => action.kind !== "relocate_online");
  const accommodated = plan.predictedAssignments.filter(row => plan.accommodatedSessionIds.includes(row.wiseSessionId));
  return <section aria-labelledby={headingId} className="shrink-0 rounded-xl border border-amber-300/70 bg-amber-50/40 p-4 dark:bg-amber-950/10">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id={headingId} className="text-base font-semibold">Overflow plan</h2>
      <span className="rounded-full border bg-background px-2.5 py-1 text-xs font-medium">{stale ? "Stale — refresh required" : labels[plan.status]}</span>
    </div>
    <p className="mt-2 text-sm">{plan.baselineOverflow} {plan.baselineOverflow === 1 ? "class" : "classes"} initially without a room. {plan.actualRemainingOverflow} {plan.actualRemainingOverflow === 1 ? "remains" : "remain"} after room changes and existing-online relocations.</p>
    <p className="mt-1 text-sm font-medium">{plan.minimumSwitches !== null ? `${plan.minimumSwitches} student ${plan.minimumSwitches === 1 ? "switch" : "switches"} needed for a complete plan.`
      : plan.proposedSwitches ? `${plan.proposedSwitches} student switches in the best plan found; a minimum is not proven.` : "A complete plan has not been verified."}
      {plan.switchLowerBound !== null && plan.minimumSwitches === null ? ` Lower bound: ${plan.switchLowerBound}.` : ""}</p>
    <p className="mt-1 text-sm text-muted-foreground">{plan.predictedRemainingOverflow === 0 && plan.status !== "unverified" ? "All classes fit only if the listed actions are completed. " : `${plan.predictedRemainingOverflow} classes remain without a room in this scenario. `}Proposed switches stay hypothetical until fresh Wise data confirms the lesson is online. Recommendations do not clear readiness warnings.</p>
    {stale && <p role="status" className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-300">This plan uses older source data. Sync and regenerate before acting.</p>}
    {actualOnline.length > 0 && <div className="mt-4 space-y-2"><h3 className="text-sm font-semibold">Already-online lessons to relocate · {actualOnline.length}</h3><ActionList actions={actualOnline} /></div>}
    {conversions.length > 0 && <div className="mt-4 space-y-2"><h3 className="text-sm font-semibold">Proposed student switches · {conversions.length}</h3><ActionList actions={conversions} /></div>}
    {(actualOther.length > 0 || proposedOther.length > 0) && <details className="mt-4 rounded-lg border bg-background p-3">
      <summary className="cursor-pointer text-sm font-medium">Before / after classroom changes</summary>
      {actualOther.length > 0 && <div className="mt-3 space-y-2"><h3 className="text-xs font-medium">Saved allocation using actual modalities</h3><ActionList actions={actualOther} /></div>}
      {proposedOther.length > 0 && <div className="mt-3 space-y-2"><h3 className="text-xs font-medium">Conditional room plan after student switches</h3><ActionList actions={proposedOther} /></div>}
    </details>}
    {accommodated.length > 0 && <div className="mt-4 text-sm"><h3 className="font-semibold">Overflow classes accommodated in this scenario</h3><ul className="mt-1 space-y-1">{accommodated.map(row => <li key={row.wiseSessionId}>{time(row.startMinute)}–{time(row.endMinute)} · {row.student || "Class"} · {row.tutor} → {row.released && row.status === "remote" ? "Teach elsewhere" : row.room}</li>)}</ul></div>}
    {plan.warnings.length > 0 && <ul className="mt-3 space-y-1 text-sm text-amber-800 dark:text-amber-300">{plan.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    {!plan.rankingComplete && plan.status !== "unverified" && <p className="mt-2 text-xs text-muted-foreground">History ranking or classroom preferences were not fully verified before the search ended.</p>}
    <p className="mt-3 text-xs text-muted-foreground">Generated {date(plan.generatedAt)} · {new Date(plan.generatedAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })} Bangkok · Search {(plan.elapsedMs / 1000).toFixed(1)}s / 30s budget.</p>
  </section>;
}

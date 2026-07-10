"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CircleCheckIcon,
  CircleIcon,
  ExternalLinkIcon,
  LanguagesIcon,
  LogOutIcon,
  UsersIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import type { LinkedFamilyCase } from "@/lib/admissions/family-cases";
import type {
  ParentAcademicRecord,
  ParentDashboard,
  ParentDeadline,
  ParentFinancialAidOffer,
  ParentPhaseProgress,
  ParentTestingMilestone,
} from "@/lib/admissions/parent-projection";
import { isSafeAdmissionsUrl } from "@/lib/admissions/shared/urls";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { cn } from "@/lib/utils";
import {
  PARENT_APP_STATUS_STRINGS,
  PARENT_CASE_STATUS_STRINGS,
  PARENT_DEADLINE_SOURCE_STRINGS,
  PARENT_DECISION_STRINGS,
  PARENT_ESSAY_STATUS_STRINGS,
  PARENT_LOCALE_STORAGE_KEY,
  PARENT_RECOMMENDER_STATUS_STRINGS,
  PARENT_SCHOLARSHIP_STATUS_STRINGS,
  PARENT_STRINGS,
  PARENT_TASK_OWNER_STRINGS,
  PARENT_TASK_STATUS_STRINGS,
  PARENT_TEST_STATUS_STRINGS,
  PARENT_TEST_TYPE_STRINGS,
  formatParentString,
  pickParentString,
  readStoredParentLocale,
  writeStoredParentLocale,
  type ParentBilingualString,
  type ParentLocale,
} from "./strings";

export const PARENT_SECTION_TEST_IDS = [
  "parent-header",
  "parent-profile",
  "parent-academics",
  "parent-checklist",
  "parent-deadlines",
  "parent-colleges",
  "parent-recommenders",
  "parent-essays",
  "parent-activities",
  "parent-awards",
  "parent-testing",
  "parent-money",
  "parent-announcements",
  "parent-notes",
] as const;

export interface ParentDeadlineGroup {
  key: string;
  kind: "overdue" | "thisWeek" | "nextWeek" | "laterWeek";
  weekStart: string | null;
  items: ParentDeadline[];
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function epochDayOf(dateOnly: string): number | null {
  const match = DATE_ONLY_PATTERN.exec(dateOnly);
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY);
}

function mondayEpochDayOf(day: number): number {
  return day - ((((day + 3) % 7) + 7) % 7);
}

function isoFromEpochDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function groupParentDeadlinesByWeek(
  deadlines: ParentDeadline[],
  todayIso: string,
): ParentDeadlineGroup[] {
  const todayDay = epochDayOf(todayIso);
  const todayMonday = todayDay === null ? null : mondayEpochDayOf(todayDay);
  const overdueItems: ParentDeadline[] = [];
  const byOffset = new Map<number, ParentDeadline[]>();
  const unknownItems: ParentDeadline[] = [];

  for (const item of deadlines) {
    if (item.overdue) {
      overdueItems.push(item);
      continue;
    }
    const itemDay = epochDayOf(item.date);
    if (itemDay === null || todayMonday === null) {
      unknownItems.push(item);
      continue;
    }
    const offset = Math.max(0, (mondayEpochDayOf(itemDay) - todayMonday) / 7);
    const bucket = byOffset.get(offset);
    if (bucket) bucket.push(item);
    else byOffset.set(offset, [item]);
  }

  const byDate = (a: ParentDeadline, b: ParentDeadline) => a.date.localeCompare(b.date);
  const groups: ParentDeadlineGroup[] = [];
  if (overdueItems.length > 0) {
    groups.push({
      key: "overdue",
      kind: "overdue",
      weekStart: null,
      items: overdueItems.slice().sort(byDate),
    });
  }
  for (const offset of Array.from(byOffset.keys()).sort((a, b) => a - b)) {
    groups.push({
      key: `week-${offset}`,
      kind: offset === 0 ? "thisWeek" : offset === 1 ? "nextWeek" : "laterWeek",
      weekStart: todayMonday === null ? null : isoFromEpochDay(todayMonday + offset * 7),
      items: byOffset.get(offset)!.slice().sort(byDate),
    });
  }
  if (unknownItems.length > 0) {
    groups.push({ key: "week-unknown", kind: "laterWeek", weekStart: null, items: unknownItems });
  }
  return groups;
}

function formatDateOnly(value: string): string {
  const match = DATE_ONLY_PATTERN.exec(value);
  return match ? `${Number(match[3])}/${Number(match[2])}/${match[1]}` : value;
}

function formatBangkokTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function formatMoney(value: number | string | null, currency: string): string {
  if (value === null || value === "") return "—";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString("en-US")}`;
  }
}

function humanizeKey(key: string): string {
  return key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(", ");
  return null;
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

function SafeExternalLink({ href, label }: { href: string; label: string }) {
  if (!isSafeAdmissionsUrl(href)) return <span className="break-all text-sm">{href}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-11 max-w-full items-center gap-1.5 break-all text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ExternalLinkIcon aria-hidden className="size-4 shrink-0" />
      {label}
    </a>
  );
}

function ParentPhaseRing({ ring }: { ring: ParentPhaseProgress }) {
  const size = 64;
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div data-testid="parent-phase-ring" className="flex min-w-0 flex-col items-center gap-1">
      <div role="img" aria-label={`${ring.label}: ${ring.percent}%`} className="relative">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle cx={32} cy={32} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-muted" />
          <circle
            cx={32}
            cy={32}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ring.percent / 100)}
            transform="rotate(-90 32 32)"
            className="stroke-primary"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold">{ring.percent}%</span>
      </div>
      <span className="max-w-24 break-words text-center text-xs leading-tight text-muted-foreground">{ring.label}</span>
    </div>
  );
}

function MilestoneStep({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      {done ? (
        <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-available" />
      ) : (
        <CircleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />
      )}
      <span className={cn("text-xs", done ? "font-medium" : "text-muted-foreground")}>{label}</span>
    </li>
  );
}

function TestingMilestoneRow({
  milestone,
  locale,
}: {
  milestone: ParentTestingMilestone;
  locale: ParentLocale;
}) {
  const t = (entry: ParentBilingualString) => pickParentString(entry, locale);
  const scoreDetails = milestone.scoreDetails
    ? Object.entries(milestone.scoreDetails).filter(([key]) => key !== "testType")
    : [];
  return (
    <li data-testid="parent-milestone-row" className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">
            {t(PARENT_TEST_TYPE_STRINGS[milestone.testType])}
            {milestone.subject ? ` · ${milestone.subject}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatParentString(PARENT_STRINGS.testingDate, locale, { date: formatDateOnly(milestone.testDate) })}
          </p>
        </div>
        <Badge variant="secondary">{t(PARENT_TEST_STATUS_STRINGS[milestone.status])}</Badge>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        <MilestoneStep done={milestone.registered} label={t(PARENT_STRINGS.testingRegistered)} />
        <MilestoneStep done={milestone.taken} label={t(PARENT_STRINGS.testingTaken)} />
        <MilestoneStep done={milestone.scoreReceived} label={t(PARENT_STRINGS.testingScoreReceived)} />
      </ul>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        {milestone.registrationDeadline ? (
          <p>{formatParentString(PARENT_STRINGS.testingRegistrationDeadline, locale, { date: formatDateOnly(milestone.registrationDeadline) })}</p>
        ) : null}
        {milestone.lateRegistrationDeadline ? (
          <p>{formatParentString(PARENT_STRINGS.testingLateDeadline, locale, { date: formatDateOnly(milestone.lateRegistrationDeadline) })}</p>
        ) : null}
      </div>
      {milestone.score !== undefined ? (
        <p data-testid="parent-milestone-score" className="text-sm">
          {t(PARENT_STRINGS.testingScore)}: <span className="font-semibold tabular-nums">{milestone.score}</span>
        </p>
      ) : null}
      {scoreDetails.length > 0 ? (
        <div data-testid="parent-score-details" className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t(PARENT_STRINGS.testingScoreDetails)}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            {scoreDetails.map(([key, value]) => (
              <div key={key} className="min-w-0">
                <dt className="truncate text-muted-foreground">{humanizeKey(key)}</dt>
                <dd className="font-medium tabular-nums">{String(value ?? "—")}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </li>
  );
}

function AcademicRecordCard({ record, locale }: { record: ParentAcademicRecord; locale: ParentLocale }) {
  const t = (entry: ParentBilingualString) => pickParentString(entry, locale);
  const payload = record.payload;
  const summary: Array<[string, string]> = [];
  if (payload.system === "us") {
    if (payload.unweightedGpa != null) summary.push(["GPA", `${payload.unweightedGpa}/${payload.gpaScale}`]);
    if (payload.weightedGpa != null) summary.push([locale === "th" ? "GPA ถ่วงน้ำหนัก" : "Weighted GPA", String(payload.weightedGpa)]);
    if (payload.coreGpa != null) summary.push(["Core GPA", String(payload.coreGpa)]);
    if (payload.classRank != null) summary.push([locale === "th" ? "อันดับชั้นเรียน" : "Class rank", `${payload.classRank}/${payload.classSize ?? "—"}`]);
    if (payload.courseRigor) summary.push([locale === "th" ? "ความเข้มข้นรายวิชา" : "Course rigor", humanizeKey(payload.courseRigor)]);
  } else if (payload.system === "ib") {
    if (payload.predictedTotal != null) summary.push([locale === "th" ? "คะแนนคาดการณ์" : "Predicted total", `${payload.predictedTotal}/45`]);
    if (payload.finalTotal != null) summary.push([locale === "th" ? "คะแนนสุดท้าย" : "Final total", `${payload.finalTotal}/45`]);
    if (payload.tokGrade) summary.push(["TOK", payload.tokGrade]);
    if (payload.extendedEssayGrade) summary.push(["EE", payload.extendedEssayGrade]);
    if (payload.casCompleted != null) summary.push(["CAS", payload.casCompleted ? "Complete" : "In progress"]);
  } else if (payload.curriculumNotes) {
    summary.push([locale === "th" ? "หมายเหตุหลักสูตร" : "Curriculum notes", payload.curriculumNotes]);
  }

  const subjectLines: string[] = [];
  if (payload.system === "us") {
    for (const subject of payload.fourYearCoursePlan) {
      subjectLines.push(
        `${subject.gradeLevel}: ${subject.courseTitle}${subject.level ? ` · ${subject.level}` : ""}${subject.finalGrade ? ` · ${subject.finalGrade}` : ""}`,
      );
    }
  } else if (payload.system === "ib") {
    for (const subject of payload.subjects) {
      subjectLines.push(
        `${subject.subject} · ${subject.level}${subject.predictedGrade != null ? ` · Predicted ${subject.predictedGrade}` : ""}${subject.finalGrade != null ? ` · Final ${subject.finalGrade}` : ""}`,
      );
    }
  } else {
    for (const subject of payload.subjects) {
      subjectLines.push(
        `${subject.qualification.toUpperCase()} · ${subject.subject} · ${subject.board}${subject.predictedGrade ? ` · Predicted ${subject.predictedGrade}` : ""}${subject.achievedGrade ? ` · Achieved ${subject.achievedGrade}` : ""}`,
      );
    }
  }
  return (
    <article className="space-y-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline">{payload.system === "us" ? "US" : payload.system === "ib" ? "IB" : "A-level / IGCSE"}</Badge>
        <span className="text-xs text-muted-foreground">
          {formatParentString(PARENT_STRINGS.academicsEffectiveDate, locale, { date: formatDateOnly(record.effectiveDate) })}
        </span>
      </div>
      {summary.length > 0 ? (
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {summary.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="break-words text-sm font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {subjectLines.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t(payload.system === "us" ? PARENT_STRINGS.academicsCoursePlan : PARENT_STRINGS.academicsSubjects)}
          </p>
          <ul className="space-y-1 text-sm">
            {subjectLines.map((subject, index) => (
              <li key={index} className="break-words rounded-md bg-muted/40 px-2.5 py-1.5">
                {subject}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-4">
        {payload.transcriptUrl ? <SafeExternalLink href={payload.transcriptUrl} label={t(PARENT_STRINGS.academicsTranscript)} /> : null}
        {payload.schoolProfileUrl ? <SafeExternalLink href={payload.schoolProfileUrl} label={t(PARENT_STRINGS.academicsSchoolProfile)} /> : null}
      </div>
    </article>
  );
}

function FinancialAidCard({ offer, locale }: { offer: ParentFinancialAidOffer; locale: ParentLocale }) {
  const t = (entry: ParentBilingualString) => pickParentString(entry, locale);
  const sections = [
    [PARENT_STRINGS.aidCost, offer.costBreakdown],
    [PARENT_STRINGS.aidGift, offer.giftAidBreakdown],
    [PARENT_STRINGS.aidLoans, offer.loanBreakdown],
  ] as const;
  return (
    <article className="space-y-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{offer.collegeName}</p>
        <Badge variant="outline">{offer.awardYear}</Badge>
      </div>
      {sections.map(([title, rows]) => rows.length > 0 ? (
        <div key={title.en} className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t(title)}</p>
          <dl className="space-y-1">
            {rows.map((row) => (
              <div key={row.label} className="flex items-start justify-between gap-3 text-sm">
                <dt className="min-w-0 break-words">{row.label}</dt>
                <dd className="shrink-0 tabular-nums">{formatMoney(row.amount, offer.currency)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null)}
      <dl className="grid grid-cols-1 gap-2 border-t pt-3 sm:grid-cols-2">
        {[
          [PARENT_STRINGS.aidCost, offer.totalCost],
          [PARENT_STRINGS.aidGift, offer.totalGiftAid],
          [PARENT_STRINGS.aidLoans, offer.totalLoans],
          [PARENT_STRINGS.aidWorkStudy, offer.workStudyAmount],
          [PARENT_STRINGS.aidNetCost, offer.derivedNetCost],
          [PARENT_STRINGS.aidRemaining, offer.derivedRemainingBalance],
        ].map(([label, value]) => (
          <div key={(label as ParentBilingualString).en}>
            <dt className="text-xs text-muted-foreground">{t(label as ParentBilingualString)}</dt>
            <dd className="font-semibold tabular-nums">{formatMoney(value as number | string | null, offer.currency)}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

export interface ParentDashboardViewProps {
  dashboard: ParentDashboard;
  linkedCases?: LinkedFamilyCase[];
  currentCaseHref?: string;
  initialLocale?: ParentLocale;
}

export function ParentDashboardView({
  dashboard,
  linkedCases = [],
  currentCaseHref = "",
  initialLocale = "th",
}: ParentDashboardViewProps) {
  const [locale, setLocale] = useState<ParentLocale>(initialLocale);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration preference
    setLocale(readStoredParentLocale(typeof window === "undefined" ? null : window.localStorage));
  }, []);
  const handleLocaleChange = useCallback((next: ParentLocale) => {
    setLocale(next);
    writeStoredParentLocale(typeof window === "undefined" ? null : window.localStorage, next);
  }, []);
  const todayIso = useMemo(() => todayBangkok(), []);
  const deadlineGroups = useMemo(
    () => groupParentDeadlinesByWeek(dashboard.upcomingDeadlines, todayIso),
    [dashboard.upcomingDeadlines, todayIso],
  );
  const t = useCallback((entry: ParentBilingualString) => pickParentString(entry, locale), [locale]);
  const groupLabel = (group: ParentDeadlineGroup) => {
    if (group.kind === "overdue") return t(PARENT_STRINGS.deadlinesGroupOverdue);
    if (group.kind === "thisWeek") return t(PARENT_STRINGS.deadlinesGroupThisWeek);
    if (group.kind === "nextWeek") return t(PARENT_STRINGS.deadlinesGroupNextWeek);
    return formatParentString(PARENT_STRINGS.deadlinesGroupWeekOf, locale, {
      date: group.weekStart ? formatDateOnly(group.weekStart) : "—",
    });
  };
  const hasMoney = dashboard.scholarships.length > 0 || dashboard.financialAid.length > 0;

  return (
    <div
      data-testid="parent-dashboard"
      className="mx-auto min-h-0 w-full max-w-3xl flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-1 pt-2 pb-10 text-base"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline" className="gap-1.5">
          <UsersIcon aria-hidden className="size-3.5" />
          {t(PARENT_STRINGS.roleParent)}
        </Badge>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <div role="group" aria-label={t(PARENT_STRINGS.languageToggle)} className="flex items-center gap-1">
            <LanguagesIcon aria-hidden className="mr-1 size-4 text-muted-foreground" />
            {(["th", "en"] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-testid={`parent-locale-${option}`}
                aria-pressed={locale === option}
                onClick={() => handleLocaleChange(option)}
                className={cn(
                  "min-h-11 min-w-11 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                  locale === option ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50",
                )}
              >
                {option === "th" ? t(PARENT_STRINGS.languageThai) : t(PARENT_STRINGS.languageEnglish)}
              </button>
            ))}
          </div>
          <Link
            href="/api/auth/signout"
            prefetch={false}
            data-testid="parent-sign-out"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <LogOutIcon aria-hidden className="size-4" />
            {t(PARENT_STRINGS.signOut)}
          </Link>
        </div>
      </div>

      {linkedCases.length > 1 ? (
        <nav data-testid="parent-child-switcher" aria-label={t(PARENT_STRINGS.childrenTitle)} className="space-y-2 rounded-xl border bg-card p-3">
          <p className="text-xs font-medium text-muted-foreground">{t(PARENT_STRINGS.childrenTitle)}</p>
          <div className="flex flex-wrap gap-2">
            {linkedCases.map((item) => {
              const current = item.href === currentCaseHref;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "min-h-11 min-w-0 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    current ? "border-primary bg-primary/10 font-medium text-primary" : "border-border hover:bg-muted/50",
                  )}
                >
                  <span className="block break-words">{item.preferredName ?? item.studentName}</span>
                  <span className="block text-xs text-muted-foreground">{item.cohortName}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      ) : null}

      <header data-testid="parent-header" className="space-y-1 px-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="break-words text-xl font-semibold">{dashboard.studentName}</h1>
          <Badge variant="secondary">{t(PARENT_CASE_STATUS_STRINGS[dashboard.caseStatus])}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{dashboard.cohortName}</p>
      </header>

      <Card data-testid="parent-profile">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.profileTitle)}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              [PARENT_STRINGS.profilePreferredName, dashboard.profile.preferredName],
              [PARENT_STRINGS.profilePhone, dashboard.profile.phone],
              [PARENT_STRINGS.profileSchool, dashboard.profile.school],
              [PARENT_STRINGS.profileSchoolCounselor, dashboard.profile.schoolCounselor],
              [PARENT_STRINGS.profileGraduationYear, String(dashboard.profile.graduationYear)],
            ].filter(([, value]) => value).map(([label, value]) => (
              <div key={(label as ParentBilingualString).en} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t(label as ParentBilingualString)}</dt>
                <dd className="break-words text-sm font-medium">{value as string}</dd>
              </div>
            ))}
          </dl>
          {dashboard.profile.sharedDetails.length > 0 ? (
            <dl className="space-y-3 border-t pt-4">
              {dashboard.profile.sharedDetails.map((field) => (
                <div key={field.key} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{field.label}</dt>
                  <dd className="break-words whitespace-pre-wrap text-sm">{Array.isArray(field.value) ? field.value.join(", ") : field.value}</dd>
                </div>
              ))}
            </dl>
          ) : <Empty text={t(PARENT_STRINGS.profileEmpty)} />}
        </CardContent>
      </Card>

      <Card data-testid="parent-academics">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.academicsTitle)}</CardTitle></CardHeader>
        <CardContent>
          {dashboard.academics.length > 0 ? (
            <div className="space-y-3">{dashboard.academics.map((record) => <AcademicRecordCard key={`${record.system}:${record.effectiveDate}`} record={record} locale={locale} />)}</div>
          ) : <Empty text={t(PARENT_STRINGS.academicsEmpty)} />}
        </CardContent>
      </Card>

      <Card data-testid="parent-checklist">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.checklistTitle)}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <div role="progressbar" aria-label={t(PARENT_STRINGS.progressOverall)} aria-valuenow={dashboard.progress.percent} aria-valuemin={0} aria-valuemax={100} className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${dashboard.progress.percent}%` }} />
              </div>
              <span className="text-sm font-medium">{dashboard.progress.percent}%</span>
            </div>
            <p className="text-xs text-muted-foreground">{formatParentString(PARENT_STRINGS.progressDoneOfTotal, locale, { done: String(dashboard.progress.done), total: String(dashboard.progress.total) })}</p>
          </div>
          {dashboard.phaseProgress.length > 0 ? (
            <div className="grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-5">{dashboard.phaseProgress.map((ring) => <ParentPhaseRing key={ring.phase} ring={ring} />)}</div>
          ) : null}
          {dashboard.checklist.length > 0 ? (
            <ul className="space-y-2 border-t pt-4">
              {dashboard.checklist.map((item, index) => (
                <li key={`${item.phase}:${item.title}:${index}`} className="space-y-1 rounded-lg border border-border/60 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-medium">{item.title}</p>
                    <Badge variant={item.status === "done" ? "secondary" : "outline"}>{t(PARENT_TASK_STATUS_STRINGS[item.status])}</Badge>
                  </div>
                  {item.description ? <p className="break-words text-xs text-muted-foreground">{item.description}</p> : null}
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{formatParentString(PARENT_STRINGS.checklistOwner, locale, { owner: t(PARENT_TASK_OWNER_STRINGS[item.owner]) })}</span>
                    {item.dueDate ? <span>{formatParentString(PARENT_STRINGS.checklistDue, locale, { date: formatDateOnly(item.dueDate) })}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty text={t(PARENT_STRINGS.checklistEmpty)} />}
        </CardContent>
      </Card>

      <Card data-testid="parent-deadlines">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.deadlinesTitle)}</CardTitle></CardHeader>
        <CardContent>
          {deadlineGroups.length > 0 ? (
            <div className="space-y-4">{deadlineGroups.map((group) => (
              <section key={group.key} data-testid={`parent-deadline-group-${group.key}`} aria-label={groupLabel(group)} className="space-y-1.5">
                <h3 className={cn("text-xs font-semibold", group.kind === "overdue" ? "text-conflict" : "text-muted-foreground")}>{groupLabel(group)}</h3>
                <ul className="space-y-1.5">{group.items.map((item) => (
                  <li key={`${item.source}:${item.title}:${item.date}`} className={cn("flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2", item.overdue ? "border-conflict/40 bg-conflict/5" : "border-border/60")}>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium">{item.title}</span>
                      <span className="text-xs text-muted-foreground">{t(PARENT_DEADLINE_SOURCE_STRINGS[item.source])}</span>
                    </span>
                    <span className={cn("shrink-0 text-xs tabular-nums", item.overdue ? "font-medium text-conflict" : "text-muted-foreground")}>{formatDateOnly(item.date)}{item.overdue ? ` · ${t(PARENT_STRINGS.overdueMarker)}` : ""}</span>
                  </li>
                ))}</ul>
              </section>
            ))}</div>
          ) : <Empty text={t(PARENT_STRINGS.deadlinesEmpty)} />}
        </CardContent>
      </Card>

      <Card data-testid="parent-colleges">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.collegesTitle)}</CardTitle></CardHeader>
        <CardContent>
          {dashboard.collegeList.length > 0 ? (
            <div className="space-y-3">{dashboard.collegeList.map((college, index) => (
              <article key={`${college.instName}:${college.round}:${index}`} className="space-y-3 rounded-lg border border-border/60 p-3">
                <div className="space-y-1.5">
                  <p className="break-words font-medium">{college.instName}</p>
                  <div className="flex flex-wrap gap-1.5"><Badge variant="outline">{college.roundLabel}</Badge><Badge variant="secondary">{t(PARENT_APP_STATUS_STRINGS[college.appStatus])}</Badge>{college.deadline ? <Badge className="bg-muted text-muted-foreground">{formatParentString(PARENT_STRINGS.collegeDue, locale, { date: formatDateOnly(college.deadline) })}</Badge> : null}</div>
                </div>
                {(college.firstChoiceMajor || college.secondChoiceMajor) ? (
                  <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {college.firstChoiceMajor ? <div><dt className="text-xs text-muted-foreground">{t(PARENT_STRINGS.collegeFirstMajor)}</dt><dd className="break-words text-sm">{college.firstChoiceMajor}</dd></div> : null}
                    {college.secondChoiceMajor ? <div><dt className="text-xs text-muted-foreground">{t(PARENT_STRINGS.collegeSecondMajor)}</dt><dd className="break-words text-sm">{college.secondChoiceMajor}</dd></div> : null}
                  </dl>
                ) : null}
                <div className="space-y-1.5 rounded-md bg-muted/40 p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-medium">{t(PARENT_STRINGS.collegeCompleteness)}</p><Badge variant={college.completeness.complete ? "secondary" : "outline"}>{t(college.completeness.complete ? PARENT_STRINGS.collegeComplete : PARENT_STRINGS.collegeIncomplete)}</Badge></div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{formatParentString(PARENT_STRINGS.collegeRecs, locale, { done: String(college.completeness.recsSubmitted), total: String(college.completeness.recsTotal) })}</span>
                    <span>{t(PARENT_STRINGS.collegeTranscript)}: {college.completeness.transcriptSent ? "✓" : "—"}</span>
                    <span>{t(PARENT_STRINGS.collegeSchoolReport)}: {college.completeness.schoolReportSent ? "✓" : "—"}</span>
                    <span>{formatParentString(PARENT_STRINGS.collegeScoreSends, locale, { count: String(college.completeness.scoreSendsSent) })}</span>
                  </div>
                </div>
                {college.decisions.length > 0 ? <div className="space-y-1"><p className="text-xs font-medium text-muted-foreground">{t(PARENT_STRINGS.collegeDecisions)}</p><div className="flex flex-wrap gap-1.5">{college.decisions.map((decision, decisionIndex) => <Badge key={`${decision.eventDate}:${decisionIndex}`} variant="outline">{t(PARENT_DECISION_STRINGS[decision.event])} · {formatDateOnly(decision.eventDate)}</Badge>)}</div></div> : null}
                {college.requirements.length > 0 ? <div className="space-y-1.5"><p className="text-xs font-medium text-muted-foreground">{t(PARENT_STRINGS.collegeRequirements)}</p><ul className="space-y-1.5">{college.requirements.map((requirement, requirementIndex) => <li key={`${requirement.title}:${requirementIndex}`} className="rounded-md border border-border/60 p-2"><div className="flex flex-wrap items-start justify-between gap-2"><span className="break-words text-sm">{requirement.title}</span><Badge variant="outline">{t(PARENT_TASK_STATUS_STRINGS[requirement.status])}</Badge></div>{requirement.dueDate ? <p className="text-xs text-muted-foreground">{formatParentString(PARENT_STRINGS.checklistDue, locale, { date: formatDateOnly(requirement.dueDate) })}</p> : null}</li>)}</ul></div> : null}
                <div className="flex flex-wrap gap-4">{college.admissionsUrl ? <SafeExternalLink href={college.admissionsUrl} label={t(PARENT_STRINGS.collegeAdmissionsSite)} /> : null}{college.portalUrl ? <SafeExternalLink href={college.portalUrl} label={t(PARENT_STRINGS.collegePortalSite)} /> : null}</div>
              </article>
            ))}</div>
          ) : <Empty text={t(PARENT_STRINGS.collegesEmpty)} />}
        </CardContent>
      </Card>

      <Card data-testid="parent-recommenders">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.recommendersTitle)}</CardTitle></CardHeader>
        <CardContent>{dashboard.recommenders.length > 0 ? <ul className="space-y-2">{dashboard.recommenders.map((recommender, index) => <li key={`${recommender.name}:${index}`} className="space-y-2 rounded-lg border border-border/60 p-3"><div className="flex flex-wrap justify-between gap-2"><div><p className="font-medium">{recommender.name}</p>{recommender.roleSubject ? <p className="text-xs text-muted-foreground">{recommender.roleSubject}</p> : null}</div><Badge variant="outline">{t(PARENT_RECOMMENDER_STATUS_STRINGS[recommender.askStatus])}</Badge></div>{recommender.colleges.length > 0 ? <ul className="space-y-1">{recommender.colleges.map((college) => <li key={college.collegeName} className="flex flex-wrap justify-between gap-2 text-sm"><span className="break-words">{college.collegeName}</span><span className={college.submitted ? "text-available" : "text-muted-foreground"}>{t(college.submitted ? PARENT_STRINGS.recommenderSubmitted : PARENT_STRINGS.recommenderPending)}</span></li>)}</ul> : null}</li>)}</ul> : <Empty text={t(PARENT_STRINGS.recommendersEmpty)} />}</CardContent>
      </Card>

      <Card data-testid="parent-essays">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.essaysTitle)}</CardTitle></CardHeader>
        <CardContent>{dashboard.essays.length > 0 ? <ul className="space-y-2">{dashboard.essays.map((essay, index) => <li key={`${essay.prompt}:${index}`} className="space-y-2 rounded-lg border border-border/60 p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="break-words text-sm font-medium">{essay.prompt}</p><p className="text-xs text-muted-foreground">{essay.collegeName ?? t(PARENT_STRINGS.essayGeneral)}</p></div><Badge variant="outline">{t(PARENT_ESSAY_STATUS_STRINGS[essay.status])}</Badge></div>{essay.deadline ? <p className="text-xs text-muted-foreground">{formatParentString(PARENT_STRINGS.checklistDue, locale, { date: formatDateOnly(essay.deadline) })}</p> : null}{essay.googleDocUrl ? <SafeExternalLink href={essay.googleDocUrl} label={t(PARENT_STRINGS.essayGoogleDoc)} /> : null}</li>)}</ul> : <Empty text={t(PARENT_STRINGS.essaysEmpty)} />}</CardContent>
      </Card>

      <Card data-testid="parent-activities">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.activitiesTitle)}</CardTitle></CardHeader>
        <CardContent>{dashboard.activities.length > 0 ? <ul className="space-y-2">{dashboard.activities.map((activity, index) => <li key={`${activity.name}:${index}`} className="space-y-2 rounded-lg border border-border/60 p-3"><div className="flex flex-wrap items-center gap-2"><p className="break-words font-medium">{activity.name}</p>{activity.commonAppRank ? <Badge variant="outline">Common App #{activity.commonAppRank}</Badge> : null}</div>{activity.fullDescription ? <p className="break-words whitespace-pre-wrap text-sm">{activity.fullDescription}</p> : null}{activity.commonApp || activity.uc ? <dl className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">{Object.entries({ ...(activity.commonApp ?? {}), ...(activity.uc ?? {}) }).flatMap(([key, value]) => { const text = scalarText(value); return text ? <div key={key} className="min-w-0"><dt className="text-muted-foreground">{humanizeKey(key)}</dt><dd className="break-words">{text}</dd></div> : []; })}</dl> : null}</li>)}</ul> : <Empty text={t(PARENT_STRINGS.activitiesEmpty)} />}</CardContent>
      </Card>

      <Card data-testid="parent-awards">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.awardsTitle)}</CardTitle></CardHeader>
        <CardContent>{dashboard.awards.length > 0 ? <ul className="space-y-2">{dashboard.awards.map((award, index) => <li key={`${award.title}:${index}`} className="space-y-2 rounded-lg border border-border/60 p-3"><div className="flex flex-wrap items-center gap-2"><p className="break-words font-medium">{award.title}</p>{award.commonAppRank ? <Badge variant="outline">Common App #{award.commonAppRank}</Badge> : null}</div>{award.organization ? <p className="text-sm text-muted-foreground">{t(PARENT_STRINGS.awardOrganization)}: {award.organization}</p> : null}<div className="flex flex-wrap gap-1.5">{award.recognitionLevels.map((level) => <Badge key={level} variant="secondary">{humanizeKey(level)}</Badge>)}{award.gradeLevels.map((grade) => <Badge key={grade} variant="outline">Grade {grade}</Badge>)}</div>{award.awardDate ? <p className="text-xs text-muted-foreground">{formatDateOnly(award.awardDate)}</p> : null}{award.ucEligibilityNarrative ? <p className="break-words text-sm">{award.ucEligibilityNarrative}</p> : null}{award.ucAchievementNarrative ? <p className="break-words text-sm">{award.ucAchievementNarrative}</p> : null}</li>)}</ul> : <Empty text={t(PARENT_STRINGS.awardsEmpty)} />}</CardContent>
      </Card>

      <Card data-testid="parent-testing">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.testingTitle)}</CardTitle></CardHeader>
        <CardContent>{dashboard.testingMilestones.length > 0 ? <ul className="space-y-2">{dashboard.testingMilestones.map((milestone, index) => <TestingMilestoneRow key={`${milestone.testType}:${milestone.testDate}:${index}`} milestone={milestone} locale={locale} />)}</ul> : <Empty text={t(PARENT_STRINGS.testingEmpty)} />}</CardContent>
      </Card>

      <Card data-testid="parent-money">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.moneyTitle)}</CardTitle></CardHeader>
        <CardContent>{hasMoney ? <div className="space-y-5">{dashboard.scholarships.length > 0 ? <section className="space-y-2"><h3 className="text-sm font-semibold">{t(PARENT_STRINGS.scholarshipsTitle)}</h3><ul className="space-y-2">{dashboard.scholarships.map((scholarship, index) => <li key={`${scholarship.name}:${index}`} className="space-y-2 rounded-lg border border-border/60 p-3"><div className="flex flex-wrap justify-between gap-2"><div className="min-w-0"><p className="break-words font-medium">{scholarship.name}</p>{scholarship.collegeName ? <p className="text-xs text-muted-foreground">{scholarship.collegeName}</p> : null}</div><Badge variant="outline">{t(PARENT_SCHOLARSHIP_STATUS_STRINGS[scholarship.status])}</Badge></div>{scholarship.provider ? <p className="break-words text-sm">{t(PARENT_STRINGS.scholarshipProvider)}: {scholarship.provider}</p> : null}{scholarship.requirements ? <p className="break-words whitespace-pre-wrap text-sm">{t(PARENT_STRINGS.scholarshipRequirements)}: {scholarship.requirements}</p> : null}<div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{scholarship.deadline ? <span>{formatParentString(PARENT_STRINGS.checklistDue, locale, { date: formatDateOnly(scholarship.deadline) })}</span> : null}{scholarship.outcome ? <span>{t(PARENT_STRINGS.scholarshipOutcome)}: {scholarship.outcome}</span> : null}{scholarship.offeredAmount ? <span>{t(PARENT_STRINGS.scholarshipOffered)}: {formatMoney(scholarship.offeredAmount, "USD")}</span> : null}</div>{scholarship.url ? <SafeExternalLink href={scholarship.url} label={t(PARENT_STRINGS.openLink)} /> : null}</li>)}</ul></section> : null}{dashboard.financialAid.length > 0 ? <section className="space-y-2"><h3 className="text-sm font-semibold">{t(PARENT_STRINGS.financialAidTitle)}</h3><div className="space-y-3">{dashboard.financialAid.map((offer) => <FinancialAidCard key={`${offer.collegeName}:${offer.awardYear}`} offer={offer} locale={locale} />)}</div></section> : null}</div> : <Empty text={t(PARENT_STRINGS.moneyEmpty)} />}</CardContent>
      </Card>

      <Card data-testid="parent-announcements">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.announcementsTitle)}</CardTitle></CardHeader>
        <CardContent>{dashboard.announcements.length > 0 ? <ul className="space-y-3">{dashboard.announcements.map((announcement, index) => <li key={`${announcement.createdAt}:${index}`} className="space-y-0.5"><p className="break-words text-sm font-medium">{announcement.title}</p><p className="text-xs text-muted-foreground">{formatBangkokTimestamp(announcement.createdAt)}</p><p className="break-words whitespace-pre-wrap text-sm">{announcement.body}</p></li>)}</ul> : <Empty text={t(PARENT_STRINGS.announcementsEmpty)} />}</CardContent>
      </Card>

      <Card data-testid="parent-notes">
        <CardHeader><CardTitle>{t(PARENT_STRINGS.notesTitle)}</CardTitle></CardHeader>
        <CardContent>{dashboard.sharedNotes.length > 0 ? <ul className="space-y-3">{dashboard.sharedNotes.map((note, index) => <li key={`${note.createdAt}:${index}`} className="space-y-0.5"><p className="break-words whitespace-pre-wrap text-sm">{note.body}</p><p className="text-xs text-muted-foreground">{formatBangkokTimestamp(note.createdAt)}</p></li>)}</ul> : <Empty text={t(PARENT_STRINGS.notesEmpty)} />}</CardContent>
      </Card>
    </div>
  );
}

export { PARENT_LOCALE_STORAGE_KEY };

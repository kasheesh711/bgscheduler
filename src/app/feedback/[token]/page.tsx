// ----------------------------------------------------------------------------
// PUBLIC teacher feedback page, opened from the LINE /feedback reply.
//
// Access is the signed token in the URL and nothing else (FB-BOT-L1,
// src/lib/line/feedback-bot.ts). The token names one student code and one
// subject and expires after 24 hours. Every failure renders ONE identical
// message. The classes are read again on each visit.
//
// The look is deliberately its own (owner request 2026-11-14): its own layout
// with the BeGifted brand palette (paper #FAF8F4, ink #141414, orange #FF7518)
// and logo, as fixed light colours, not the app's semantic tokens.
//
// The root layout's body is a fixed-height overflow-hidden flex shell, so this
// page owns its scrolling (min-h-0 flex-1 overflow-y-auto).
// Reachability requires the `/feedback/<token>` pattern in src/proxy.ts.
// ----------------------------------------------------------------------------

import type { Metadata, Viewport } from "next";
import Image from "next/image";
import { Suspense } from "react";
import { BookOpen, Clock, GraduationCap, NotebookPen, School, Sparkles, Target } from "lucide-react";

// Static import: served from /_next/static, which needs no login (public/brand does).
import logo from "../../../../public/brand/logo-horizontal.png";
import { getDb } from "@/lib/db";
import {
  loadFeedbackClasses,
  loadStudentProfile,
  readFeedbackLinkToken,
  selectSubjectClasses,
  type FeedbackClassRow,
} from "@/lib/line/feedback-bot";
import { parseStudentDisplay } from "@/lib/student-schedule/data";

export const metadata: Metadata = {
  title: { absolute: "BeGifted — Class feedback" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#FAF8F4",
};

type Params = Promise<{ token: string }>;

const SECTIONS = [
  { key: "topics", label: "Topics covered", Icon: BookOpen },
  { key: "performance", label: "Performance", Icon: Sparkles },
  { key: "improvement", label: "Needs work", Icon: Target },
  { key: "homework", label: "Homework", Icon: NotebookPen },
] as const;

const bangkok = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", ...options });
const DAY = bangkok({ day: "numeric" });
const MONTH = bangkok({ month: "short" });
const WEEKDAY = bangkok({ weekday: "long" });
const TIME = bangkok({ hour: "2-digit", minute: "2-digit", hour12: false });
const EXPIRES = bangkok({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const DATE_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" });

/** "Today", "Yesterday", "3 days ago", "2 weeks ago" by Bangkok calendar day. */
function ago(start: Date, now: Date): string {
  const days = Math.round((Date.parse(DATE_KEY.format(now)) - Date.parse(DATE_KEY.format(start))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  return `${Math.floor(days / 7)} weeks ago`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-0 w-full flex-1 overflow-y-auto bg-[#FAF8F4] text-[#141414] [color-scheme:light]">
      {children}
    </main>
  );
}

function ExpiredNotice() {
  return (
    <Shell>
      <div className="flex min-h-full items-center justify-center px-6 py-10">
        <div className="w-full max-w-sm rounded-3xl bg-white px-7 py-9 text-center shadow-[0_10px_40px_-12px_rgba(20,20,20,0.18)] ring-1 ring-[#E8E3DA]">
          <Image src={logo} alt="BeGifted Tutor & Education" className="mx-auto h-10 w-auto" />
          <h1 className="mt-5 text-lg font-semibold tracking-tight">This link has expired</h1>
          <p className="mt-2 text-sm leading-relaxed text-[#6B6B6B]">
            Feedback links work for 24 hours. Type <span className="font-mono text-[#3A3A3A]">/feedback</span> in the
            teacher chat for a new link.
          </p>
        </div>
      </div>
    </Shell>
  );
}

function ClassCard({ row, now, last }: { row: FeedbackClassRow; now: Date; last: boolean }) {
  const sections = SECTIONS
    .map((section) => ({ ...section, value: row[section.key]?.trim() ?? "" }))
    .filter((section) => section.value);
  const tutor = row.tutorName?.trim() || "Tutor";
  return (
    <li className="relative flex gap-3 sm:gap-5">
      {/* Timeline rail */}
      <div className="flex w-12 shrink-0 flex-col items-center sm:w-14">
        <div className="flex w-full flex-col items-center rounded-2xl bg-white py-2 shadow-sm ring-1 ring-[#E8E3DA]">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#B84A00]">
            {MONTH.format(row.scheduledStartAt)}
          </span>
          <span className="text-xl font-semibold leading-tight tabular-nums">{DAY.format(row.scheduledStartAt)}</span>
        </div>
        {last ? null : <div className="mt-2 w-px flex-1 bg-gradient-to-b from-[#D3CCC0] to-transparent" />}
      </div>

      <article className="mb-5 min-w-0 flex-1 overflow-hidden rounded-3xl bg-white shadow-[0_8px_30px_-14px_rgba(20,20,20,0.16)] ring-1 ring-[#E8E3DA]">
        <header className="flex items-center justify-between gap-3 border-b border-[#F1EDE7] px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">
              {WEEKDAY.format(row.scheduledStartAt)} · {TIME.format(row.scheduledStartAt)}
            </h2>
            <p className="text-xs text-[#6B6B6B]">{ago(row.scheduledStartAt, now)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 rounded-full bg-[#FAF8F4] py-1 pl-1 pr-3 ring-1 ring-[#E8E3DA]">
            <span className="flex size-6 items-center justify-center rounded-full bg-[#141414] text-[11px] font-semibold text-[#FAF8F4]">
              {tutor.charAt(0).toUpperCase()}
            </span>
            <span className="text-xs font-medium text-[#3A3A3A]">Kru {tutor}</span>
          </div>
        </header>

        {sections.length === 0 ? (
          <p className="px-4 py-5 text-sm text-[#85817A] sm:px-5">No feedback for this class yet.</p>
        ) : (
          <div className="space-y-4 px-4 py-4 sm:px-5">
            {sections.map(({ key, label, Icon, value }) => (
              <section key={key}>
                <h3 className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide bg-[#F1EDE7] text-[#141414]`}>
                  <Icon className="size-3.5 text-[#B84A00]" aria-hidden />
                  {label}
                </h3>
                <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-[#3A3A3A]">{value}</p>
              </section>
            ))}
          </div>
        )}
      </article>
    </li>
  );
}

async function FeedbackBody({ params }: { params: Params }) {
  const { token } = await params;
  const now = new Date();
  const grant = readFeedbackLinkToken(token, now);
  // One response for every failure mode — do not branch this.
  if (!grant) return <ExpiredNotice />;

  const { rows, titles } = await loadFeedbackClasses(getDb(), grant.code, now);
  const selection = selectSubjectClasses(rows, titles, "", grant.subject, true);
  if (selection.status !== "ok") return <ExpiredNotice />;

  const classes = selection.rows;
  const profile = await loadStudentProfile(classes[0].wiseStudentId);
  const fullName = classes[0].studentName.trim();
  const { shortName, code } = parseStudentDisplay(fullName);
  const tutors = new Set(classes.map((row) => row.tutorName).filter(Boolean)).size;
  const withFeedback = classes.filter((row) => SECTIONS.some((section) => row[section.key]?.trim())).length;

  return (
    <Shell>
      <div className="bg-gradient-to-b from-[#F1EDE7] to-[#FAF8F4] px-4 pt-[max(1.75rem,env(safe-area-inset-top))] pb-6 sm:px-6">
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex items-center justify-between gap-3">
            <Image src={logo} alt="BeGifted Tutor & Education" priority className="h-9 w-auto" />
            <span className="rounded-full bg-[#FF7518] px-3 py-1 text-xs font-semibold text-[#141414] shadow-sm shadow-[#FF7518]/30">
              {selection.subject}
            </span>
          </div>
          <p className="mt-6 text-sm font-medium text-[#6B6B6B]">Class feedback</p>
          <h1 className="mt-1 font-[family-name:var(--font-cormorant)] text-5xl font-semibold leading-none tracking-tight text-[#141414]">
            {shortName}
          </h1>
          <p className="mt-2 text-sm text-[#3A3A3A]">
            {fullName.replace(/\s*\([^)]*\)\s*/, " ")}
            {code ? <span className="text-[#85817A]"> · {code}</span> : null}
          </p>

          {profile.school || profile.year ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {[
                { Icon: School, label: "School", value: profile.school },
                { Icon: GraduationCap, label: "Year", value: profile.year },
              ].filter((item) => item.value).map(({ Icon, label, value }) => (
                <span key={label} className="inline-flex max-w-full items-center gap-2 rounded-full bg-white px-3 py-1.5 text-sm shadow-sm ring-1 ring-[#E8E3DA]">
                  <Icon className="size-4 shrink-0 text-[#B84A00]" aria-hidden />
                  <span className="text-[#6B6B6B]">{label}</span>
                  <span className="truncate font-medium text-[#141414]">{value}</span>
                </span>
              ))}
            </div>
          ) : null}

          <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
            {[
              [classes.length, classes.length === 1 ? "class" : "classes"],
              [withFeedback, "with feedback"],
              [tutors, tutors === 1 ? "tutor" : "tutors"],
            ].map(([value, label]) => (
              <div key={label} className="rounded-2xl bg-white/70 px-2 py-3 ring-1 ring-white backdrop-blur">
                <dd className="text-2xl font-semibold tabular-nums text-[#141414]">{value}</dd>
                <dt className="text-[11px] font-medium text-[#6B6B6B]">{label}</dt>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="px-4 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto w-full max-w-2xl">
          <p className="mb-3 text-xs font-medium text-[#6B6B6B]">Most recent first · all tutors</p>
          <ol>
            {classes.map((row, index) => (
              <ClassCard key={row.wiseSessionId} row={row} now={now} last={index === classes.length - 1} />
            ))}
          </ol>
          <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs text-[#85817A]">
            <Clock className="size-3.5" aria-hidden />
            Link works until {EXPIRES.format(grant.expiresAt)} (Bangkok)
          </p>
        </div>
      </div>
    </Shell>
  );
}

function Fallback() {
  return (
    <Shell>
      <div className="mx-auto w-full max-w-2xl animate-pulse space-y-4 px-4 py-8 sm:px-6">
        <div className="h-4 w-24 rounded-full bg-[#E8E3DA]" />
        <div className="h-12 w-48 rounded-2xl bg-[#E8E3DA]" />
        <div className="h-20 rounded-2xl bg-white" />
        <div className="h-56 rounded-3xl bg-white" />
        <div className="h-56 rounded-3xl bg-white" />
      </div>
    </Shell>
  );
}

export default function FeedbackLinkPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<Fallback />}>
      <FeedbackBody params={params} />
    </Suspense>
  );
}

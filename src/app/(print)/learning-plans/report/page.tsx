import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PrintToolbar } from "@/components/learning-plan/print-toolbar";
import { ReportChecklist } from "@/components/learning-plan/report-checklist";
import { ReportCover } from "@/components/learning-plan/report-cover";
import { ReportOverview } from "@/components/learning-plan/report-overview";
import { auth } from "@/lib/auth";
import {
  hasLearningPlansAccess,
  LEARNING_PLANS_ROUTE,
} from "@/lib/learning-plans/access-policy";
import { getYearSyllabus } from "@/lib/syllabus/get-year-syllabus";
import {
  normalizeSearchParams,
  parseTopicCodes,
  reportParamsSchema,
} from "@/lib/syllabus/report-params";

type SearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

const robots = { index: false, follow: false };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const parsed = reportParamsSchema.safeParse(
    normalizeSearchParams(await searchParams),
  );
  if (!parsed.success) {
    return { title: { absolute: "Learning Plan" }, robots };
  }

  return {
    title: {
      absolute: `BeGifted Learning Plan — ${parsed.data.student} — Year ${parsed.data.year}`,
    },
    robots,
  };
}

function ReportShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-learning-plan-report
      className="begifted report-scroll min-h-0 flex-1 overflow-y-auto bg-begifted-neutral-100 print:bg-white"
    >
      {children}
    </div>
  );
}

function InvalidParams() {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="eyebrow mb-3">Learning Plan</p>
      <h1 className="begifted-display text-3xl">
        That link doesn&apos;t look right
      </h1>
      <p className="mt-3 text-sm text-begifted-neutral-500">
        The report needs a student name and a year group between 1 and 13.
      </p>
      <Link
        href={LEARNING_PLANS_ROUTE}
        className="mt-6 rounded-full bg-begifted-orange-500 px-6 py-2.5 text-sm font-semibold text-white shadow-begifted-md hover:bg-begifted-orange-600"
      >
        Back to the form
      </Link>
    </div>
  );
}

async function LearningPlanReportBody({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }
  if (
    !hasLearningPlansAccess(
      session.user.allowedPages,
      session.user.role,
    )
  ) {
    notFound();
  }

  const parsed = reportParamsSchema.safeParse(
    normalizeSearchParams(await searchParams),
  );
  if (!parsed.success) {
    return (
      <ReportShell>
        <InvalidParams />
      </ReportShell>
    );
  }

  const { student, year, tutor, notes } = parsed.data;
  const syllabus = await getYearSyllabus(year);
  if (!syllabus) {
    return (
      <ReportShell>
        <InvalidParams />
      </ReportShell>
    );
  }

  const selection = parseTopicCodes(parsed.data.topics);
  const topics = selection
    ? syllabus.topics.filter((topic) => selection.has(topic.code))
    : syllabus.topics;
  if (topics.length === 0) {
    return (
      <ReportShell>
        <InvalidParams />
      </ReportShell>
    );
  }

  const skillCount = topics.reduce(
    (count, topic) => count + topic.skills.length,
    0,
  );
  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  }).format(new Date());

  return (
    <ReportShell>
      <PrintToolbar />
      <div className="report-root">
        <div className="report-sheet mx-auto my-8 max-w-[210mm] rounded-md bg-white p-[14mm] shadow-begifted-lg">
          <ReportCover
            student={student}
            year={year}
            tutor={tutor}
            notes={notes}
            dateLabel={dateLabel}
            topicCount={topics.length}
            skillCount={skillCount}
          />
          <ReportOverview
            student={student}
            year={year}
            topics={topics}
            totalTopicsInYear={syllabus.topics.length}
          />
          <ReportChecklist student={student} topics={topics} />
        </div>
      </div>
    </ReportShell>
  );
}

export default function LearningPlanReportPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <Suspense
      fallback={
        <ReportShell>
          <div className="min-h-screen" />
        </ReportShell>
      }
    >
      <LearningPlanReportBody searchParams={searchParams} />
    </Suspense>
  );
}

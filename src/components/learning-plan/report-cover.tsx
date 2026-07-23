import Image from "next/image";

import { DigitSafe } from "@/components/learning-plan/digit-safe";

interface ReportCoverProps {
  student: string;
  year: number;
  tutor?: string;
  notes?: string;
  dateLabel: string;
  topicCount: number;
  skillCount: number;
}

export function ReportCover({
  student,
  year,
  tutor,
  notes,
  dateLabel,
  topicCount,
  skillCount,
}: ReportCoverProps) {
  return (
    <section className="break-after-page">
      <div className="flex items-start justify-between">
        <Image
          src="/brand/logo-horizontal.png"
          alt="BeGifted"
          width={194}
          height={76}
          preload
          className="h-11 w-auto"
        />
        <p className="pt-2 text-xs text-begifted-neutral-400">{dateLabel}</p>
      </div>

      <div className="mt-14">
        <p className="eyebrow mb-4">Learning Plan · General Mathematics</p>
        <h1 className="begifted-display text-[44px] leading-[1.1]">
          A learning plan for{" "}
          <em className="text-begifted-orange-500">
            <DigitSafe text={student} />
          </em>
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-3 text-sm">
          <span className="digits rounded-full bg-begifted-blue-100 px-4 py-1.5 font-semibold text-begifted-blue-700">
            Year {year}
          </span>
          {tutor ? (
            <span className="rounded-full bg-begifted-neutral-100 px-4 py-1.5 font-semibold text-begifted-neutral-700">
              Prepared by {tutor}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-10 grid grid-cols-3 gap-4">
        <div className="rounded-[20px] border border-begifted-neutral-200 bg-begifted-neutral-50 px-6 py-5">
          <p className="digits text-4xl font-bold text-begifted-orange-500">
            {topicCount}
          </p>
          <p className="mt-1 text-xs font-semibold tracking-wide text-begifted-neutral-500 uppercase">
            Topics
          </p>
        </div>
        <div className="rounded-[20px] border border-begifted-neutral-200 bg-begifted-neutral-50 px-6 py-5">
          <p className="digits text-4xl font-bold text-begifted-orange-500">
            {skillCount}
          </p>
          <p className="mt-1 text-xs font-semibold tracking-wide text-begifted-neutral-500 uppercase">
            Skills to master
          </p>
        </div>
        <div className="rounded-[20px] border border-begifted-neutral-200 bg-begifted-neutral-50 px-6 py-5">
          <p className="digits text-4xl font-bold text-begifted-orange-500">
            {year}
          </p>
          <p className="mt-1 text-xs font-semibold tracking-wide text-begifted-neutral-500 uppercase">
            Year group
          </p>
        </div>
      </div>

      <div className="mt-10 max-w-[62ch] text-[15px] leading-relaxed text-begifted-neutral-700">
        <p>
          This plan sets out the General Mathematics curriculum for{" "}
          <strong className="text-begifted-neutral-900">{student}</strong> in
          Year <span className="digits">{year}</span>. It lists every topic and
          skill we will work through together, in the order a student typically
          meets them.
        </p>
        <p className="mt-4">
          The full skills checklist begins after the overview. Each skill has a
          tick box, so you can follow progress at home as topics are mastered.
          Skills build on one another; steady, consistent progress matters more
          than speed.
        </p>
      </div>

      {notes ? (
        <div className="mt-10 break-inside-avoid rounded-[20px] border border-begifted-orange-200 bg-begifted-orange-50 px-7 py-6">
          <p className="eyebrow mb-3 text-[11px]">
            A note from {tutor ? tutor : "your consultant"}
          </p>
          <p className="text-[15px] leading-relaxed whitespace-pre-line text-begifted-neutral-800">
            {notes}
          </p>
        </div>
      ) : null}
    </section>
  );
}

import { DigitSafe } from "@/components/learning-plan/digit-safe";
import type { Topic } from "@/lib/syllabus/types";

interface ReportOverviewProps {
  student: string;
  year: number;
  topics: Topic[];
  totalTopicsInYear: number;
}

export function ReportOverview({
  student,
  year,
  topics,
  totalTopicsInYear,
}: ReportOverviewProps) {
  const isSubset = topics.length < totalTopicsInYear;

  return (
    <section className="break-after-page">
      <p className="eyebrow mb-3">Overview</p>
      <h2 className="begifted-display text-[30px]">
        What <DigitSafe text={student} /> will cover in Year{" "}
        <span className="digits">{year}</span>
      </h2>
      {isSubset ? (
        <p className="mt-3 text-sm text-begifted-neutral-500">
          This plan focuses on{" "}
          <span className="font-semibold text-begifted-neutral-700">
            {topics.length} of the year&apos;s {totalTopicsInYear} topics
          </span>
          , selected for {student} by our team.
        </p>
      ) : null}

      <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-2.5">
        {topics.map((topic, index) => (
          <div
            key={topic.code}
            className="flex items-center gap-3 border-b border-begifted-neutral-100 pb-2.5 text-[13.5px] break-inside-avoid"
          >
            <span className="digits w-6 shrink-0 text-right font-semibold text-begifted-orange-500">
              {index + 1}
            </span>
            <span className="flex-1 text-begifted-neutral-800">
              {topic.name}
            </span>
            <span className="digits shrink-0 rounded-full bg-begifted-neutral-100 px-2.5 py-0.5 text-[11px] font-semibold text-begifted-neutral-500">
              {topic.skills.length}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-8 text-xs text-begifted-neutral-400">
        The number beside each topic shows how many individual skills it
        contains. The full checklist follows on the next page.
      </p>
    </section>
  );
}

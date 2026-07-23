import { DigitSafe } from "@/components/learning-plan/digit-safe";
import type { Topic } from "@/lib/syllabus/types";

interface ReportChecklistProps {
  student: string;
  topics: Topic[];
}

export function ReportChecklist({
  student,
  topics,
}: ReportChecklistProps) {
  return (
    <section>
      <p className="eyebrow mb-3">Appendix</p>
      <h2 className="begifted-display text-[30px]">Skills checklist</h2>
      <p className="mt-3 mb-8 max-w-[62ch] text-sm text-begifted-neutral-500">
        Every skill in {student}&apos;s plan, topic by topic. Tick each box as
        it is mastered.
      </p>

      {topics.map((topic) => (
        <div key={topic.code} className="mb-7">
          <h4 className="begifted-display mb-2 text-[17px]">
            <span className="digits mr-2 font-begifted-body text-[13px] font-bold text-begifted-orange-500">
              {topic.code}
            </span>
            <DigitSafe text={topic.name} />
          </h4>
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b-2 border-begifted-neutral-200 text-left">
                <th className="w-14 py-1.5 pr-2 text-[10.5px] font-semibold tracking-[0.12em] text-begifted-neutral-400 uppercase">
                  Code
                </th>
                <th className="py-1.5 pr-2 text-[10.5px] font-semibold tracking-[0.12em] text-begifted-neutral-400 uppercase">
                  Skill
                </th>
                <th className="w-12 py-1.5 text-center text-[10.5px] font-semibold tracking-[0.12em] text-begifted-neutral-400 uppercase">
                  Done
                </th>
              </tr>
            </thead>
            <tbody>
              {topic.skills.map((skill) => (
                <tr
                  key={skill.code}
                  className="border-b border-begifted-neutral-100"
                >
                  <td className="digits py-1.5 pr-2 font-medium text-begifted-neutral-400">
                    {skill.code}
                  </td>
                  <td className="py-1.5 pr-2 text-begifted-neutral-800">
                    {skill.description}
                  </td>
                  <td className="py-1.5 text-center">
                    <span
                      aria-hidden
                      className="inline-block size-3.5 rounded-[3px] border-[1.5px] border-begifted-neutral-300 align-middle"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <footer className="mt-12 border-t border-begifted-neutral-200 pt-5 text-center text-xs text-begifted-neutral-400">
        <p>
          BeGifted · General Mathematics Learning Plan · Questions? Message us
          on LINE{" "}
          <span className="font-semibold text-begifted-neutral-600">
            @begifted
          </span>
        </p>
      </footer>
    </section>
  );
}

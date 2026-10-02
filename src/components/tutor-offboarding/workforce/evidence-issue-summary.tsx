import type { WorkforceException } from "@/lib/tutor-offboarding/workforce/types";

/** Entity-level evidence stays intact; repeated messages need only one visible row. */
export function EvidenceIssueSummary({ issues }: { issues: WorkforceException[] }) {
  if (!issues.length) return null;
  const groups = new Map<string, { code: string; message: string; count: number }>();
  for (const issue of issues) {
    const key = JSON.stringify([issue.code, issue.message]);
    const previous = groups.get(key);
    if (previous) previous.count++;
    else groups.set(key, { code: issue.code, message: issue.message, count: 1 });
  }
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        {issues.length.toLocaleString("en-US")} evidence issues · {groups.size.toLocaleString("en-US")} distinct messages.
        {" "}Repeated issues are grouped by code and message. Individual evidence remains in the report and CSV.
      </p>
      <ul className="space-y-2">
        {[...groups].map(([key, issue]) => (
          <li key={key} className="text-amber-800 [overflow-wrap:anywhere] dark:text-amber-200">
            <span className="font-medium">{issue.code.replaceAll("_", " ")}</span>
            {" · "}{issue.count.toLocaleString("en-US")} {issue.count === 1 ? "occurrence" : "occurrences"}
            <p>{issue.message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

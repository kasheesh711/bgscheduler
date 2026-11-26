import type { FunnelReport } from "@/lib/hiring/funnel";

type Campaign = { jobId: string; label: string };

/** The break-down choices: all, each campaign (most applied first), each month and each ISO week (newest first). */
export function groupOptions(report: FunnelReport, campaigns: Campaign[]) {
  const keys = Object.keys(report.groups);
  const applied = (g: string) => report.groups[g].reached.applied;
  const campaignLabel = (id: string) => {
    if (id === "tracker-only") return "Tracker only (no SEEK job)";
    const job = campaigns.find((c) => c.jobId === id);
    return job ? `${job.label} (SEEK ${id})` : `SEEK ${id}`;
  };
  return [
    { value: "all", label: "All candidates" },
    ...keys
      .filter((g) => g.startsWith("campaign:"))
      .sort((a, b) => applied(b) - applied(a))
      .map((g) => ({ value: g, label: `Campaign: ${campaignLabel(g.slice(9))}` })),
    ...keys
      .filter((g) => g.startsWith("month:"))
      .sort()
      .reverse()
      .map((g) => ({
        value: g,
        label: `First seen in ${new Date(`${g.slice(6)}-01`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })}`,
      })),
    ...keys
      .filter((g) => g.startsWith("week:"))
      .sort()
      .reverse()
      .map((g) => {
        const [year, week] = g.slice(5).split("-W");
        return { value: g, label: `First seen in week ${Number(week)} of ${year}` };
      }),
  ];
}

/** A campaign or week can drop out on the next load: then "all", for both the select and the table. */
export const pickGroup = (report: FunnelReport, group: string) => (report.groups[group] ? group : "all");

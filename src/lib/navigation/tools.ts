export type NavSectionId =
  | "scheduling-tutors"
  | "student-lifecycle"
  | "finance-revenue"
  | "market-intelligence"
  | "research-reference"
  | "data-audit";

export type NavToolId =
  | "scheduler"
  | "search"
  | "line-review"
  | "leave-requests"
  | "class-assignments"
  | "tutor-profiles"
  | "room-capacity"
  | "scheduler-metrics"
  | "progress-tests"
  | "student-promotions"
  | "sales-dashboard"
  | "credit-control"
  | "payroll"
  | "competitor-intelligence"
  | "us-universities"
  | "wise-activity"
  | "data-health";

export type NavBadgeKey =
  | "leaveRequests"
  | "lineReviews"
  | "progressTests"
  | "creditControl"
  | "payroll"
  | "wiseReconciliation"
  | "dataHealth";

export interface NavSection {
  id: NavSectionId;
  label: string;
  description: string;
}

export interface NavTool {
  id: NavToolId;
  href: string;
  label: string;
  description: string;
  section: NavSectionId;
  badgeKey?: NavBadgeKey;
  shortcut?: boolean;
}

export const HOME_HREF = "/";

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "scheduling-tutors",
    label: "Scheduling & Tutors",
    description: "Tutor availability, parent requests, room plans, and tutor operations.",
  },
  {
    id: "student-lifecycle",
    label: "Student Lifecycle",
    description: "Student academic progression and recurring progress-test workflows.",
  },
  {
    id: "finance-revenue",
    label: "Finance & Revenue",
    description: "Sales, prepaid credit follow-up, and payroll reconciliation.",
  },
  {
    id: "market-intelligence",
    label: "Market Intelligence",
    description: "Competitor activity, SEO visibility, offers, and response workflow.",
  },
  {
    id: "research-reference",
    label: "Research & Reference",
    description: "External datasets for advising — US university research and statistics.",
  },
  {
    id: "data-audit",
    label: "Data & Audit",
    description: "Wise audit trails, sync health, and data-quality control.",
  },
];

export const NAV_TOOLS: NavTool[] = [
  {
    id: "scheduler",
    href: "/scheduler",
    label: "Scheduler",
    description: "AI scheduling workspace and parent reply drafts.",
    section: "scheduling-tutors",
    shortcut: true,
  },
  {
    id: "search",
    href: "/search",
    label: "Search",
    description: "Find proven tutor availability and compare schedules.",
    section: "scheduling-tutors",
    shortcut: true,
  },
  {
    id: "line-review",
    href: "/line-review",
    label: "LINE AI Review",
    description: "Review parent-message scheduling requests from LINE.",
    section: "scheduling-tutors",
    badgeKey: "lineReviews",
  },
  {
    id: "leave-requests",
    href: "/leave-requests",
    label: "Leave Requests",
    description: "Triage tutor time-off requests and affected classes.",
    section: "scheduling-tutors",
    badgeKey: "leaveRequests",
  },
  {
    id: "class-assignments",
    href: "/class-assignments",
    label: "Class Assignments",
    description: "Generate daily room plans and publish eligible rooms to Wise.",
    section: "scheduling-tutors",
    shortcut: true,
  },
  {
    id: "tutor-profiles",
    href: "/tutor-profiles",
    label: "Tutor Profiles",
    description: "Maintain editorial tutor fit, tags, and parent-safe context.",
    section: "scheduling-tutors",
  },
  {
    id: "room-capacity",
    href: "/room-capacity",
    label: "Room Capacity",
    description: "Track room utilization and capacity pressure.",
    section: "scheduling-tutors",
  },
  {
    id: "scheduler-metrics",
    href: "/scheduler/metrics",
    label: "Scheduler Metrics",
    description: "Monitor AI scheduling accept, edit, and reject outcomes.",
    section: "scheduling-tutors",
  },
  {
    id: "progress-tests",
    href: "/progress-tests",
    label: "Progress Tests",
    description: "Track due, scheduled, and completed progress-test cycles.",
    section: "student-lifecycle",
    badgeKey: "progressTests",
  },
  {
    id: "student-promotions",
    href: "/student-promotions",
    label: "Student Promotions",
    description: "Review and apply audited July promotion actions.",
    section: "student-lifecycle",
  },
  {
    id: "sales-dashboard",
    href: "/sales-dashboard",
    label: "Sales Dashboard",
    description: "Review monthly sales imports, pace, and scenario projections.",
    section: "finance-revenue",
  },
  {
    id: "credit-control",
    href: "/credit-control",
    label: "Credit Control",
    description: "Prioritize prepaid-credit follow-up and at-risk students.",
    section: "finance-revenue",
    badgeKey: "creditControl",
  },
  {
    id: "payroll",
    href: "/payroll",
    label: "Payroll",
    description: "Reconcile tutor payouts, rates, and monthly review issues.",
    section: "finance-revenue",
    badgeKey: "payroll",
  },
  {
    id: "competitor-intelligence",
    href: "/competitor-intelligence",
    label: "Competitor BI",
    description: "Track competitor activity, search visibility, offers, and response tasks.",
    section: "market-intelligence",
  },
  {
    id: "us-universities",
    href: "/us-universities",
    label: "US Universities",
    description: "Research & compare US 4-year universities (IPEDS): admissions, cost, outcomes.",
    section: "research-reference",
  },
  {
    id: "wise-activity",
    href: "/wise-activity",
    label: "Wise Audit",
    description: "Inspect Wise activity events and package-sales reconciliation.",
    section: "data-audit",
    badgeKey: "wiseReconciliation",
  },
  {
    id: "data-health",
    href: "/data-health",
    label: "Data Health",
    description: "Check sync freshness, cron health, and normalization issues.",
    section: "data-audit",
    badgeKey: "dataHealth",
    shortcut: true,
  },
];

export function isActivePath(pathname: string, href: string): boolean {
  if (href === HOME_HREF) return pathname === HOME_HREF;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function canAccessHref(href: string, allowedPages: string[] | null): boolean {
  if (!allowedPages) return true;
  if (href === HOME_HREF) return allowedPages.length > 1;
  return allowedPages.some((page) => href === page || href.startsWith(`${page}/`));
}

export function filterToolsByAccess<T extends Pick<NavTool, "href">>(
  tools: T[],
  allowedPages: string[] | null,
): T[] {
  return tools.filter((tool) => canAccessHref(tool.href, allowedPages));
}

export function sectionTools(sectionId: NavSectionId, allowedPages: string[] | null): NavTool[] {
  return filterToolsByAccess(
    NAV_TOOLS.filter((tool) => tool.section === sectionId),
    allowedPages,
  );
}

export function visibleSections(allowedPages: string[] | null): Array<NavSection & { tools: NavTool[] }> {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    tools: sectionTools(section.id, allowedPages),
  })).filter((section) => section.tools.length > 0);
}

export function activeSection(pathname: string, allowedPages: string[] | null): NavSectionId | null {
  const section = visibleSections(allowedPages).find((item) =>
    item.tools.some((tool) => isActivePath(pathname, tool.href))
  );
  return section?.id ?? null;
}

export function shortcutTools(allowedPages: string[] | null): NavTool[] {
  return filterToolsByAccess(
    NAV_TOOLS.filter((tool) => tool.shortcut),
    allowedPages,
  );
}

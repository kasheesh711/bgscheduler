import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { TutorOffboardingError } from "../errors";
import type { WorkforceDrilldownQuery, WorkforceExportSection, WorkforceQuery } from "./types";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date.");
const label = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/);
const common = z.object({
  from: date,
  to: date,
  viewMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  role: z.enum(["all", "tutor", "teaching_admin"]).default("all"),
  modality: z.enum(["all", "online", "onsite"]).default("all"),
  subject: label.optional(), curriculum: label.optional(), level: label.optional(),
}).strict();
const detail = common.extend({
  kind: z.enum(["person", "subject_cell", "turnover"]),
  key: z.string().trim().min(1).max(500),
  reportRevision: z.string().min(1).max(200),
  cursor: z.string().min(1).max(500).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
}).strict();
const exporting = common.extend({
  section: z.enum(["months", "subjects", "week", "people"]),
  reportRevision: z.string().min(1).max(200),
}).strict();

function input(params: URLSearchParams): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key)) throw new TutorOffboardingError("Repeated workforce filters are not supported.", 400);
    values[key] = value;
  }
  values.from ??= "2026-03-01";
  values.to ??= formatInTimeZone(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
  values.viewMonth ??= values.to.slice(0, 7);
  return values;
}

function checkPeriod<T extends WorkforceQuery>(query: T): T {
  if (query.from < "2026-03-01" || query.from > query.to) {
    throw new TutorOffboardingError("Choose a date range beginning on or after 1 March 2026.", 400);
  }
  if (query.viewMonth < query.from.slice(0, 7) || query.viewMonth > query.to.slice(0, 7)) {
    throw new TutorOffboardingError("The selected month must be inside the date range.", 400);
  }
  // Bound user-controlled aggregation work while allowing a full year of projections.
  const latest = new Date();
  latest.setUTCFullYear(latest.getUTCFullYear() + 1);
  if (query.to > formatInTimeZone(latest, "Asia/Bangkok", "yyyy-MM-dd")) {
    throw new TutorOffboardingError("The date range may extend at most one year into the future.", 400);
  }
  return query;
}

export function parseWorkforceQuery(params: URLSearchParams): WorkforceQuery {
  return checkPeriod(common.parse(input(params)));
}
export function parseWorkforceDrilldownQuery(params: URLSearchParams): WorkforceDrilldownQuery {
  return checkPeriod(detail.parse(input(params)));
}
export function parseWorkforceExportQuery(params: URLSearchParams): {
  query: WorkforceQuery; section: WorkforceExportSection; reportRevision: string;
} {
  const { section, reportRevision, ...query } = checkPeriod(exporting.parse(input(params)));
  return { query, section, reportRevision };
}

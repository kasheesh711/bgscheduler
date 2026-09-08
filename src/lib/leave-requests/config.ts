export const LEAVE_REQUESTS_SPREADSHEET_ID =
  process.env.LEAVE_REQUESTS_SPREADSHEET_ID ?? "109o2vbmxlJ-l2U18Rs_WrjD7TMF5b6h__GiNkkQIfS8";

export const LEAVE_REQUESTS_SHEET_NAME =
  process.env.LEAVE_REQUESTS_SHEET_NAME ?? "Form Responses 1";

export const LEAVE_REQUESTS_SPREADSHEET_URL =
  `https://docs.google.com/spreadsheets/d/${LEAVE_REQUESTS_SPREADSHEET_ID}/edit`;

export const LEAVE_REQUESTS_STATUS_COLUMN = "S";

export const LEAVE_REQUESTS_CONNECTED_EMAIL =
  process.env.LEAVE_REQUESTS_CONNECTED_EMAIL ?? process.env.SALES_DASHBOARD_CONNECTED_EMAIL ?? "";

export const LEAVE_ROSTER_SPREADSHEET_ID = process.env.LEAVE_ROSTER_SPREADSHEET_ID ?? "1dacHgICN6YgH-guVV1maN5H3KtMSheKyCsmy708jwOs";
export const LEAVE_NORMALIZATION_MODEL = process.env.LEAVE_NORMALIZATION_MODEL ?? "gpt-6-astra";
export const LEAVE_NORMALIZATION_PROMPT_VERSION = "leave-work-v1";
export const LEAVE_NORMALIZATION_EFFORT = "medium" as const;
export const LEAVE_SYNC_ABANDONED_MS = 20 * 60 * 1000;
// Leave enough time for reconciliation and source writeback inside the 800s route.
export const LEAVE_NORMALIZATION_BUDGET_MS = 5 * 60 * 1000;

const vercelUrl = process.env.VERCEL_URL;

export const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.SCHEDULE_EMAIL_PUBLIC_BASE_URL ??
  (vercelUrl ? vercelUrl.replace(/^(?!https?:\/\/)/, "https://") : undefined) ??
  "https://bgscheduler.vercel.app";

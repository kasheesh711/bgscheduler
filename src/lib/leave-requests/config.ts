export const LEAVE_REQUESTS_SPREADSHEET_ID =
  process.env.LEAVE_REQUESTS_SPREADSHEET_ID ?? "109o2vbmxlJ-l2U18Rs_WrjD7TMF5b6h__GiNkkQIfS8";

export const LEAVE_REQUESTS_SHEET_NAME =
  process.env.LEAVE_REQUESTS_SHEET_NAME ?? "Form Responses 1";

export const LEAVE_REQUESTS_SPREADSHEET_URL =
  `https://docs.google.com/spreadsheets/d/${LEAVE_REQUESTS_SPREADSHEET_ID}/edit`;

export const LEAVE_REQUESTS_STATUS_COLUMN = "S";

export const LEAVE_REQUESTS_CONNECTED_EMAIL =
  process.env.LEAVE_REQUESTS_CONNECTED_EMAIL ?? process.env.SALES_DASHBOARD_CONNECTED_EMAIL ?? "";

const vercelUrl = process.env.VERCEL_URL;

export const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.SCHEDULE_EMAIL_PUBLIC_BASE_URL ??
  (vercelUrl ? vercelUrl.replace(/^(?!https?:\/\/)/, "https://") : undefined) ??
  "https://bgscheduler.vercel.app";

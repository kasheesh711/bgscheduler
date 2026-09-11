const DEFAULT_PUBLIC_BASE_URL = "https://bgscheduler.vercel.app";

// Preserve the schedule-email URL precedence for maps and shared brand assets.
export function teacherEmailPublicBaseUrl(): string {
  const value = process.env.SCHEDULE_EMAIL_PUBLIC_BASE_URL?.trim()
    || process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
    || process.env.VERCEL_URL?.trim()
    || DEFAULT_PUBLIC_BASE_URL;
  return (/^https?:\/\//i.test(value) ? value : `https://${value}`).replace(/\/+$/, "");
}

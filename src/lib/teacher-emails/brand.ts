// BeGifted 3.0.0 email assets only; this does not migrate application styling.
export const TEACHER_EMAIL_LOGO_PATH = "/brand/email/v3/logo-horizontal.png";

/**
 * The hiring email images (22 Nov 2026): BeGifted's own photos and the step icons. Exact paths only, so a mail client
 * can load them without a login while every neighbouring path stays private. A new image needs a new version folder.
 */
export const HIRING_EMAIL_ASSET_DIR = "/brand/email/hiring/v1/";
export const HIRING_EMAIL_ASSET_FILES = [
  "hero-r1.jpg",
  "hero-next-steps.jpg",
  "hero-visit.jpg",
  "hero-offer.jpg",
  "step-r1-interview.png",
  "step-form-booking.png",
  "step-exam.png",
  "step-mock-teaching.png",
  "step-offer.png",
] as const;
const HIRING_EMAIL_ASSETS = new Set<string>(HIRING_EMAIL_ASSET_FILES.map((file) => HIRING_EMAIL_ASSET_DIR + file));

export function isTeacherEmailAsset(pathname: string): boolean {
  return pathname === TEACHER_EMAIL_LOGO_PATH || HIRING_EMAIL_ASSETS.has(pathname);
}

export function hiringEmailAssetUrl(file: (typeof HIRING_EMAIL_ASSET_FILES)[number], baseUrl: string): string {
  return new URL(HIRING_EMAIL_ASSET_DIR + file, baseUrl).toString();
}

export function teacherEmailLogoUrl(baseUrl: string): string {
  return new URL(TEACHER_EMAIL_LOGO_PATH, baseUrl).toString();
}

// BeGifted 3.0.0 email assets only; this does not migrate application styling.
export const TEACHER_EMAIL_LOGO_PATH = "/brand/email/v3/logo-horizontal.png";

export function isTeacherEmailAsset(pathname: string): boolean {
  return pathname === TEACHER_EMAIL_LOGO_PATH;
}

export function teacherEmailLogoUrl(baseUrl: string): string {
  return new URL(TEACHER_EMAIL_LOGO_PATH, baseUrl).toString();
}

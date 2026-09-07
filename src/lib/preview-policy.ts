export interface PreviewEnvironment extends Record<string, string | undefined> {
  VERCEL_ENV?: string;
  PREVIEW_SANDBOX_ENABLED?: string;
}

export function isPreviewEnvironment(env: PreviewEnvironment = process.env): boolean {
  return env.VERCEL_ENV === "preview" || env.PREVIEW_SANDBOX_ENABLED === "true";
}

export function googleAuthorizationParams(env: PreviewEnvironment = process.env): Record<string, string> {
  if (isPreviewEnvironment(env)) return { scope: "openid email profile" };
  return {
    scope: "openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
  };
}

export function shouldStoreGoogleIntegrationTokens(env: PreviewEnvironment = process.env): boolean {
  return !isPreviewEnvironment(env);
}

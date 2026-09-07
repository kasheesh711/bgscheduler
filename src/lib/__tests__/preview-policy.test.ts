import { describe, expect, it } from "vitest";
import { googleAuthorizationParams, isPreviewEnvironment, shouldStoreGoogleIntegrationTokens } from "@/lib/preview-policy";

describe("preview authentication policy", () => {
  it("recognizes every Vercel preview even when its optional sandbox flag is absent", () => {
    expect(isPreviewEnvironment({ VERCEL_ENV: "preview" })).toBe(true);
    expect(isPreviewEnvironment({ PREVIEW_SANDBOX_ENABLED: "true" })).toBe(true);
    expect(isPreviewEnvironment({ VERCEL_ENV: "production" })).toBe(false);
  });

  it("requests identity only without offline access and never persists integration tokens in preview", () => {
    const env = { VERCEL_ENV: "preview" };
    expect(googleAuthorizationParams(env)).toEqual({ scope: "openid email profile" });
    expect(shouldStoreGoogleIntegrationTokens(env)).toBe(false);
  });

  it("preserves production Sheets/Drive OAuth behavior", () => {
    expect(googleAuthorizationParams({ VERCEL_ENV: "production" })).toEqual({
      scope: "openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
    });
    expect(shouldStoreGoogleIntegrationTokens({ VERCEL_ENV: "production" })).toBe(true);
  });
});

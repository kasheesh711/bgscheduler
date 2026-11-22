import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HIRING_EMAIL_ASSET_DIR, HIRING_EMAIL_ASSET_FILES, isTeacherEmailAsset, TEACHER_EMAIL_LOGO_PATH } from "../brand";

describe("public email images", () => {
  it("allows the logo and each hiring image by its exact path, and each file exists", () => {
    expect(isTeacherEmailAsset(TEACHER_EMAIL_LOGO_PATH)).toBe(true);
    for (const file of HIRING_EMAIL_ASSET_FILES) {
      expect(isTeacherEmailAsset(HIRING_EMAIL_ASSET_DIR + file)).toBe(true);
      expect(existsSync(join(process.cwd(), "public", HIRING_EMAIL_ASSET_DIR, file))).toBe(true);
    }
  });
  it.each([
    "/brand/email/hiring/v1/",
    "/brand/email/hiring/v1/private.png",
    "/brand/email/hiring/v2/hero-r1.jpg",
    "/brand/email/hiring/v1/hero-r1.jpg/extra",
    "/brand/email/hiring/v1/../v3/logo-horizontal.png",
  ])("keeps a neighbouring path private: %s", (pathname) => {
    expect(isTeacherEmailAsset(pathname)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { adminAccentFor } from "@/lib/scheduler/admin-colors";

describe("adminAccentFor", () => {
  it("assigns a stable color for the same admin email", () => {
    expect(adminAccentFor("Kev@example.com").key).toBe(adminAccentFor("kev@example.com").key);
  });

  it("uses different accents across known admins", () => {
    const accents = [
      adminAccentFor("kev@example.com").key,
      adminAccentFor("care@example.com").key,
      adminAccentFor("petchy@example.com").key,
      adminAccentFor("aoeng@example.com").key,
    ];

    expect(new Set(accents).size).toBeGreaterThan(1);
  });

  it("falls back to display name when email is unavailable", () => {
    expect(adminAccentFor(null, "Kevin Hsieh").label).toBe("Kevin Hsieh");
  });
});

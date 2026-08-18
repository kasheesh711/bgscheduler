/**
 * Grace-hours resolution for the auto-approval sweep.
 *
 * The resolver guards the two failure modes a bare `Number(raw ?? 24)` had
 * once the accrual cron is scheduled: a blank value coercing to a 0-hour
 * grace (immediate auto-approval) and a malformed value coercing to NaN.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveAutoApproveGraceHours } from "@/lib/post-class-feedback/auto-approval";

describe("resolveAutoApproveGraceHours", () => {
  it("defaults to 24 when the variable is absent", () => {
    expect(resolveAutoApproveGraceHours(undefined)).toBe(24);
  });

  it("defaults to 24 for blank values instead of coercing to a 0-hour grace", () => {
    expect(resolveAutoApproveGraceHours("")).toBe(24);
    expect(resolveAutoApproveGraceHours("  ")).toBe(24);
  });

  it("defaults to 24 for non-numeric values instead of a NaN deadline", () => {
    expect(resolveAutoApproveGraceHours("banana")).toBe(24);
    expect(resolveAutoApproveGraceHours("24h")).toBe(24);
  });

  it("rejects negative and infinite values", () => {
    expect(resolveAutoApproveGraceHours("-1")).toBe(24);
    expect(resolveAutoApproveGraceHours("Infinity")).toBe(24);
  });

  it("keeps explicit zero as a deliberate immediate-approval mode", () => {
    expect(resolveAutoApproveGraceHours("0")).toBe(0);
  });

  it("accepts ordinary and fractional hour values", () => {
    expect(resolveAutoApproveGraceHours("36")).toBe(36);
    expect(resolveAutoApproveGraceHours("1.5")).toBe(1.5);
  });
});

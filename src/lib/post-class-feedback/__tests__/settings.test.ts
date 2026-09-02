import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  postClassActivationIsBackdated,
  postClassTutorEmailCoverageReady,
} from "@/lib/post-class-feedback/settings";

describe("post-class setup coverage", () => {
  it("fails closed when an eligible tutor has no contact row", () => {
    expect(postClassTutorEmailCoverageReady(
      ["tutor-a", "tutor-missing"],
      [{
        canonicalKey: "tutor-a",
        primaryEmail: "a@example.com",
        onsiteEmail: null,
        onlineEmail: null,
      }],
    )).toBe(false);
  });

  it("accepts an explicit primary email", () => {
    expect(postClassTutorEmailCoverageReady(
      ["tutor-a"],
      [{
        canonicalKey: "tutor-a",
        primaryEmail: "a@example.com",
        onsiteEmail: "onsite@example.com",
        onlineEmail: "different@example.com",
      }],
    )).toBe(true);
  });

  it("accepts one unambiguous normalized Wise fallback", () => {
    expect(postClassTutorEmailCoverageReady(
      ["tutor-a"],
      [{
        canonicalKey: "tutor-a",
        primaryEmail: null,
        onsiteEmail: " Tutor@Example.com ",
        onlineEmail: "tutor@example.com",
      }],
    )).toBe(true);
  });

  it("rejects conflicting Wise fallback addresses", () => {
    expect(postClassTutorEmailCoverageReady(
      ["tutor-a"],
      [{
        canonicalKey: "tutor-a",
        primaryEmail: null,
        onsiteEmail: "onsite@example.com",
        onlineEmail: "online@example.com",
      }],
    )).toBe(false);
  });
});

describe("post-class activation boundary", () => {
  const now = new Date("2026-07-21T12:00:00.000Z");

  it("rejects a backdated first activation", () => {
    expect(postClassActivationIsBackdated(
      new Date("2026-07-20T12:00:00.000Z"),
      now,
      false,
    )).toBe(true);
  });

  it("allows a resumed live window to retain the immutable original effective time", () => {
    expect(postClassActivationIsBackdated(
      new Date("2026-07-01T12:00:00.000Z"),
      now,
      true,
    )).toBe(false);
  });
});

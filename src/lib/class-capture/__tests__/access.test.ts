import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canUseClassCapture, requireCaptureScope } from "../sessions";

function database(queue: unknown[][]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let index = 0;
  const db = { select: () => {
    const rows = queue[index++] ?? [];
    const chain = {
      from: () => chain,
      where: (filter: SQL) => { queries.push(new PgDialect().sqlToQuery(filter)); return chain; },
      limit: () => chain,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return chain;
  } };
  vi.mocked(getDb).mockReturnValue(db as never);
  return queries;
}

const contact = { canonicalKey: "Tutor Example", displayName: "Tutor Example", active: true,
  onsiteEmail: "tutor@example.test", onlineEmail: "online@example.test" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ENABLE_CLASS_CAPTURE", "true");
  vi.mocked(auth).mockResolvedValue({ user: { email: " TUTOR@EXAMPLE.TEST ", role: "teacher", allowedPages: ["/progress-tests"] } } as never);
});

describe("fresh class capture access", () => {
  it("requires an authenticated email before any database lookup", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 401 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("uses only exact active contact email bindings for a teacher", async () => {
    const queries = database([[], [contact]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email: "tutor@example.test", keys: ["Tutor Example"] });
    expect(queries[1].sql).toContain('"tutor_contacts"."active"');
    expect(queries[1].params).toContain("tutor@example.test");
    expect(queries[1].sql).not.toContain("display_name");
  });

  it("accepts an exact online email binding for the same canonical tutor", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "online@example.test", role: "teacher" } } as never);
    database([[], [contact]]);
    await expect(requireCaptureScope()).resolves.toMatchObject({ keys: ["Tutor Example"] });
  });

  it.each([[], [contact, { ...contact, canonicalKey: "Other Tutor" }], [{ ...contact, active: false }], [{ ...contact, onsiteEmail: "different@example.test" }]].map(contacts => ({ contacts })))("denies absent, ambiguous, inactive and name-only bindings: $contacts", async ({ contacts }) => {
    database([[], contacts]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
  });

  it.each([null, ["/class-capture"]])("grants current full or dedicated admin page access: %j", async (allowedPages) => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "admin@example.test", role: "admin", allowedPages: ["/search"] } } as never);
    database([[{ disabled: false, allowedPages }]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email: "admin@example.test", keys: null });
  });

  it.each([
    { disabled: true, allowedPages: null },
    { disabled: false, allowedPages: ["/progress-tests"] },
    { disabled: false, allowedPages: [] },
  ])("denies revoked admins without falling back to a tutor contact", async (admin) => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "tutor@example.test", role: "admin", allowedPages: null } } as never);
    database([[admin], [contact]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
  });

  it("does not revive a deleted admin through a teacher binding", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "tutor@example.test", role: "admin" } } as never);
    database([[], [contact]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
  });

  it("keeps navigation hidden while disabled and when fresh access fails", async () => {
    vi.stubEnv("ENABLE_CLASS_CAPTURE", "false");
    await expect(canUseClassCapture()).resolves.toBe(false);
    expect(getDb).not.toHaveBeenCalled();
    vi.stubEnv("ENABLE_CLASS_CAPTURE", "true");
    database([[], []]);
    await expect(canUseClassCapture()).resolves.toBe(false);
    database([[], [contact]]);
    await expect(canUseClassCapture()).resolves.toBe(true);
  });
});

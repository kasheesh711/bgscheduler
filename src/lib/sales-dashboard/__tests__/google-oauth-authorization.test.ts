import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { revalidateTag } = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag }));

import {
  authorizedGoogleSheetsTokenOwnerClause,
  storeGoogleOAuthTokenForUser,
} from "@/lib/sales-dashboard/google-oauth";

function tokenDb(selectedQueue: unknown[][] = []) {
  let selectIndex = 0;
  const execute = vi.fn(async () => []);
  const limit = vi.fn(async () => selectedQueue[selectIndex++] ?? []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  const onConflictDoUpdate = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  const tx = { execute, select, insert };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
  return {
    db: { ...tx, transaction } as never,
    insert,
    values,
    execute,
    transaction,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-secret-for-token-encryption";
});

describe("Google Sheets token owner authorization", () => {
  it("correlates token reads to an admin or active counselor", () => {
    const query = new PgDialect().sqlToQuery(authorizedGoogleSheetsTokenOwnerClause()).sql;
    expect(query).toContain('FROM "admin_users"');
    expect(query).toContain('FROM "admissions_counselors"');
    expect(query).toContain('"admissions_counselors"."active" = true');
    expect(query).toContain('"google_oauth_tokens"."email"');
  });

  it("rechecks live staff authority before storing OAuth credentials", async () => {
    const { db, insert } = tokenDb([[], []]);

    await expect(storeGoogleOAuthTokenForUser("former@example.com", {
      provider: "google",
      access_token: "access-token",
      scope: "openid https://www.googleapis.com/auth/spreadsheets.readonly",
    }, db)).rejects.toThrow("Forbidden");
    expect(insert).not.toHaveBeenCalled();
  });

  it("stores an explicit Sheets grant for a currently authorized staff member", async () => {
    const { db, insert, values, execute } = tokenDb([[{ id: "admin-1" }], []]);

    await storeGoogleOAuthTokenForUser("Staff@Example.com", {
      provider: "google",
      access_token: "access-token",
      scope: "openid https://www.googleapis.com/auth/spreadsheets.readonly",
    }, db);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      email: "staff@example.com",
      scope: "openid https://www.googleapis.com/auth/spreadsheets.readonly",
    }));
  });
});

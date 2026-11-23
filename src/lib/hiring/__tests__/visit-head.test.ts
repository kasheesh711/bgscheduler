import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/db";
import type { hiringBookings } from "@/lib/db/schema";
import { visitHead } from "../worker";

const dbWith = (rows: { email: string | null }[]) =>
  ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as unknown as Database;
const paper = (visitId: string | null) =>
  ({ kind: "paper", visitId, subjects: ["Chemistry"] }) as typeof hiringBookings.$inferSelect;
const roster = [
  { email: "peat@example.com", subjects: ["Chemistry", "Physics"] },
  { email: "tito@example.com", subjects: ["History"] },
  { email: "ek@example.com", subjects: ["Chemistry"] },
];

describe("visitHead (Kevin, 23 Nov 2026: only the relevant head)", () => {
  it("names the paired mock's head only", async () => {
    expect(await visitHead(dbWith([{ email: "ek@example.com" }]), paper("v1"), roster)).toEqual(["ek@example.com"]);
  });
  it("uses the subject's roster heads for a test-only visit", async () => {
    expect(await visitHead(dbWith([]), paper("v1"), roster)).toEqual(["peat@example.com", "ek@example.com"]);
  });
  it("adds nobody to a mock or a paper row outside a visit", async () => {
    const db = dbWith([{ email: "ek@example.com" }]);
    expect(await visitHead(db, { ...paper("v1"), kind: "mock" }, roster)).toEqual([]);
    expect(await visitHead(db, paper(null), roster)).toEqual([]);
  });
});

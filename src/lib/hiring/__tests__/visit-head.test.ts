import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/db";
import type { hiringBookings } from "@/lib/db/schema";
import { visitHead } from "../worker";

const dbWith = (rows: { key: string | null; email: string | null }[]) =>
  ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as unknown as Database;
const paper = (visitId: string | null) =>
  ({ kind: "paper", visitId, subjects: ["Chemistry"] }) as typeof hiringBookings.$inferSelect;
const roster = [
  { canonicalKey: "Peat", email: "peat@example.com", subjects: ["Chemistry", "Physics"] },
  { canonicalKey: "Tito", email: "tito@example.com", subjects: ["History"] },
  { canonicalKey: "Ek", email: "ek@example.com", subjects: ["Chemistry"] },
];

describe("visitHead (Kevin, 23 Nov 2026: only the relevant head)", () => {
  it("names the paired mock's head only, with that head's roster color", async () => {
    expect(await visitHead(dbWith([{ key: "Ek", email: "ek@example.com" }]), paper("v1"), roster)).toEqual([
      { key: "Ek", email: "ek@example.com", colorId: "5" },
    ]);
  });
  it("uses the subject's roster heads for a test-only visit", async () => {
    expect(await visitHead(dbWith([]), paper("v1"), roster)).toEqual([
      { key: "Peat", email: "peat@example.com", colorId: "11" },
      { key: "Ek", email: "ek@example.com", colorId: "5" },
    ]);
  });
  it("names a mock's own head, and nobody on a paper row outside a visit", async () => {
    const db = dbWith([{ key: "Ek", email: "ek@example.com" }]);
    const mock = { ...paper("v1"), kind: "mock", interviewerKey: "Tito", interviewerEmail: "tito@example.com" } as typeof hiringBookings.$inferSelect;
    expect(await visitHead(db, mock, roster)).toEqual([{ key: "Tito", email: "tito@example.com", colorId: "10" }]);
    // A head no longer on the roster keeps the title, with no color.
    expect(await visitHead(db, { ...mock, interviewerKey: "Mimi" }, roster)).toEqual([{ key: "Mimi", email: "tito@example.com" }]);
    expect(await visitHead(db, paper(null), roster)).toEqual([]);
    expect(await visitHead(db, { ...mock, interviewerEmail: null }, roster)).toEqual([]);
    expect(await visitHead(db, { ...mock, kind: "call" }, roster)).toEqual([]);
  });
  it("gives each of the first ten roster heads a different color, never Graphite", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ canonicalKey: `H${i}`, email: `h${i}@example.com`, subjects: ["Chemistry"] }));
    const colors = (await visitHead(dbWith([]), paper("v1"), ten)).map((head) => head.colorId);
    expect(new Set(colors).size).toBe(10);
    expect(colors).not.toContain("8");
  });
});

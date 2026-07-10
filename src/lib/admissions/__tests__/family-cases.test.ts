import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { listLinkedFamilyCases } from "@/lib/admissions/family-cases";

function fakeDb(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where"]) builder[method] = () => builder;
  (builder as { then: unknown }).then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve, reject);
  return { select: () => builder };
}

describe("listLinkedFamilyCases", () => {
  it("returns a stable safe projection with hrefs and no raw ids or emails", async () => {
    const db = fakeDb([
      {
        caseId: "22222222-2222-4222-8222-222222222222",
        status: "completed",
        studentName: "Ben",
        preferredName: null,
        cohortName: "Class of 2026",
        createdAt: new Date("2025-01-01T00:00:00Z"),
        email: "poison@example.com",
      },
      {
        caseId: "11111111-1111-4111-8111-111111111111",
        status: "active",
        studentName: "Ada",
        preferredName: "Addie",
        cohortName: "Class of 2028",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        email: "poison@example.com",
      },
    ]);

    const result = await listLinkedFamilyCases(" Parent@Example.com ", db as never);

    expect(result).toEqual([
      {
        href: "/admissions/11111111-1111-4111-8111-111111111111",
        studentName: "Ada",
        preferredName: "Addie",
        cohortName: "Class of 2028",
        caseStatus: "active",
      },
      {
        href: "/admissions/22222222-2222-4222-8222-222222222222",
        studentName: "Ben",
        preferredName: null,
        cohortName: "Class of 2026",
        caseStatus: "completed",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("caseId");
    expect(JSON.stringify(result)).not.toContain("@example.com");
  });

  it("returns early for a blank email", async () => {
    const select = vi.fn();
    await expect(listLinkedFamilyCases("  ", { select } as never)).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});

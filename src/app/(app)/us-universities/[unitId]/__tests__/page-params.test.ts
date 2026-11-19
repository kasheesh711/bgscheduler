import { describe, expect, it, vi } from "vitest";

// Mock heavy server-side dependencies so pure param helpers can be unit-tested
// without pulling in next-auth, next/navigation, or the DB layer.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/us-universities/data", () => ({ getInstitutionProfile: vi.fn() }));
vi.mock("@/components/us-universities/institution-dossier", () => ({ InstitutionDossier: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));

import { parseUnitId } from "../page";

describe("parseUnitId", () => {
  it("parses a positive integer", () => {
    expect(parseUnitId("166027")).toBe(166027);
  });
  it("rejects non-numeric, zero, and negative ids", () => {
    expect(parseUnitId("abc")).toBeNull();
    expect(parseUnitId("0")).toBeNull();
    expect(parseUnitId("-5")).toBeNull();
  });
});

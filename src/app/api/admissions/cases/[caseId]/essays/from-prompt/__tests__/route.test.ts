import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCaseAccess: vi.fn(),
  assertCaseMutationAllowed: vi.fn(),
}));
vi.mock("@/lib/admissions/essay-prompt-catalog", () => ({
  createEssayFromCatalogPrompt: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { assertCaseMutationAllowed, requireCaseAccess } from "@/lib/admissions/access";
import { createEssayFromCatalogPrompt } from "@/lib/admissions/essay-prompt-catalog";
import { POST } from "../route";

const authMock = auth as unknown as Mock;
const CASE_ID = "11111111-1111-4111-8111-111111111111";
const PROMPT_ID = "22222222-2222-4222-8222-222222222222";

describe("/api/admissions/cases/[caseId]/essays/from-prompt", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: { email: "student@example.com", name: "Student", role: "student", allowedPages: ["/admissions"] },
    });
    vi.mocked(requireCaseAccess).mockResolvedValue({
      caseId: CASE_ID,
      email: "student@example.com",
      role: "student",
      isAdmin: false,
    });
    vi.mocked(createEssayFromCatalogPrompt).mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      caseId: CASE_ID,
      listItemId: null,
      prompt: "Prompt text",
      status: "not_started",
      deadline: null,
      driveUrl: null,
      sharedWithFamily: false,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("creates tracking metadata from a catalog prompt without storing essay body text", async () => {
    const response = await POST(new NextRequest(
      `http://test.local/api/admissions/cases/${CASE_ID}/essays/from-prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptId: PROMPT_ID }),
      },
    ), { params: Promise.resolve({ caseId: CASE_ID }) });
    expect(response.status).toBe(200);
    expect(assertCaseMutationAllowed).toHaveBeenCalled();
    expect(createEssayFromCatalogPrompt).toHaveBeenCalledWith(expect.objectContaining({
      promptId: PROMPT_ID,
    }));
  });

  it.each([
    { listItemId: "44444444-4444-4444-8444-444444444444" },
    { deadline: "2026-11-01" },
  ])("keeps official catalog linkage fields counselor-owned: %j", async (fields) => {
    const response = await POST(new NextRequest(
      `http://test.local/api/admissions/cases/${CASE_ID}/essays/from-prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptId: PROMPT_ID, ...fields }),
      },
    ), { params: Promise.resolve({ caseId: CASE_ID }) });
    expect(response.status).toBe(403);
    expect(createEssayFromCatalogPrompt).not.toHaveBeenCalled();
  });
});

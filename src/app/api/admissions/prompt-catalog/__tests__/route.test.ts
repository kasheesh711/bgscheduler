import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCounselorOrAdmin: vi.fn(),
}));
vi.mock("@/lib/admissions/essay-prompt-catalog", () => ({
  createEssayPrompt: vi.fn(),
  listEssayPromptCatalog: vi.fn(),
  updateEssayPrompt: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCounselorOrAdmin } from "@/lib/admissions/access";
import {
  createEssayPrompt,
  listEssayPromptCatalog,
  updateEssayPrompt,
} from "@/lib/admissions/essay-prompt-catalog";
import { GET, POST } from "../route";

const authMock = auth as unknown as Mock;
const PROMPT_ID = "11111111-1111-4111-8111-111111111111";
const PROMPT = {
  id: PROMPT_ID,
  unitId: 166027,
  institution: "Harvard University",
  program: "",
  cycle: "2026-27",
  promptKey: "supplement_1",
  prompt: "Describe an experience that shaped you.",
  wordLimit: 200,
  required: true,
  sourceUrl: "https://college.harvard.edu/admissions/apply",
  verifiedAt: "2026-07-01T00:00:00.000Z",
  verifiedByEmail: "staff@example.com",
  active: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

describe("/api/admissions/prompt-catalog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: { email: "staff@example.com", name: "Staff", role: "counselor", allowedPages: ["/admissions"] },
    });
    vi.mocked(listEssayPromptCatalog).mockResolvedValue([PROMPT]);
    vi.mocked(requireCounselorOrAdmin).mockResolvedValue({
      email: "staff@example.com",
      role: "counselor",
      isAdmin: false,
    });
    vi.mocked(createEssayPrompt).mockResolvedValue(PROMPT);
    vi.mocked(updateEssayPrompt).mockResolvedValue(PROMPT);
  });

  it("filters the annual catalog by institution, cycle, and IPEDS unit", async () => {
    const response = await GET(new NextRequest(
      "http://test.local/api/admissions/prompt-catalog?institution=Harvard&cycle=2026-27&unitId=166027",
    ));
    expect(response.status).toBe(200);
    expect(listEssayPromptCatalog).toHaveBeenCalledWith({
      institution: "Harvard",
      cycle: "2026-27",
      unitId: 166027,
      activeOnly: true,
    });
    expect(requireCounselorOrAdmin).toHaveBeenCalledWith("staff@example.com");
  });

  it("allows verified staff to include inactive prompts", async () => {
    const response = await GET(new NextRequest(
      "http://test.local/api/admissions/prompt-catalog?activeOnly=false",
    ));
    expect(response.status).toBe(200);
    expect(listEssayPromptCatalog).toHaveBeenCalledWith({
      institution: undefined,
      cycle: undefined,
      unitId: undefined,
      activeOnly: false,
    });
    expect(await response.json()).toEqual({ prompts: [PROMPT] });
  });

  it("forces family roles to active prompts and removes staff attribution metadata", async () => {
    authMock.mockResolvedValue({
      user: { email: "student@example.com", name: "Student", role: "student", allowedPages: ["/admissions"] },
    });

    const response = await GET(new NextRequest(
      "http://test.local/api/admissions/prompt-catalog?activeOnly=false",
    ));

    expect(response.status).toBe(200);
    expect(requireCounselorOrAdmin).not.toHaveBeenCalled();
    expect(listEssayPromptCatalog).toHaveBeenCalledWith({
      institution: undefined,
      cycle: undefined,
      unitId: undefined,
      activeOnly: true,
    });
    const payload = await response.json();
    expect(payload.prompts[0]).not.toHaveProperty("verifiedByEmail");
    expect(payload.prompts[0]).not.toHaveProperty("createdAt");
    expect(payload.prompts[0]).not.toHaveProperty("updatedAt");
    expect(payload.prompts[0]).toMatchObject({
      id: PROMPT_ID,
      institution: "Harvard University",
      active: true,
    });
  });

  it("creates a source-attributed, verified prompt as staff", async () => {
    const response = await POST(new NextRequest(
      "http://test.local/api/admissions/prompt-catalog",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          unitId: 166027,
          institution: "Harvard University",
          cycle: "2026-27",
          promptKey: "supplement_1",
          prompt: "Describe an experience that shaped you.",
          wordLimit: 200,
          sourceUrl: "https://college.harvard.edu/admissions/apply",
          verified: true,
        }),
      },
    ));
    expect(response.status).toBe(200);
    expect(createEssayPrompt).toHaveBeenCalledWith(expect.objectContaining({
      actorEmail: "staff@example.com",
      actorRole: "counselor",
      verified: true,
    }));
  });

  it("rejects a non-positive word limit at the route boundary", async () => {
    const response = await POST(new NextRequest(
      "http://test.local/api/admissions/prompt-catalog",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          institution: "College",
          cycle: "2026-27",
          promptKey: "one",
          prompt: "Prompt",
          wordLimit: 0,
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect(createEssayPrompt).not.toHaveBeenCalled();
  });
});

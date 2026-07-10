import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCaseAccess: vi.fn(),
  assertCaseMutationAllowed: vi.fn(),
}));
vi.mock("@/lib/admissions/communications", () => ({ sendCaseDirectMessage: vi.fn() }));

import { auth } from "@/lib/auth";
import { assertCaseMutationAllowed, requireCaseAccess } from "@/lib/admissions/access";
import { sendCaseDirectMessage } from "@/lib/admissions/communications";
import { POST } from "../route";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";
const authMock = auth as unknown as Mock;

describe("/api/admissions/cases/[caseId]/messages", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: { email: "counselor@example.com", name: "Kai Counselor", role: "counselor", allowedPages: ["/admissions"] },
    });
    vi.mocked(requireCaseAccess).mockResolvedValue({
      caseId: CASE_ID,
      email: "counselor@example.com",
      role: "counselor",
      isAdmin: false,
    });
    vi.mocked(sendCaseDirectMessage).mockResolvedValue({
      outboxId: "33333333-3333-4333-8333-333333333333",
      deliveryStatus: "sent",
      providerMessageId: "email_123",
      idempotentReplay: false,
    });
  });

  it("sends a direct message only after staff access and lifecycle checks", async () => {
    const response = await POST(new NextRequest(
      `http://test.local/api/admissions/cases/${CASE_ID}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientMemberId: MEMBER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          subject: "Application update",
          body: "Your checklist is ready.",
        }),
      },
    ), { params: Promise.resolve({ caseId: CASE_ID }) });
    expect(response.status).toBe(200);
    expect(assertCaseMutationAllowed).toHaveBeenCalled();
    expect(sendCaseDirectMessage).toHaveBeenCalledWith(expect.objectContaining({
      recipientMemberId: MEMBER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      senderName: "Kai Counselor",
    }));
    await expect(response.json()).resolves.toMatchObject({
      sent: true,
      queued: false,
      outboxId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("requires a client-generated UUID idempotency key", async () => {
    const response = await POST(new NextRequest(
      `http://test.local/api/admissions/cases/${CASE_ID}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientMemberId: MEMBER_ID,
          idempotencyKey: "not-a-uuid",
          subject: "Application update",
          body: "Your checklist is ready.",
        }),
      },
    ), { params: Promise.resolve({ caseId: CASE_ID }) });

    expect(response.status).toBe(400);
    expect(sendCaseDirectMessage).not.toHaveBeenCalled();
  });

  it("checks access before parsing a body", async () => {
    vi.mocked(requireCaseAccess).mockRejectedValue(new Error("Forbidden"));
    const response = await POST(new NextRequest(
      `http://test.local/api/admissions/cases/${CASE_ID}/messages`,
      { method: "POST" },
    ), { params: Promise.resolve({ caseId: CASE_ID }) });
    expect(response.status).toBe(403);
    expect(sendCaseDirectMessage).not.toHaveBeenCalled();
  });
});

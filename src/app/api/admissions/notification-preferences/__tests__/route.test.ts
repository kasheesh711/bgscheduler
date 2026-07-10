import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCaseAccess: vi.fn(),
}));
vi.mock("@/lib/admissions/communications", () => ({
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "@/lib/admissions/communications";
import { GET, PATCH } from "../route";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const authMock = auth as unknown as Mock;
const PREFS = {
  announcements: "digest" as const,
  tasks: "default" as const,
  comments: "off" as const,
  deadlineReminders: "mandatory" as const,
};

describe("/api/admissions/notification-preferences", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: { email: "parent@example.com", name: "Parent", role: "parent", allowedPages: ["/admissions"] },
    });
    vi.mocked(requireCaseAccess).mockResolvedValue({
      caseId: CASE_ID,
      email: "parent@example.com",
      role: "parent",
      isAdmin: false,
    });
    vi.mocked(getNotificationPreferences).mockResolvedValue(PREFS);
    vi.mocked(updateNotificationPreferences).mockResolvedValue(PREFS);
  });

  it("lets a linked family member read preferences while keeping deadlines mandatory", async () => {
    const response = await GET(new NextRequest(
      `http://test.local/api/admissions/notification-preferences?caseId=${CASE_ID}`,
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ preferences: PREFS });
    expect(requireCaseAccess).toHaveBeenCalledWith("parent@example.com", CASE_ID, "parent");
  });

  it("updates only downgradeable categories", async () => {
    const response = await PATCH(new NextRequest(
      "http://test.local/api/admissions/notification-preferences",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: CASE_ID,
          announcements: "digest",
          tasks: "default",
          comments: "off",
        }),
      },
    ));
    expect(response.status).toBe(200);
    expect(updateNotificationPreferences).toHaveBeenCalledWith(expect.objectContaining({
      access: expect.objectContaining({ role: "parent" }),
      announcements: "digest",
      tasks: "default",
      comments: "off",
    }));
  });

  it("rejects attempts to submit a deadline-reminder preference", async () => {
    const response = await PATCH(new NextRequest(
      "http://test.local/api/admissions/notification-preferences",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: CASE_ID,
          announcements: "default",
          tasks: "default",
          comments: "default",
          deadlineReminders: "off",
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it("keeps completed family cases read-only", async () => {
    vi.mocked(requireCaseAccess).mockResolvedValue({
      caseId: CASE_ID,
      email: "parent@example.com",
      role: "parent",
      isAdmin: false,
      familyReadOnly: true,
    });

    const response = await PATCH(new NextRequest(
      "http://test.local/api/admissions/notification-preferences",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: CASE_ID,
          announcements: "default",
          tasks: "default",
          comments: "default",
        }),
      },
    ));

    expect(response.status).toBe(403);
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });
});

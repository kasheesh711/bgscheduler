import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/classrooms/operations-access", () => ({ requireClassroomOperationsOwner: vi.fn() }));
vi.mock("@/lib/feedback-autowriter/iseb-rollout", () => ({
  approveIsebComparisons: vi.fn(), approveScheduledAtomProof: vi.fn(), confirmUnattendedAtomProof: vi.fn(),
}));

import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { AutowriterReviewError } from "@/lib/feedback-autowriter/api";
import { approveScheduledAtomProof, confirmUnattendedAtomProof } from "@/lib/feedback-autowriter/iseb-rollout";
import { POST } from "../atom/rollout/route";

const owner = vi.mocked(requireClassroomOperationsOwner);
const approve = vi.mocked(approveScheduledAtomProof);
const body = { action: "approve_cloud_run", runId: "11111111-1111-4111-8111-111111111111",
  comparisonHash: "a".repeat(64), note: "Accept successful server retrieval" };
const post = (value: unknown) => new NextRequest("http://localhost/api/feedback-autowriter/atom/rollout", {
  method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json" },
});
beforeEach(() => {
  vi.resetAllMocks();
  owner.mockResolvedValue({ email: "owner@example.com", accessVersion: 1 } as never);
});
describe("Atom scheduled cloud approval", () => {
  it("records the authenticated owner, comparison and note without calling the computer-off path", async () => {
    const response = await POST(post({ ...body, note: `  ${body.note}  ` }));
    expect(response.status).toBe(200);
    expect(approve).toHaveBeenCalledExactlyOnceWith(expect.anything(), body.runId, body.comparisonHash, "owner@example.com", body.note);
    expect(confirmUnattendedAtomProof).not.toHaveBeenCalled();
  });
  it("rejects a non-owner before any mutation", async () => {
    owner.mockRejectedValue(new AdminUsersAccessError("Forbidden", 403));
    expect((await POST(post(body))).status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });
  it.each([
    { note: " " }, { note: "a".repeat(1001) }, { comparisonHash: null }, { comparisonHash: "stale" },
    { runId: "not-a-run" }, { codexAndComputerWereOff: true }, { approvedBy: "somebody_else" },
  ])("rejects invalid or extra approval fields: %j", async invalid => {
    expect((await POST(post({ ...body, ...invalid }))).status).toBe(400);
    expect(approve).not.toHaveBeenCalled();
  });
  it("reports a changed comparison or unsuitable run as a conflict", async () => {
    approve.mockRejectedValue(new AutowriterReviewError("Reload the comparison", 409));
    expect((await POST(post(body))).status).toBe(409);
  });
  it("retains the explicit computer-off path only when the owner confirms it", async () => {
    const physical = { action: "confirm_unattended_run", runId: body.runId };
    expect((await POST(post(physical))).status).toBe(400);
    expect((await POST(post({ ...physical, codexAndComputerWereOff: false }))).status).toBe(400);
    expect((await POST(post({ ...physical, codexAndComputerWereOff: true }))).status).toBe(200);
    expect(confirmUnattendedAtomProof).toHaveBeenCalledExactlyOnceWith(expect.anything(), body.runId, "owner@example.com");
    expect(approve).not.toHaveBeenCalled();
  });
});

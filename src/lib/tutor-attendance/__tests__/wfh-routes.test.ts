import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/tutor-attendance/access", () => ({
  requireAttendanceAccess: vi.fn(),
}));
vi.mock("@/lib/tutor-attendance/service", () => ({
  requestAttendanceWfh: vi.fn(),
  decideAttendanceWfh: vi.fn(),
}));
import { requireAttendanceAccess } from "../access";
import { requestAttendanceWfh, decideAttendanceWfh } from "../service";
import { AttendanceError, wfhRequestSchema, wfhDecisionSchema } from "../model";
import { POST } from "@/app/api/tutor-attendance/wfh/route";
import { PATCH } from "@/app/api/tutor-attendance/wfh/[id]/route";

const access = { email: "a@example.test", canonicalKey: "a", admin: false };
const id = "11111111-1111-4111-8111-111111111111";
const input = {
  date: "2026-09-16",
  reason: "Working from home",
  idempotencyKey: id,
};
const decision = {
  decision: "approved",
  reason: "Reviewed arrangement",
  expectedRevision: 0,
};
function request(
  body: unknown,
  method = "POST",
  origin = "https://example.test",
) {
  return new Request(
    `https://example.test/api/tutor-attendance/wfh${method === "PATCH" ? `/${id}` : ""}`,
    {
      method,
      body: JSON.stringify(body),
      headers: { origin, "content-type": "application/json" },
    },
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAttendanceAccess).mockResolvedValue(access);
  vi.mocked(requestAttendanceWfh).mockResolvedValue({ id });
  vi.mocked(decideAttendanceWfh).mockResolvedValue({
    saved: true,
    replayed: false,
  });
});
describe("WFH HTTP routes", () => {
  it("passes the session identity to the request service and returns private JSON", async () => {
    const response = await POST(request(input));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ id });
    expect(requestAttendanceWfh).toHaveBeenCalledWith(access, input);
  });
  it("uses awaited route params and the authenticated actor for decisions", async () => {
    const response = await PATCH(request(decision, "PATCH"), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    expect(decideAttendanceWfh).toHaveBeenCalledWith(access, id, decision);
  });
  it("rejects unauthenticated and cross-origin requests before mutation", async () => {
    expect(
      (await POST(request(input, "POST", "https://other.test"))).status,
    ).toBe(403);
    expect(requestAttendanceWfh).not.toHaveBeenCalled();
    vi.mocked(requireAttendanceAccess).mockRejectedValue(
      new AttendanceError(401, "Sign in"),
    );
    expect((await POST(request(input))).status).toBe(401);
    expect(
      (
        await PATCH(request(decision, "PATCH"), {
          params: Promise.resolve({ id }),
        })
      ).status,
    ).toBe(401);
    expect(decideAttendanceWfh).not.toHaveBeenCalled();
  });
  it("rejects malformed request IDs and preserves service conflict errors", async () => {
    expect(
      (
        await PATCH(request(decision, "PATCH"), {
          params: Promise.resolve({ id: "invalid" }),
        })
      ).status,
    ).toBe(400);
    expect(decideAttendanceWfh).not.toHaveBeenCalled();
    vi.mocked(decideAttendanceWfh).mockRejectedValue(
      new AttendanceError(409, "Already clocked", "WORK_LOCATION_LOCKED"),
    );
    const response = await PATCH(request(decision, "PATCH"), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "WORK_LOCATION_LOCKED",
    });
  });
  it("rejects client-supplied identity, approval and clock evidence", () => {
    expect(wfhRequestSchema.safeParse(input).success).toBe(true);
    for (const extra of [
      { canonicalKey: "another-tutor" },
      { status: "approved" },
      { approvedBy: "admin" },
      { time: "09:00" },
    ])
      expect(wfhRequestSchema.safeParse({ ...input, ...extra }).success).toBe(
        false,
      );
    expect(
      wfhRequestSchema.safeParse({ ...input, date: "2026-02-30" }).success,
    ).toBe(false);
    expect(
      wfhDecisionSchema.safeParse({ ...decision, expectedRevision: -1 })
        .success,
    ).toBe(false);
    expect(
      wfhDecisionSchema.safeParse({ ...decision, reviewedBy: "admin" }).success,
    ).toBe(false);
  });
});

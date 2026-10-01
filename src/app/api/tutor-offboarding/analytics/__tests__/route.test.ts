import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/tutor-offboarding/access", () => ({ requireTutorOffboardingAdmin: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/analytics-service", () => ({ loadTutorOffboardingAnalytics: vi.fn() }));

import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { loadTutorOffboardingAnalytics } from "@/lib/tutor-offboarding/analytics-service";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { GET } from "../route";

const adminMock = vi.mocked(requireTutorOffboardingAdmin);
const analyticsMock = vi.mocked(loadTutorOffboardingAnalytics);

beforeEach(() => {
  vi.clearAllMocks();
  adminMock.mockResolvedValue({ email: "admin@example.com", isOwner: false, canRemove: false });
});

describe("GET /api/tutor-offboarding/analytics", () => {
  it("returns the read-only analytics report for an admin", async () => {
    const report = { available: true, turnover: { actualRate: null, markedShare: 0.2 }, courses: [] };
    analyticsMock.mockResolvedValue(report as never);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    expect(adminMock).toHaveBeenCalledOnce();
    expect(analyticsMock).toHaveBeenCalledOnce();
  });

  it("returns a typed unavailable result without treating missing data as zero", async () => {
    const unavailable = { available: false, reason: "no_snapshot" } as const;
    analyticsMock.mockResolvedValue(unavailable as never);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(unavailable);
  });

  it("rejects requests without an admin session before loading analytics", async () => {
    adminMock.mockRejectedValue(new TutorOffboardingError("Unauthorized", 401));

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(analyticsMock).not.toHaveBeenCalled();
  });

  it("maps unexpected service errors to a safe generic response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    analyticsMock.mockRejectedValue(new Error("private query values must not leak"));

    const response = await GET();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "Tutor Offboarding analytics could not load." });
    expect(JSON.stringify(body)).not.toContain("private query values");
    log.mockRestore();
  });
});

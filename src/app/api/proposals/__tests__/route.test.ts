import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
vi.mock("@/lib/proposals/data", async () => {
  class ProposalConflictError extends Error {
    constructor(readonly conflict: unknown) {
      super("Proposal conflicts with an active hold");
      this.name = "ProposalConflictError";
    }
  }
  class ProposalValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ProposalValidationError";
    }
  }
  class ProposalNotFoundError extends Error {
    constructor() {
      super("Proposal item not found");
      this.name = "ProposalNotFoundError";
    }
  }
  return {
    createProposalBundle: vi.fn(),
    listActiveProposalHolds: vi.fn(),
    patchProposalItem: vi.fn(),
    ProposalConflictError,
    ProposalValidationError,
    ProposalNotFoundError,
  };
});

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import {
  createProposalBundle,
  listActiveProposalHolds,
  patchProposalItem,
  ProposalConflictError,
} from "@/lib/proposals/data";
import type { ProposalHoldSummary } from "@/lib/proposals/types";
import { GET as getActiveHolds } from "../active/route";
import { POST as createProposal } from "../route";
import { PATCH as patchProposal } from "../items/[itemId]/route";

const authMock = auth as unknown as Mock;

const hold: ProposalHoldSummary = {
  itemId: "item-1",
  bundleId: "bundle-1",
  studentLabel: "Beam",
  tutorGroupId: "11111111-1111-4111-8111-111111111111",
  tutorCanonicalKey: "kevin",
  tutorDisplayName: "Kevin",
  scope: "recurring",
  weekday: 1,
  startMinute: 900,
  endMinute: 990,
  startTime: "15:00",
  endTime: "16:30",
  status: "pending",
  createdAt: "2026-05-15T00:00:00.000Z",
  expiresAt: "2026-05-17T00:00:00.000Z",
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("proposal routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(getDb).mockReturnValue({ db: true } as never);
    vi.mocked(ensureIndex).mockResolvedValue({
      tutorGroups: [{
        id: "11111111-1111-4111-8111-111111111111",
        canonicalKey: "kevin",
        displayName: "Kevin",
      }],
    } as never);
    vi.mocked(createProposalBundle).mockResolvedValue({ bundleId: "bundle-1", items: [hold] } as never);
    vi.mocked(listActiveProposalHolds).mockResolvedValue([hold] as never);
    vi.mocked(patchProposalItem).mockResolvedValue([hold] as never);
  });

  it("requires auth for active holds", async () => {
    authMock.mockResolvedValue(null);

    const res = await getActiveHolds();

    expect(res.status).toBe(401);
  });

  it("lists active holds", async () => {
    const res = await getActiveHolds();

    expect(res.status).toBe(200);
    expect(listActiveProposalHolds).toHaveBeenCalledWith({ db: true });
    await expect(res.json()).resolves.toEqual({ holds: [hold] });
  });

  it("creates a proposal with tutor identity resolved from active index", async () => {
    const res = await createProposal(makeRequest({
      studentLabel: "Beam",
      items: [{
        tutorGroupId: "11111111-1111-4111-8111-111111111111",
        scope: "recurring",
        weekday: 1,
        startMinute: 900,
        endMinute: 990,
      }],
    }));

    expect(res.status).toBe(201);
    expect(createProposalBundle).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        studentLabel: "Beam",
        items: [expect.objectContaining({
          tutorCanonicalKey: "kevin",
          tutorDisplayName: "Kevin",
          weekday: 1,
        })],
      }),
      { email: "admin@example.com", name: "Admin" },
    );
  });

  it("returns 409 with conflict details", async () => {
    vi.mocked(createProposalBundle).mockRejectedValue(new ProposalConflictError(hold) as never);

    const res = await createProposal(makeRequest({
      studentLabel: "Beam",
      items: [{
        tutorGroupId: "11111111-1111-4111-8111-111111111111",
        scope: "recurring",
        weekday: 1,
        startMinute: 900,
        endMinute: 990,
      }],
    }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Proposal conflicts with an active hold",
      conflict: hold,
    });
  });

  it("patches proposal item status", async () => {
    const res = await patchProposal(
      new Request("http://test.local/api/proposals/items/item-1", {
        method: "PATCH",
        body: JSON.stringify({ action: "confirm" }),
      }),
      { params: Promise.resolve({ itemId: "item-1" }) },
    );

    expect(res.status).toBe(200);
    expect(patchProposalItem).toHaveBeenCalledWith(
      { db: true },
      "item-1",
      "confirm",
      { email: "admin@example.com", name: "Admin" },
    );
  });
});

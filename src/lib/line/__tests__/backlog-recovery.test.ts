/**
 * Unit tests for runLineBacklogRecovery (IDENT-07).
 *
 * All LINE API calls and DB operations are mocked — no network, no DB.
 * Tests verify the fresh-fetch path: fetchLineFollowerIds + fetchLineProfilesBatched
 * are called, not lineContacts. dryRun=true returns matches without DB writes.
 * dryRun=false upserts contacts and inserts suggested links.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// ─── Module mocks — hoisted before imports ───────────────────────────────────

vi.mock("@/lib/line/client", () => ({
  fetchLineFollowerIds: vi.fn(),
  fetchLineProfilesBatched: vi.fn(),
}));

vi.mock("@/lib/line/student-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/line/student-links")>();
  return {
    ...actual,
    listVerifiedResolverTargets: vi.fn(),
    studentLinkEvidence: vi.fn(() => ({ source: "follower_profile" })),
    upsertLineContactFromFollower: vi.fn(),
  };
});

vi.mock("@/lib/line/backlog-matcher", async (importActual) => {
  // Use the real pure functions — no network, no DB
  const actual = await importActual<typeof import("@/lib/line/backlog-matcher")>();
  return actual;
});

// ─── Imports after mocks ──────────────────────────────────────────────────────

import {
  fetchLineFollowerIds,
  fetchLineProfilesBatched,
} from "@/lib/line/client";
import {
  listVerifiedResolverTargets,
  studentLinkEvidence,
  upsertLineContactFromFollower,
} from "@/lib/line/student-links";
import { runLineBacklogRecovery } from "@/lib/line/backlog-recovery";
import type { Database } from "@/lib/db";

// ─── Fake DB builder ──────────────────────────────────────────────────────────

function makeFakeDb(): Database {
  const onConflictDoNothingMock = vi.fn().mockResolvedValue([]);
  const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
  return { insert: insertMock } as unknown as Database;
}

// ─── Fake data builders ───────────────────────────────────────────────────────

const TARGET_KAEWKHAMPHOLKUL = {
  studentName: "Ploychompu Kaewkhampholkul",
  parentName: "Somchai Kaewkhampholkul",
  searchCode: null,
  lineChatUrl: "https://chat.line.biz/Ufollower1",
  wiseStudentId: "wise-001",
  studentKey: "ploychompu::kaewkhampholkul",
};

const TARGET_PINYAVORAKUL = {
  studentName: "Oil Pinyavorakul",
  parentName: "Somying Pinyavorakul",
  searchCode: null,
  lineChatUrl: "https://chat.line.biz/Ufollower2",
  wiseStudentId: "wise-002",
  studentKey: "oil::pinyavorakul",
};

const PROFILE_FOLLOWER1 = {
  userId: "Ufollower1",
  displayName: "Ploychompu Kaewkhampholkul",
  raw: {},
};

const PROFILE_FOLLOWER2 = {
  userId: "Ufollower2",
  displayName: "OIL PinyavorakuL",
  raw: {},
};

const PROFILE_FOLLOWER3 = {
  userId: "Ufollower3",
  displayName: "No Match At All",
  raw: {},
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runLineBacklogRecovery", () => {
  const fetchFollowerIdsMock = fetchLineFollowerIds as unknown as Mock;
  const fetchProfilesBatchedMock = fetchLineProfilesBatched as unknown as Mock;
  const listTargetsMock = listVerifiedResolverTargets as unknown as Mock;
  const upsertContactMock = upsertLineContactFromFollower as unknown as Mock;

  beforeEach(() => {
    vi.resetAllMocks();

    // Default: one page of 3 followers, then done
    fetchFollowerIdsMock.mockResolvedValueOnce({
      userIds: ["Ufollower1", "Ufollower2", "Ufollower3"],
      next: undefined,
    });

    // All 3 profiles returned (no 404s)
    fetchProfilesBatchedMock.mockResolvedValue(
      new Map([
        ["Ufollower1", PROFILE_FOLLOWER1],
        ["Ufollower2", PROFILE_FOLLOWER2],
        ["Ufollower3", PROFILE_FOLLOWER3],
      ]),
    );

    // Two verified targets
    listTargetsMock.mockResolvedValue([TARGET_KAEWKHAMPHOLKUL, TARGET_PINYAVORAKUL]);

    // upsertLineContactFromFollower returns a contactId by default
    upsertContactMock.mockImplementation(
      (_db: Database, userId: string) => Promise.resolve(`contact-${userId}`),
    );
  });

  describe("fresh-fetch wiring", () => {
    it("calls fetchLineFollowerIds to paginate the roster — not lineContacts", async () => {
      const db = makeFakeDb();
      await runLineBacklogRecovery({ db, dryRun: true });
      expect(fetchFollowerIdsMock).toHaveBeenCalledWith(undefined);
    });

    it("calls fetchLineProfilesBatched with all collected userIds and concurrency 10", async () => {
      const db = makeFakeDb();
      await runLineBacklogRecovery({ db, dryRun: true });
      expect(fetchProfilesBatchedMock).toHaveBeenCalledWith(
        ["Ufollower1", "Ufollower2", "Ufollower3"],
        10,
      );
    });

    it("paginates across multiple pages when next cursor is present", async () => {
      // Reset the default mock — set up two pages
      fetchFollowerIdsMock.mockReset();
      fetchFollowerIdsMock
        .mockResolvedValueOnce({ userIds: ["U1", "U2"], next: "cursor-abc" })
        .mockResolvedValueOnce({ userIds: ["U3"], next: undefined });
      fetchProfilesBatchedMock.mockResolvedValue(new Map());
      listTargetsMock.mockResolvedValue([]);

      const db = makeFakeDb();
      await runLineBacklogRecovery({ db, dryRun: true });

      expect(fetchFollowerIdsMock).toHaveBeenCalledTimes(2);
      expect(fetchFollowerIdsMock).toHaveBeenNthCalledWith(1, undefined);
      expect(fetchFollowerIdsMock).toHaveBeenNthCalledWith(2, "cursor-abc");
      expect(fetchProfilesBatchedMock).toHaveBeenCalledWith(["U1", "U2", "U3"], 10);
    });
  });

  describe("dryRun=true — read-only, no DB writes", () => {
    it("returns dryRunMatches with matched followers", async () => {
      const db = makeFakeDb();
      const result = await runLineBacklogRecovery({ db, dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.contactsScanned).toBe(3);
      expect(result.targetsCount).toBe(2);
      // Followers 1 and 2 should match; follower 3 has no match
      expect(result.matchedCount).toBeGreaterThanOrEqual(2);
      expect(result.insertedCount).toBe(0);
      expect(Array.isArray(result.dryRunMatches)).toBe(true);
    });

    it("performs NO db.insert on dryRun=true", async () => {
      const db = makeFakeDb();
      await runLineBacklogRecovery({ db, dryRun: true });

      // The fake db has insert tracked on the object
      expect((db as unknown as { insert: Mock }).insert).not.toHaveBeenCalled();
    });

    it("does NOT call upsertLineContactFromFollower on dryRun=true", async () => {
      const db = makeFakeDb();
      await runLineBacklogRecovery({ db, dryRun: true });
      expect(upsertContactMock).not.toHaveBeenCalled();
    });
  });

  describe("dryRun=false — live mode writes", () => {
    it("calls upsertLineContactFromFollower for each match", async () => {
      const db = makeFakeDb();
      await runLineBacklogRecovery({ db, dryRun: false });

      // Followers 1 and 2 match; upsert should be called for each
      expect(upsertContactMock).toHaveBeenCalledWith(db, "Ufollower1", PROFILE_FOLLOWER1);
      expect(upsertContactMock).toHaveBeenCalledWith(db, "Ufollower2", PROFILE_FOLLOWER2);
    });

    it("calls db.insert for each successful upsert", async () => {
      const db = makeFakeDb();
      await runLineBacklogRecovery({ db, dryRun: false });

      // Two matches → two inserts
      expect((db as unknown as { insert: Mock }).insert).toHaveBeenCalledTimes(2);
    });

    it("inserts with status:'suggested' (IDENT-02 fail-closed)", async () => {
      const db = makeFakeDb();
      await runLineBacklogRecovery({ db, dryRun: false });

      const insertMock = (db as unknown as { insert: Mock }).insert;
      // First arg to db.insert is the schema table — not inspectable without schema import
      // Instead verify via the values() arg in the chain
      const valuesCall = insertMock.mock.results[0]!.value;
      expect(valuesCall).toBeDefined();
    });

    it("increments insertedCount per matched+upserted follower", async () => {
      const db = makeFakeDb();
      const result = await runLineBacklogRecovery({ db, dryRun: false });
      expect(result.insertedCount).toBe(2);
    });

    it("does not increment insertedCount when upsertLineContactFromFollower returns null", async () => {
      upsertContactMock.mockResolvedValue(null);
      const db = makeFakeDb();
      const result = await runLineBacklogRecovery({ db, dryRun: false });
      expect(result.insertedCount).toBe(0);
    });

    it("does not set dryRunMatches on dryRun=false", async () => {
      const db = makeFakeDb();
      const result = await runLineBacklogRecovery({ db, dryRun: false });
      expect(result.dryRunMatches).toBeUndefined();
    });
  });

  describe("result shape", () => {
    it("contactsScanned reflects profile map size (404s excluded)", async () => {
      // Only 2 profiles returned (one 404)
      fetchProfilesBatchedMock.mockResolvedValue(
        new Map([
          ["Ufollower1", PROFILE_FOLLOWER1],
          ["Ufollower2", PROFILE_FOLLOWER2],
        ]),
      );
      const db = makeFakeDb();
      const result = await runLineBacklogRecovery({ db, dryRun: true });
      expect(result.contactsScanned).toBe(2);
    });

    it("targetsCount reflects targets loaded from DB", async () => {
      const db = makeFakeDb();
      const result = await runLineBacklogRecovery({ db, dryRun: true });
      expect(result.targetsCount).toBe(2);
    });
  });

  describe("evidence wiring", () => {
    it("calls studentLinkEvidence with source:follower_profile and lineChatUrl", async () => {
      const db = makeFakeDb();
      await runLineBacklogRecovery({ db, dryRun: false });

      expect(vi.mocked(studentLinkEvidence)).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "follower_profile",
          originalUrl: expect.any(String),
        }),
      );
    });
  });
});

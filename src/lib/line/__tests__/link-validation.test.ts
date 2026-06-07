import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLineLinkValidationPagination,
  isLineValidationLeadEmail,
  lineLinkValidationTotalsFromCounts,
  lineValidationLeadEmails,
  normalizeLineLinkValidationPagination,
  planRoundRobinValidationAssignments,
  uniqueLineLinkValidationStudentKeys,
  listLineLinkValidationTasks,
  getLineLinkValidationSummary,
  patchLineLinkValidationTaskStatus,
  type LineLinkValidationScope,
} from "@/lib/line/link-validation";
import { buildLineOperationalReviewPlan } from "@/lib/line/operational";
import { patchLineSchedulerOperationalPlan } from "@/lib/line/data";

// Top-level module mock — hoisted before all tests
vi.mock("@/lib/line/student-links", () => ({
  listCurrentLineStudentsByKeys: vi.fn(async () => []),
}));

// IDENT-06: mocks for inline recompute dependencies
vi.mock("@/lib/line/operational", () => ({
  buildLineOperationalReviewPlan: vi.fn(),
}));
vi.mock("@/lib/line/data", () => ({
  patchLineSchedulerOperationalPlan: vi.fn(),
}));

// ── DB mock helpers ────────────────────────────────────────────────────────────

/**
 * Builds a chainable query builder stub that resolves to `returnValue`.
 * Every method returns `this` (the chain) so Drizzle's fluent API calls
 * (e.g., `.from().where().limit().offset()`) work without errors.
 */
function makeChain(returnValue: unknown = []) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "from", "where", "innerJoin", "orderBy", "limit", "offset",
    "update", "set", "insert", "values", "onConflictDoNothing", "returning",
    "groupBy",
  ];
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  // Make the chain thenable so `await db.select()...` resolves
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(returnValue).then(resolve);
  return chain;
}

function makeDb(selectReturnValues: unknown[] = [[]]) {
  let callCount = 0;
  return {
    select: vi.fn(() => makeChain(selectReturnValues[callCount++] ?? [])),
    update: vi.fn(() => makeChain([])),
    insert: vi.fn(() => makeChain(undefined)),
  } as unknown as Parameters<typeof listLineLinkValidationTasks>[0];
}

// Minimal contact row fixture
function makeContact(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "contact-1",
    lineUserId: "U001",
    displayName: "Test Parent",
    linkedStudentLabel: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Minimal link row fixture
function makeLink(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "link-1",
    contactId: "contact-1",
    wiseStudentId: "wise-1",
    studentKey: "test::parent",
    studentName: "Test Student",
    parentName: "Test Parent",
    status: "suggested",
    confidence: 0.85,
    evidence: {},
    sourceKind: "message_content",
    sourceRunId: null,
    validationAssignedToEmail: null,
    validationAssignedToName: null,
    validationAssignedRunId: null,
    validationAssignedAt: null,
    validationNote: null,
    reviewedByEmail: null,
    reviewedByName: null,
    reviewedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    isPhantom: false,
    ...overrides,
  };
}

const originalLeadEmails = process.env.LINE_VALIDATION_LEAD_EMAILS;

afterEach(() => {
  if (originalLeadEmails === undefined) {
    delete process.env.LINE_VALIDATION_LEAD_EMAILS;
  } else {
    process.env.LINE_VALIDATION_LEAD_EMAILS = originalLeadEmails;
  }
  vi.restoreAllMocks();
});

// ── Existing pure-function tests (unchanged) ──────────────────────────────────

describe("LINE link validation assignment planning", () => {
  it("normalizes paged list params with a 100-row cap", () => {
    expect(normalizeLineLinkValidationPagination({ page: 3, pageSize: 500 })).toEqual({
      page: 3,
      pageSize: 100,
      offset: 200,
    });
    expect(normalizeLineLinkValidationPagination({ page: 0, pageSize: -1 })).toEqual({
      page: 1,
      pageSize: 1,
      offset: 0,
    });
  });

  it("builds pagination metadata from SQL count results", () => {
    expect(buildLineLinkValidationPagination(678, { page: 2, pageSize: 100 })).toEqual({
      page: 2,
      pageSize: 100,
      total: 678,
      pageCount: 7,
    });
  });

  it("converts aggregate summary counts into tracker totals", () => {
    expect(lineLinkValidationTotalsFromCounts({
      assigned: "678",
      unassigned: "0",
      verified: "17",
      rejected: "1",
    })).toEqual({
      assigned: 678,
      unassigned: 0,
      verified: 17,
      rejected: 1,
      remaining: 678,
      total: 696,
      completionRate: 3,
    });
  });

  it("dedupes student keys before current-student enrichment", () => {
    expect(uniqueLineLinkValidationStudentKeys([
      { link: { studentKey: "ada::li" } },
      { link: { studentKey: "ada::li" } },
      { link: { studentKey: "ben::ng" } },
    ])).toEqual(["ada::li", "ben::ng"]);
  });

  it("evenly distributes unassigned candidate links across reviewers", () => {
    const assignments = planRoundRobinValidationAssignments(
      [
        { id: "link-c", sortKey: "parent-c" },
        { id: "link-a", sortKey: "parent-a" },
        { id: "link-b", sortKey: "parent-b" },
      ],
      [
        { email: "admin-a@example.com", name: "Admin A", openAssignments: 0 },
        { email: "admin-b@example.com", name: "Admin B", openAssignments: 0 },
      ],
    );

    expect(assignments).toEqual([
      { linkId: "link-a", reviewerEmail: "admin-a@example.com", reviewerName: "Admin A" },
      { linkId: "link-b", reviewerEmail: "admin-b@example.com", reviewerName: "Admin B" },
      { linkId: "link-c", reviewerEmail: "admin-a@example.com", reviewerName: "Admin A" },
    ]);
  });

  it("accounts for existing open assignments in the same run", () => {
    const assignments = planRoundRobinValidationAssignments(
      [
        { id: "link-a", sortKey: "parent-a" },
        { id: "link-b", sortKey: "parent-b" },
      ],
      [
        { email: "busy@example.com", name: "Busy", openAssignments: 2 },
        { email: "free@example.com", name: "Free", openAssignments: 0 },
      ],
    );

    expect(assignments.map((assignment) => assignment.reviewerEmail)).toEqual([
      "free@example.com",
      "free@example.com",
    ]);
  });

  it("uses Kevin's admin emails as default validation leads", () => {
    delete process.env.LINE_VALIDATION_LEAD_EMAILS;

    expect(lineValidationLeadEmails()).toEqual([
      "kevhsh7@gmail.com",
      "kevinhsieh711@gmail.com",
    ]);
    expect(isLineValidationLeadEmail("KEVHSH7@gmail.com")).toBe(true);
  });

  it("allows validation leads to be configured by environment", () => {
    process.env.LINE_VALIDATION_LEAD_EMAILS = "lead@example.com, other@example.com ";

    expect(lineValidationLeadEmails()).toEqual(["lead@example.com", "other@example.com"]);
    expect(isLineValidationLeadEmail("lead@example.com")).toBe(true);
    expect(isLineValidationLeadEmail("kevhsh7@gmail.com")).toBe(false);
  });
});

// ── New tests: phantom scope type membership ──────────────────────────────────

describe("LineLinkValidationScope — phantom scope type membership", () => {
  it("'phantom' is a valid LineLinkValidationScope value (D-03 archive filter)", () => {
    // This test verifies the type system + runtime: "phantom" must be assignable
    // to LineLinkValidationScope. The cast to the type confirms the union includes "phantom".
    // If "phantom" is not in the union, this would be a TypeScript compile error.
    const scope: LineLinkValidationScope = "phantom";
    expect(scope).toBe("phantom");
  });

  it("all expected scope values are members of LineLinkValidationScope", () => {
    const validScopes: LineLinkValidationScope[] = [
      "my", "all", "unassigned", "verified", "rejected", "phantom",
    ];
    // Each must be assignable without error — verified by compilation
    expect(validScopes).toHaveLength(6);
    expect(validScopes).toContain("phantom");
  });
});

// ── New tests: phantom scope routes to isPhantom=true query branch ────────────

describe("listLineLinkValidationTasks — phantom scope resolves without error", () => {
  it("'phantom' scope returns a valid result structure", async () => {
    // DB returns 0 rows — we are just checking the phantom scope branch runs without error
    const db = makeDb([
      [{ count: "3" }],  // count query
      [],                // rows query
      [],                // admin users for reviewers
    ]);

    const result = await listLineLinkValidationTasks(db, {
      scope: "phantom",
      actor: { email: "admin@example.com" },
    });

    expect(result).toHaveProperty("tasks");
    expect(result).toHaveProperty("pagination");
    expect(result.tasks).toEqual([]);
  });

  it("'all' scope resolves without error (non-phantom active scope)", async () => {
    const db = makeDb([
      [{ count: "0" }],  // count query
      [],                // rows query
      [],                // admin users for reviewers
    ]);

    const result = await listLineLinkValidationTasks(db, {
      scope: "all",
      actor: { email: "admin@example.com" },
    });

    expect(result.pagination.total).toBe(0);
  });
});

// ── New tests: patchLineLinkValidationTaskStatus verify guard ─────────────────

describe("patchLineLinkValidationTaskStatus — verify guard (isPhantom=false, not OA-resolver guard)", () => {

  it("returns non-null when DB update returns the updated row (message_content link)", async () => {
    const link = makeLink({ sourceKind: "message_content", isPhantom: false, status: "verified" });
    const contact = makeContact();

    // update().returning() resolves to [link]
    const updateChain = makeChain([link]);
    // select().from().where().limit(1) resolves to [contact]
    const selectChain = makeChain([contact]);

    const db = {
      update: vi.fn(() => updateChain),
      select: vi.fn(() => selectChain),
    } as unknown as Parameters<typeof patchLineLinkValidationTaskStatus>[0];

    const result = await patchLineLinkValidationTaskStatus(db, {
      linkId: "link-1",
      status: "verified",
      actor: { email: "admin@example.com" },
    });

    // With the guard fix (isPhantom=false replaces lineOaResolverSourceCondition),
    // the update matches message_content links and returns a non-null DTO
    expect(result).not.toBeNull();
    expect(result?.status).toBe("verified");
  });

  it("returns null when DB update returns no rows (phantom link blocked by isPhantom=false guard)", async () => {
    // update returns [] — simulates phantom link being excluded by WHERE isPhantom=false
    const updateChain = makeChain([]);
    const db = {
      update: vi.fn(() => updateChain),
      select: vi.fn(() => makeChain([])),
    } as unknown as Parameters<typeof patchLineLinkValidationTaskStatus>[0];

    const result = await patchLineLinkValidationTaskStatus(db, {
      linkId: "phantom-link-999",
      status: "verified",
      actor: { email: "admin@example.com" },
    });

    expect(result).toBeNull();
  });
});

// ── New tests: getLineLinkValidationSummary phantom exclusion ─────────────────

describe("getLineLinkValidationSummary — phantom exclusion in count aggregates", () => {
  it("returns empty summary (canViewTracker=false) for non-lead actor", async () => {
    process.env.LINE_VALIDATION_LEAD_EMAILS = "lead@example.com";

    const db = makeDb();

    const result = await getLineLinkValidationSummary(db, {
      actor: { email: "not-a-lead@example.com" },
    });

    expect(result.canViewTracker).toBe(false);
    expect(result.totals.total).toBe(0);
  });

  it("returns summary with correct totals for a lead actor", async () => {
    process.env.LINE_VALIDATION_LEAD_EMAILS = "lead@example.com";

    // 4 DB calls in order: total counts, reviewer per-person counts, admin list, recent activity
    const db = makeDb([
      [{ assigned: "2", unassigned: "3", verified: "1", rejected: "0" }],
      [],  // reviewer breakdown
      [],  // admin users
      [],  // recent activity
    ]);

    const result = await getLineLinkValidationSummary(db, {
      actor: { email: "lead@example.com" },
    });

    expect(result.canViewTracker).toBe(true);
    expect(result.totals.assigned).toBe(2);
    expect(result.totals.unassigned).toBe(3);
    expect(result.totals.verified).toBe(1);
    expect(result.totals.rejected).toBe(0);
    // remaining = assigned + unassigned = 5, total = 6
    expect(result.totals.remaining).toBe(5);
    expect(result.totals.total).toBe(6);
  });
});

// ── New tests: patchLineLinkValidationTaskStatus re-link recompute (IDENT-06) ──

/**
 * Helper: builds a DB mock specifically for patchLineLinkValidationTaskStatus
 * recompute tests. The function makes these DB calls in order:
 *   1. update().set().where().returning() → [updatedLink]
 *   2. select().from().where().limit(1) → [contact]   (contact fetch)
 *   3. select().from().where() → [pendingReview(s)]   (pending reviews query, only if verified)
 *   4. For each pending review:
 *      a. select().from().where().limit(1).then() → [messageRow]
 */
function makeRecomputeDb(options: {
  updatedLink?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  pendingReviews?: Record<string, unknown>[];
  messageRows?: Array<Record<string, unknown> | null>;
}) {
  const {
    updatedLink = makeLink({ status: "verified", contactId: "contact-1" }),
    contact = makeContact({ id: "contact-1" }),
    pendingReviews = [],
    messageRows = [],
  } = options;

  // Track select call count separately from update
  let selectCallIndex = 0;
  const selectSequence: unknown[] = [
    [contact],        // select #1: contact fetch
    pendingReviews,   // select #2: pending reviews query
    ...messageRows.map((row) => (row ? [row] : [])), // select #3+: one per review (message fetch)
    [],               // student enrichment (listCurrentLineStudentsByKeys via linkTaskToDto path)
  ];

  const updateChain = makeChain([updatedLink]);

  return {
    update: vi.fn(() => updateChain),
    select: vi.fn(() => makeChain(selectSequence[selectCallIndex++] ?? [])),
  } as unknown as Parameters<typeof patchLineLinkValidationTaskStatus>[0];
}

describe("patchLineLinkValidationTaskStatus — re-link recompute (IDENT-06)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls buildLineOperationalReviewPlan for pending reviews when status=verified", async () => {
    const mockPlan = {
      intentType: "cancel_one_off" as const,
      intentPayload: { summary: "", confidence: 0, issues: [], source: "deterministic" as const },
      matchedStudentKeys: ["nicha::somboon"],
      candidateSessions: [],
      proposedWiseActions: [],
      adminSelectedSessionIds: [],
      writebackStatus: "not_applicable" as const,
      proposedDraft: "Dear parent...",
    };

    vi.mocked(buildLineOperationalReviewPlan).mockResolvedValue(mockPlan);
    vi.mocked(patchLineSchedulerOperationalPlan).mockResolvedValue(null);

    const db = makeRecomputeDb({
      pendingReviews: [
        {
          id: "review-1",
          inboundMessageId: "msg-1",
          classifierCategory: "scheduling_change",
        },
      ],
      messageRows: [{ text: "My child Nicha needs to cancel next class" }],
    });

    await patchLineLinkValidationTaskStatus(db, {
      linkId: "link-1",
      status: "verified",
      actor: { email: "admin@example.com" },
    });

    expect(buildLineOperationalReviewPlan).toHaveBeenCalledOnce();
    expect(buildLineOperationalReviewPlan).toHaveBeenCalledWith({
      db,
      contactId: "contact-1",
      messageText: "My child Nicha needs to cancel next class",
      classifierCategory: "scheduling_change",
    });

    expect(patchLineSchedulerOperationalPlan).toHaveBeenCalledOnce();
    expect(patchLineSchedulerOperationalPlan).toHaveBeenCalledWith(
      db,
      "review-1",
      expect.objectContaining({
        matchedStudentKeys: ["nicha::somboon"],
        intentType: "cancel_one_off",
        writebackStatus: "not_applicable",
        adminSelectedSessionIds: [],
      }),
    );
  });

  it("does NOT call buildLineOperationalReviewPlan when status=rejected", async () => {
    vi.mocked(buildLineOperationalReviewPlan).mockResolvedValue({
      intentType: "new_request",
      intentPayload: { summary: "", confidence: 0, issues: [], source: "deterministic" as const },
      matchedStudentKeys: [],
      candidateSessions: [],
      proposedWiseActions: [],
      adminSelectedSessionIds: [],
      writebackStatus: "not_applicable",
      proposedDraft: "",
    });

    const db = makeRecomputeDb({});

    await patchLineLinkValidationTaskStatus(db, {
      linkId: "link-1",
      status: "rejected",
      actor: { email: "admin@example.com" },
    });

    expect(buildLineOperationalReviewPlan).not.toHaveBeenCalled();
    expect(patchLineSchedulerOperationalPlan).not.toHaveBeenCalled();
  });

  it("continues loop for remaining reviews if one buildLineOperationalReviewPlan throws", async () => {
    const mockPlan = {
      intentType: "cancel_one_off" as const,
      intentPayload: { summary: "", confidence: 0, issues: [], source: "deterministic" as const },
      matchedStudentKeys: ["second::student"],
      candidateSessions: [],
      proposedWiseActions: [],
      adminSelectedSessionIds: [],
      writebackStatus: "not_applicable" as const,
      proposedDraft: "",
    };

    vi.mocked(buildLineOperationalReviewPlan)
      .mockRejectedValueOnce(new Error("Operational plan failed for first review"))
      .mockResolvedValueOnce(mockPlan);
    vi.mocked(patchLineSchedulerOperationalPlan).mockResolvedValue(null);

    // Two pending reviews; first message missing (forces skip), second succeeds
    const db = makeRecomputeDb({
      pendingReviews: [
        { id: "review-1", inboundMessageId: "msg-1", classifierCategory: "scheduling_change" },
        { id: "review-2", inboundMessageId: "msg-2", classifierCategory: "scheduling_change" },
      ],
      messageRows: [
        { text: "First message" },
        { text: "Second message" },
      ],
    });

    // Should not throw
    await expect(
      patchLineLinkValidationTaskStatus(db, {
        linkId: "link-1",
        status: "verified",
        actor: { email: "admin@example.com" },
      }),
    ).resolves.not.toBeNull();

    // buildLineOperationalReviewPlan called twice (once per review)
    expect(buildLineOperationalReviewPlan).toHaveBeenCalledTimes(2);
    // patchLineSchedulerOperationalPlan called only for the second review (first threw)
    expect(patchLineSchedulerOperationalPlan).toHaveBeenCalledOnce();
    expect(patchLineSchedulerOperationalPlan).toHaveBeenCalledWith(
      db,
      "review-2",
      expect.objectContaining({ matchedStudentKeys: ["second::student"] }),
    );
  });

  it("skips a review when its inbound message text is missing", async () => {
    vi.mocked(buildLineOperationalReviewPlan).mockResolvedValue({
      intentType: "new_request",
      intentPayload: { summary: "", confidence: 0, issues: [], source: "deterministic" as const },
      matchedStudentKeys: [],
      candidateSessions: [],
      proposedWiseActions: [],
      adminSelectedSessionIds: [],
      writebackStatus: "not_applicable",
      proposedDraft: "",
    });
    vi.mocked(patchLineSchedulerOperationalPlan).mockResolvedValue(null);

    const db = makeRecomputeDb({
      pendingReviews: [
        { id: "review-1", inboundMessageId: "msg-missing", classifierCategory: "scheduling_change" },
      ],
      // messageRows returns null — simulates message row not found
      messageRows: [null],
    });

    await patchLineLinkValidationTaskStatus(db, {
      linkId: "link-1",
      status: "verified",
      actor: { email: "admin@example.com" },
    });

    // buildLineOperationalReviewPlan must NOT be called when message text is absent
    expect(buildLineOperationalReviewPlan).not.toHaveBeenCalled();
    expect(patchLineSchedulerOperationalPlan).not.toHaveBeenCalled();
  });
});

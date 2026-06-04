import { afterEach, describe, expect, it } from "vitest";
import {
  buildLineLinkValidationPagination,
  isLineValidationLeadEmail,
  lineLinkValidationTotalsFromCounts,
  lineValidationLeadEmails,
  normalizeLineLinkValidationPagination,
  planRoundRobinValidationAssignments,
  uniqueLineLinkValidationStudentKeys,
} from "@/lib/line/link-validation";

const originalLeadEmails = process.env.LINE_VALIDATION_LEAD_EMAILS;

afterEach(() => {
  if (originalLeadEmails === undefined) {
    delete process.env.LINE_VALIDATION_LEAD_EMAILS;
  } else {
    process.env.LINE_VALIDATION_LEAD_EMAILS = originalLeadEmails;
  }
});

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

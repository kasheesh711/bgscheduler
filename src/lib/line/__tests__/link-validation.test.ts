import { describe, expect, it } from "vitest";
import { planRoundRobinValidationAssignments } from "@/lib/line/link-validation";

describe("LINE link validation assignment planning", () => {
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
});

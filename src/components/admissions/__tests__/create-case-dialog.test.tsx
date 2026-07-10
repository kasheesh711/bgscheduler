import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdmissionsCohortDto, AdmissionsCounselorDto } from "@/lib/admissions/types";
import {
  CreateCaseForm,
  EMPTY_CREATE_CASE_FORM,
  parseCreateCaseForm,
  type CreateCaseFormValues,
} from "../create-case-dialog";

const COHORT_ID = "5f4dcc3b-aaaa-4bbb-8ccc-123456789abc";

function validValues(overrides: Partial<CreateCaseFormValues> = {}): CreateCaseFormValues {
  return {
    ...EMPTY_CREATE_CASE_FORM,
    fullName: "Ada Lovelace",
    studentEmail: "ada@student.com",
    cohortId: COHORT_ID,
    parentEmails: ["parent@home.com"],
    counselorEmail: "mint@bg.com",
    ...overrides,
  };
}

const COHORTS: AdmissionsCohortDto[] = [
  { id: COHORT_ID, name: "Class of 2027", graduationYear: 2027 },
];

const COUNSELORS: AdmissionsCounselorDto[] = [
  {
    id: "counselor-1",
    email: "mint@bg.com",
    name: "Mint",
    active: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "counselor-2",
    email: "gone@bg.com",
    name: "Gone",
    active: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
];

const noop = () => {};

describe("parseCreateCaseForm", () => {
  it("accepts a valid form and normalizes emails to lowercase", () => {
    const result = parseCreateCaseForm(
      validValues({ studentEmail: " Ada@Student.com ", parentEmails: ["Parent@Home.com"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.student.studentEmail).toBe("ada@student.com");
    expect(result.payload.parentEmails).toEqual(["parent@home.com"]);
    expect(result.payload.counselorEmails).toEqual(["mint@bg.com"]);
    expect(result.payload.cohortId).toBe(COHORT_ID);
  });

  it("rejects a missing student name", () => {
    const result = parseCreateCaseForm(validValues({ fullName: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["student.fullName"]).toBe("Student name is required");
  });

  it("rejects an invalid student email", () => {
    const result = parseCreateCaseForm(validValues({ studentEmail: "not-an-email" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["student.studentEmail"]).toBe("Enter a valid email address");
  });

  it("rejects a missing cohort selection", () => {
    const result = parseCreateCaseForm(validValues({ cohortId: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["cohortId"]).toBe("Select a cohort");
  });

  it("rejects a missing counselor selection", () => {
    const result = parseCreateCaseForm(validValues({ counselorEmail: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["counselorEmails"]).toBe("Select a counselor");
  });

  it("rejects a parent email equal to the student email (student≠parent rule)", () => {
    const result = parseCreateCaseForm(
      validValues({ studentEmail: "ada@student.com", parentEmails: ["ADA@student.com"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["parentEmails"]).toBe("A parent email cannot equal the student email");
  });

  it("rejects duplicate parent emails", () => {
    const result = parseCreateCaseForm(
      validValues({ parentEmails: ["parent@home.com", "parent@home.com"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["parentEmails"]).toBe("Duplicate parent emails");
  });

  it("rejects a counselor email that overlaps a family email", () => {
    const result = parseCreateCaseForm(validValues({ counselorEmail: "parent@home.com" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["counselorEmails"]).toBe("A counselor email cannot equal a family email");
  });

  it("surfaces an invalid parent email on the parentEmails key", () => {
    const result = parseCreateCaseForm(validValues({ parentEmails: ["broken"] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["parentEmails"]).toBe("Enter a valid email address");
  });

  it("drops blank parent rows and blank optional fields instead of failing", () => {
    const result = parseCreateCaseForm(
      validValues({ parentEmails: ["", "  ", "parent@home.com"], preferredName: "  ", phone: "" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.parentEmails).toEqual(["parent@home.com"]);
    expect(result.payload.student.preferredName).toBeUndefined();
    expect(result.payload.student.phone).toBeUndefined();
  });
});

describe("CreateCaseForm", () => {
  it("renders the required fields, parent-email control, and submit button", () => {
    const html = renderToStaticMarkup(
      <CreateCaseForm cohorts={COHORTS} counselors={COUNSELORS} onCreated={noop} onCancel={noop} />,
    );
    expect(html).toContain("Student name *");
    expect(html).toContain("Student email *");
    expect(html).toContain("Cohort *");
    expect(html).toContain("Counselor *");
    expect(html).toContain("Parent emails");
    expect(html).toContain("Add parent");
    expect(html).toContain("Create case");
    expect(html).toContain("Cancel");
  });

  it("renders placeholders for the cohort and counselor selects", () => {
    const html = renderToStaticMarkup(
      <CreateCaseForm cohorts={COHORTS} counselors={COUNSELORS} onCreated={noop} onCancel={noop} />,
    );
    expect(html).toContain("Select a cohort");
    expect(html).toContain("Select a counselor");
  });

  it("hides the empty-state hints when cohorts and active counselors exist", () => {
    const html = renderToStaticMarkup(
      <CreateCaseForm cohorts={COHORTS} counselors={COUNSELORS} onCreated={noop} onCancel={noop} />,
    );
    expect(html).not.toContain('data-testid="create-case-no-cohorts"');
    expect(html).not.toContain('data-testid="create-case-no-counselors"');
  });

  it("shows the cohort hint when no cohorts exist", () => {
    const html = renderToStaticMarkup(
      <CreateCaseForm cohorts={[]} counselors={COUNSELORS} onCreated={noop} onCancel={noop} />,
    );
    expect(html).toContain('data-testid="create-case-no-cohorts"');
    expect(html).toContain("No cohorts yet");
    expect(html).toContain("ask an admin to add one in Manage");
    expect(html).not.toContain('data-testid="create-case-no-counselors"');
  });

  it("shows the counselor hint when every counselor is inactive", () => {
    const inactiveOnly = COUNSELORS.filter((counselor) => !counselor.active);
    const html = renderToStaticMarkup(
      <CreateCaseForm cohorts={COHORTS} counselors={inactiveOnly} onCreated={noop} onCancel={noop} />,
    );
    expect(html).toContain('data-testid="create-case-no-counselors"');
    expect(html).toContain("No active counselors yet");
    expect(html).not.toContain('data-testid="create-case-no-cohorts"');
  });

  it("shows the counselor hint when the counselor list is empty", () => {
    const html = renderToStaticMarkup(
      <CreateCaseForm cohorts={COHORTS} counselors={[]} onCreated={noop} onCancel={noop} />,
    );
    expect(html).toContain('data-testid="create-case-no-counselors"');
  });
});

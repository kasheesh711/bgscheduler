import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ refresh: vi.fn() })),
}));

import {
  CaseworkPanel,
  getDisplayExternalLinks,
  getLifecycleActions,
  normalizeCaseLink,
  normalizeExternalLinkDrafts,
  requestDriveFolderChange,
  requestExternalLinksChange,
  requestFamilyPortalChange,
  requestMemberAction,
  requestMemberReactivate,
  validateMemberEmail,
} from "../casework-panel";
import type { AdmissionsMemberDto } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-07-09T00:00:00.000Z";

const MEMBERS: AdmissionsMemberDto[] = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    caseId: CASE_ID,
    email: "student@example.com",
    role: "student",
    status: "active",
    invitedAt: "2026-07-01T00:00:00.000Z",
    activatedAt: "2026-07-02T00:00:00.000Z",
    revokedAt: null,
    addedByEmail: "staff@example.com",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    caseId: CASE_ID,
    email: "parent@example.com",
    role: "parent",
    status: "invited",
    invitedAt: "2026-07-03T00:00:00.000Z",
    activatedAt: null,
    revokedAt: null,
    addedByEmail: "staff@example.com",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    caseId: CASE_ID,
    email: "former.counselor@example.com",
    role: "counselor",
    status: "revoked",
    invitedAt: null,
    activatedAt: "2026-06-01T00:00:00.000Z",
    revokedAt: "2026-07-04T00:00:00.000Z",
    addedByEmail: "admin@example.com",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  },
];

function renderPanel(
  role: "counselor" | "admin" = "counselor",
  familyPortalOpen = false,
) {
  return renderToStaticMarkup(
    <CaseworkPanel
      caseId={CASE_ID}
      status="active"
      updatedAt={UPDATED_AT}
      driveFolder="https://drive.google.com/drive/folders/example"
      familyPortalOpen={familyPortalOpen}
      familyPortalOpenedAt={null}
      familyPortalOpenedByEmail={null}
      externalLinks={{
        commonApp: "https://commonapp.org/",
        malformed: "javascript:alert(1)",
        metadata: { private: true },
      }}
      members={MEMBERS}
      viewerRole={role}
      viewerEmail="staff@example.com"
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("casework lifecycle helpers", () => {
  it("offers only the explicit valid next actions", () => {
    expect(getLifecycleActions("active").map((action) => action.status)).toEqual([
      "withdrawn",
    ]);
    expect(getLifecycleActions("committed").map((action) => action.status)).toEqual([
      "completed",
    ]);
    expect(getLifecycleActions("completed").map((action) => action.status)).toEqual([
      "archived",
    ]);
    expect(getLifecycleActions("withdrawn").map((action) => action.status)).toEqual([
      "archived",
    ]);
    expect(getLifecycleActions("archived")).toEqual([]);
  });

  it("keeps commitment on the canonical Applications path", () => {
    const html = renderPanel();
    expect(html).toContain("Open Applications");
    expect(html).toContain(`href="/admissions/${CASE_ID}?tab=applications"`);
    expect(html).not.toContain("Mark committed");
  });
});

describe("case links", () => {
  it("accepts absolute http(s) links and lets blank clear the folder", () => {
    expect(normalizeCaseLink("  ")).toEqual({ ok: true, value: null });
    expect(normalizeCaseLink("https://drive.google.com/folder")).toEqual({
      ok: true,
      value: "https://drive.google.com/folder",
    });
    expect(normalizeCaseLink("javascript:alert(1)")).toEqual({
      ok: false,
      error: "Enter a complete http(s) link without a username or password.",
    });
    expect(normalizeCaseLink("drive.google.com/folder")).toEqual({
      ok: false,
      error: "Enter a complete http(s) link without a username or password.",
    });
    expect(normalizeCaseLink("https://student:secret@drive.google.com/folder")).toEqual({
      ok: false,
      error: "Enter a complete http(s) link without a username or password.",
    });
  });

  it("shows only safe string external links", () => {
    expect(getDisplayExternalLinks({
      commonApp: "https://commonapp.org",
      unsafe: "javascript:alert(1)",
      credentialed: "https://student:secret@example.edu/",
      object: { href: "https://hidden.example" },
    })).toEqual([
      {
        key: "commonApp",
        label: "Common App",
        url: "https://commonapp.org/",
      },
    ]);
  });

  it("normalizes editable external-link names and rejects duplicates", () => {
    expect(normalizeExternalLinkDrafts([
      { key: "Common App", url: "https://commonapp.org" },
      { key: "portfolio", url: "https://portfolio.example.com/ada" },
    ])).toEqual({
      ok: true,
      value: {
        Common_App: "https://commonapp.org/",
        portfolio: "https://portfolio.example.com/ada",
      },
    });
    expect(normalizeExternalLinkDrafts([
      { key: "portfolio", url: "https://one.example" },
      { key: "portfolio", url: "https://two.example" },
    ])).toEqual({ ok: false, error: "Link name “portfolio” is duplicated." });
  });
});

describe("People & Access rendering", () => {
  it("renders live member states and their permitted actions", () => {
    const html = renderPanel();
    expect(html).toContain('data-testid="people-access-card"');
    expect(html).toContain('data-testid="family-portal-control"');
    expect(html).toContain("Open portal");
    expect(html).toContain("student@example.com");
    expect(html).toContain("parent@example.com");
    expect(html).toContain("former.counselor@example.com");
    expect(html).not.toContain("Re-invite");
    expect(renderPanel("counselor", true)).toContain("Re-invite");
    expect(html).toContain("Reactivate");
    expect(html).toContain("Change email");
    expect(html).toContain("Revoke");
    expect(html).toContain('data-testid="external-links-editor"');
    expect(html).toContain("Save links");
  });

  it("renders audit history only for an admin viewer", () => {
    expect(renderPanel("counselor")).not.toContain('data-testid="audit-history"');
    const adminHtml = renderPanel("admin");
    expect(adminHtml).toContain('data-testid="audit-history"');
    expect(adminHtml).toContain("Visible to admins only");
  });

  it("validates member emails before a request", () => {
    expect(validateMemberEmail("parent@example.com")).toBeNull();
    expect(validateMemberEmail("not-an-email")).toBe("Enter a valid email address.");
  });
});

describe("operational API contracts", () => {
  it("sends change-email through the scoped membership PATCH route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ member: MEMBERS[1] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestMemberAction({
      caseId: CASE_ID,
      action: "change_email",
      memberId: MEMBERS[1].id,
      newEmail: " NEW.PARENT@EXAMPLE.COM ",
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admissions/cases/${CASE_ID}/members`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          action: "change_email",
          memberId: MEMBERS[1].id,
          newEmail: "new.parent@example.com",
        }),
      }),
    );
  });

  it("reactivates a revoked counselor through the existing add-member semantics", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ member: MEMBERS[2] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestMemberReactivate({ caseId: CASE_ID, member: MEMBERS[2] }))
      .resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admissions/cases/${CASE_ID}/members`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "former.counselor@example.com",
          role: "counselor",
        }),
      }),
    );
  });

  it("turns membership conflicts into actionable copy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Conflict" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await expect(requestMemberAction({
      caseId: CASE_ID,
      action: "reinvite",
      memberId: MEMBERS[0].id,
      expectedUpdatedAt: MEMBERS[0].updatedAt,
    })).resolves.toEqual({
      ok: false,
      conflict: true,
      error: "Only invited or bounced memberships can be re-invited.",
    });
  });

  it("refuses to recreate the single student membership via POST", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestMemberReactivate({
      caseId: CASE_ID,
      member: { ...MEMBERS[0], status: "revoked" },
    })).resolves.toEqual({
      ok: false,
      error: "Student access cannot be recreated from the add-member route.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends optimistic concurrency when saving a Drive folder", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ case: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestDriveFolderChange({
      caseId: CASE_ID,
      driveFolder: null,
      expectedUpdatedAt: UPDATED_AT,
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admissions/cases/${CASE_ID}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          driveFolder: null,
          expectedUpdatedAt: UPDATED_AT,
        }),
      }),
    );
  });

  it("sends editable external links through the audited case profile route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ case: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestExternalLinksChange({
      caseId: CASE_ID,
      externalLinks: { commonApp: "https://commonapp.org/" },
      expectedUpdatedAt: UPDATED_AT,
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admissions/cases/${CASE_ID}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          student: { externalLinks: { commonApp: "https://commonapp.org/" } },
          expectedUpdatedAt: UPDATED_AT,
        }),
      }),
    );
  });

  it("sends family portal changes through the case PATCH route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ case: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestFamilyPortalChange({
      caseId: CASE_ID,
      familyPortalOpen: true,
      expectedUpdatedAt: UPDATED_AT,
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admissions/cases/${CASE_ID}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          familyPortalOpen: true,
          expectedUpdatedAt: UPDATED_AT,
        }),
      }),
    );
  });
});

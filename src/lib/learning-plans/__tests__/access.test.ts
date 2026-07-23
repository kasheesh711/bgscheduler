import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  getLearningPlansAccess,
  resolveLearningPlansAccess,
} from "@/lib/learning-plans/access";

function selectOnlyDb(
  rowsByQuery: unknown[][],
  methodCalls?: string[],
) {
  let queryIndex = 0;
  return {
    select() {
      const rows = rowsByQuery[queryIndex++] ?? [];
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "where", "limit"]) {
        builder[method] = () => {
          methodCalls?.push(method);
          return builder;
        };
      }
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return builder;
    },
  } as never;
}

describe("learning plans access DAL", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps full admins automatic without touching the grant database", async () => {
    const select = vi.fn(() => {
      throw new Error("database should not be used");
    });

    await expect(resolveLearningPlansAccess({
      email: "admin@example.com",
      role: "admin",
      allowedPages: null,
    }, { select } as never)).resolves.toBe(true);

    expect(select).not.toHaveBeenCalled();
  });

  it("allows a restricted admin outside the historical page prefix only with a fresh exact grant", async () => {
    await expect(resolveLearningPlansAccess({
      email: " Restricted@Example.com ",
      role: "admin",
      allowedPages: ["/progress-tests"],
    }, selectOnlyDb([[{ email: "restricted@example.com" }]]))).resolves.toBe(true);

    await expect(resolveLearningPlansAccess({
      email: "restricted@example.com",
      role: "admin",
      allowedPages: ["/progress-tests"],
    }, selectOnlyDb([[]]))).resolves.toBe(false);
  });

  it("preserves automatic access for an admin with the exact historical page prefix", async () => {
    const select = vi.fn(() => {
      throw new Error("database should not be used");
    });

    await expect(resolveLearningPlansAccess({
      email: "legacy@example.com",
      role: "admin",
      allowedPages: ["/learning-plans"],
    }, { select } as never)).resolves.toBe(true);

    expect(select).not.toHaveBeenCalled();
  });

  it("requires both a grant and an active onsite or online tutor contact for teachers", async () => {
    await expect(resolveLearningPlansAccess({
      email: " Teacher@Example.com ",
      role: "teacher",
      allowedPages: ["/progress-tests"],
    }, selectOnlyDb([
      [{ email: "teacher@example.com" }],
      [{ id: "active-contact" }],
    ]))).resolves.toBe(true);

    await expect(resolveLearningPlansAccess({
      email: "teacher@example.com",
      role: "teacher",
      allowedPages: ["/progress-tests"],
    }, selectOnlyDb([
      [{ email: "teacher@example.com" }],
      [],
    ]))).resolves.toBe(false);
  });

  it("does not query tutor contacts when the teacher grant is absent", async () => {
    const calls: string[] = [];
    await expect(resolveLearningPlansAccess({
      email: "teacher@example.com",
      role: "teacher",
      allowedPages: ["/progress-tests"],
    }, selectOnlyDb([[]], calls))).resolves.toBe(false);

    expect(calls.filter((method) => method === "from")).toHaveLength(1);
  });

  it("denies other signed-in roles without consulting grants", async () => {
    const select = vi.fn(() => {
      throw new Error("database should not be used");
    });

    await expect(resolveLearningPlansAccess({
      email: "student@example.com",
      role: "student",
      allowedPages: ["/admissions"],
    }, { select } as never)).resolves.toBe(false);

    expect(select).not.toHaveBeenCalled();
  });

  it("fails closed when a grant-dependent database lookup errors", async () => {
    const db = {
      select() {
        throw new Error("database unavailable");
      },
    };

    await expect(resolveLearningPlansAccess({
      email: "restricted@example.com",
      role: "admin",
      allowedPages: ["/progress-tests"],
    }, db as never)).resolves.toBe(false);

    await expect(resolveLearningPlansAccess({
      email: "teacher@example.com",
      role: "teacher",
      allowedPages: ["/progress-tests"],
    }, db as never)).resolves.toBe(false);
  });

  it("re-reads a restricted admin grant within the same live session", async () => {
    const subject = {
      email: "m.giftwan@gmail.com",
      role: "admin",
      allowedPages: ["/progress-tests"],
    };
    const db = selectOnlyDb([
      [{ email: "m.giftwan@gmail.com" }],
      [],
    ]);

    await expect(resolveLearningPlansAccess(subject, db)).resolves.toBe(true);
    await expect(resolveLearningPlansAccess(subject, db)).resolves.toBe(false);
  });

  it("grants the migrated exact accounts without changing their sign-in roles or page claims", async () => {
    const restrictedAdmin = {
      email: "m.giftwan@gmail.com",
      role: "admin",
      allowedPages: ["/progress-tests"],
    };
    const giftTeacher = {
      email: "gift.m@begiftededucation.com",
      role: "teacher",
      allowedPages: ["/progress-tests"],
    };
    const tuddaTeacher = {
      email: "tudda.tudsirivoravat@gmail.com",
      role: "teacher",
      allowedPages: ["/progress-tests"],
    };

    await expect(resolveLearningPlansAccess(
      restrictedAdmin,
      selectOnlyDb([[{ email: restrictedAdmin.email }]]),
    )).resolves.toBe(true);
    await expect(resolveLearningPlansAccess(
      giftTeacher,
      selectOnlyDb([
        [{ email: giftTeacher.email }],
        [{ id: "gift-contact" }],
      ]),
    )).resolves.toBe(true);
    await expect(resolveLearningPlansAccess(
      tuddaTeacher,
      selectOnlyDb([
        [{ email: tuddaTeacher.email }],
        [{ id: "tudda-contact" }],
      ]),
    )).resolves.toBe(true);

    expect(restrictedAdmin).toMatchObject({
      role: "admin",
      allowedPages: ["/progress-tests"],
    });
    expect(giftTeacher).toMatchObject({
      role: "teacher",
      allowedPages: ["/progress-tests"],
    });
    expect(tuddaTeacher).toMatchObject({
      role: "teacher",
      allowedPages: ["/progress-tests"],
    });
  });

  it("uses the authenticated session in the request-cached DAL entry point", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        email: " Teacher@Example.com ",
        role: "teacher",
        allowedPages: ["/progress-tests"],
      },
      expires: new Date(Date.now() + 60_000).toISOString(),
    } as never);
    vi.mocked(getDb).mockReturnValue(selectOnlyDb([
      [{ email: "teacher@example.com" }],
      [{ id: "active-contact" }],
    ]));

    await expect(getLearningPlansAccess()).resolves.toBe(true);
  });

  it("does not let a grant row create authentication or a role", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    await expect(getLearningPlansAccess()).resolves.toBe(false);
    expect(getDb).not.toHaveBeenCalled();
  });
});

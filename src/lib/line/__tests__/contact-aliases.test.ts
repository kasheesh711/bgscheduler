import { describe, expect, it, vi } from "vitest";
import {
  buildLineAliasImportPreviewRows,
  extractLineAliasRowsFromText,
  rankAliasContactCandidates,
  refreshAllLineContactProfiles,
  type LineAliasContactForMatching,
} from "@/lib/line/contact-aliases";
import type { LineStudentDirectoryRow } from "@/lib/line/student-links";

function contact(overrides: Partial<LineAliasContactForMatching>): LineAliasContactForMatching {
  return {
    contactId: "00000000-0000-4000-8000-000000000001",
    lineUserId: "line-user-1",
    displayName: "LINE Parent",
    linkedStudentLabel: null,
    lastMessageText: "เช็คตารางครู Tito ก่อนนะคะ",
    lastMessageAt: "2026-05-29T03:21:00.000Z",
    ...overrides,
  };
}

function student(overrides: Partial<LineStudentDirectoryRow>): LineStudentDirectoryRow {
  return {
    wiseStudentId: "wise-student",
    studentKey: "student::parent",
    studentName: "Student",
    parentName: "Parent",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
    ...overrides,
  };
}

describe("LINE Desktop alias text extraction", () => {
  it("extracts staff-renamed labels and previews from pasted chat-list text", () => {
    const rows = extractLineAliasRowsFromText([
      "𝓟☑️Kin/Parin.Pu 10:21",
      "เช็คตารางครู Tito ก่อนนะคะ",
      "Migs/Angie.De (เลขา) 10:35",
      "For your information, for Migs' class...",
      "Sun/Zea.Lu",
      "จริงๆ อยากเรียน 90 นาที",
    ].join("\n"));

    expect(rows.map((row) => ({
      aliasLabel: row.aliasLabel,
      preview: row.latestMessagePreview,
      time: row.timeLabel,
    }))).toEqual([
      {
        aliasLabel: "𝓟☑️Kin/Parin.Pu",
        preview: "เช็คตารางครู Tito ก่อนนะคะ",
        time: "10:21",
      },
      {
        aliasLabel: "Migs/Angie.De (เลขา)",
        preview: "For your information, for Migs' class...",
        time: "10:35",
      },
      {
        aliasLabel: "Sun/Zea.Lu",
        preview: "จริงๆ อยากเรียน 90 นาที",
        time: null,
      },
    ]);
  });

  it("ranks a single recent message and time match as auto-selectable", () => {
    const candidates = rankAliasContactCandidates({
      aliasLabel: "𝓟☑️Kin/Parin.Pu",
      latestMessagePreview: "เช็คตารางครู Tito ก่อนนะคะ",
      timeLabel: "10:21",
    }, [
      contact({ contactId: "00000000-0000-4000-8000-000000000001" }),
      contact({
        contactId: "00000000-0000-4000-8000-000000000002",
        lastMessageText: "different message",
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].score).toBeGreaterThanOrEqual(80);
    expect(candidates[0].reasons).toEqual([
      "latest message exact match",
      "message time match",
    ]);
  });

  it("builds preview rows with parsed student-code suggestions", () => {
    const [row] = buildLineAliasImportPreviewRows({
      extractedRows: [{
        rowId: "row-1",
        aliasLabel: "𝓟☑️Kin/Parin.Pu",
        latestMessagePreview: "เช็คตารางครู Tito ก่อนนะคะ",
        timeLabel: "10:21",
        rawText: "raw",
      }],
      contacts: [contact({ contactId: "00000000-0000-4000-8000-000000000001" })],
      students: [
        student({
          wiseStudentId: "wise-kin",
          studentKey: "kin.pu::parent",
          studentName: "Kin.Pu",
        }),
        student({
          wiseStudentId: "wise-parin",
          studentKey: "parin.pu::parent",
          studentName: "Parin.Pu",
        }),
      ],
    });

    expect(row.parsedCodes.map((code) => code.code)).toEqual(["Kin.Pu", "Parin.Pu"]);
    expect(row.suggestedStudents.map((match) => match.wiseStudentId)).toEqual(["wise-kin", "wise-parin"]);
    expect(row.autoSelectedContactId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("does not auto-select weak current-review-only matches", () => {
    const [row] = buildLineAliasImportPreviewRows({
      extractedRows: [{
        rowId: "row-1",
        aliasLabel: "Pear.Th",
        latestMessagePreview: null,
        timeLabel: null,
        rawText: "raw",
      }],
      contacts: [contact({ contactId: "00000000-0000-4000-8000-000000000001" })],
      students: [],
      preferredContactId: "00000000-0000-4000-8000-000000000001",
    });

    expect(row.contactCandidates).toEqual([]);
    expect(row.autoSelectedContactId).toBeNull();
  });

  it("matches outbound media previews with timestamp evidence", () => {
    const candidates = rankAliasContactCandidates({
      aliasLabel: "Ada.Li / Aya.Li",
      latestMessagePreview: "You sent a photo.",
      timeLabel: "08:09",
    }, [
      contact({
        contactId: "00000000-0000-4000-8000-000000000001",
        lastMessageText: null,
        lastMessageType: "image",
        lastMessageDirection: "outbound",
        lastMessageAt: "2026-05-29T01:09:00.000Z",
      }),
      contact({
        contactId: "00000000-0000-4000-8000-000000000002",
        lastMessageText: null,
        lastMessageType: "image",
        lastMessageDirection: "outbound",
        lastMessageAt: "2026-05-29T01:00:00.000Z",
      }),
    ]);

    expect(candidates[0]).toMatchObject({
      contactId: "00000000-0000-4000-8000-000000000001",
      reasons: ["latest message exact match", "message time match"],
    });
  });
});

describe("LINE contact profile refresh", () => {
  it("refreshes existing contacts while tolerating missing and failed profiles", async () => {
    const updated: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({
        from: () => ({
          orderBy: async () => [
            { lineUserId: "line-user-ok" },
            { lineUserId: "line-user-missing" },
            { lineUserId: "line-user-failed" },
          ],
        }),
      }),
      update: () => ({
        set: (value: Record<string, unknown>) => ({
          where: async () => {
            updated.push(value);
          },
        }),
      }),
    };
    const fetchProfile = vi.fn(async (lineUserId: string) => {
      if (lineUserId === "line-user-missing") return null;
      if (lineUserId === "line-user-failed") throw new Error("blocked");
      return {
        userId: lineUserId,
        displayName: "LINE Parent",
        pictureUrl: "https://example.com/profile.png",
        statusMessage: "hello",
        raw: { userId: lineUserId, displayName: "LINE Parent" },
      };
    });

    const result = await refreshAllLineContactProfiles({
      db: db as never,
      fetchProfile,
    });

    expect(result).toEqual({
      total: 3,
      refreshed: 1,
      missing: 1,
      failed: [{ lineUserId: "line-user-failed", error: "blocked" }],
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      displayName: "LINE Parent",
      pictureUrl: "https://example.com/profile.png",
      statusMessage: "hello",
    });
  });
});

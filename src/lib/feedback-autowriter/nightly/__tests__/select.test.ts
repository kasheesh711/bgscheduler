import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fieldsHash } from "../../submit";
import { appendJsonl } from "../paths";
import {
  auditKey,
  auditedKeys,
  chooseTargets,
  guidedStamp,
  latePickups,
  loadNightlyTargets,
  targetFromRow,
  type TargetRow,
} from "../select";
import type { NightlyTarget } from "../types";
import { asRows, fakeDb } from "./fake-db";

const SID = "6a0000000000000000000a01";
const FIELDS = {
  topics: "Fractions: adding unlike denominators.",
  performance: "Pim found common denominators with a little help.",
  improvement: "1. Practise finding the lowest common multiple.",
  homework: "",
};

function row(patch: Partial<TargetRow> = {}): TargetRow {
  return {
    wiseSessionId: SID,
    wiseClassId: "6a00000000000000000000c1",
    postWiseClassId: "6a00000000000000000000c1",
    wiseTeacherUserId: "696e2c4343579bbada2340ed",
    scheduledEndAt: new Date("2026-10-02T09:00:00Z"),
    deadlineAt: new Date("2026-10-04T16:59:00Z"),
    evidence: "transcript",
    arm: "sol",
    fields: FIELDS,
    fieldsSha256: "sha-1",
    billing: { sessionStatus: "COMPLETED", creditsConsumed: 1 },
    sonioxTranscriptionId: "job-1",
    metadata: { className: "Somsri (Pim.Ta) Testwong", transcript: { speakerMethod: "zoom_alignment" } },
    sessionPostStartedAt: new Date("2026-10-02T09:40:00Z"),
    firstShotPostId: "post-1",
    firstShotPipeline: { evidence: "transcript", promptVersion: 5, styleGuide: null },
    firstShotStartedAt: new Date("2026-10-02T09:40:00Z"),
    firstShotRecordedAt: new Date("2026-10-02T10:27:00Z"),
    reviewTutorKey: "Kevin",
    currentVerdictId: null,
    mirrorClassName: null,
    ...patch,
  };
}

const NO_FACTS = { verdicts: [], ownerFlagOpen: false, humanSaves: [] };

describe("targetFromRow", () => {
  it("maps a verified autowriter row to a target, the student named by the class name until Wise is read", () => {
    expect(targetFromRow(row(), NO_FACTS)).toEqual({
      wiseSessionId: SID,
      wiseClassId: "6a00000000000000000000c1",
      wiseTeacherUserId: "696e2c4343579bbada2340ed",
      tutorKey: "Kevin",
      scheduledEndAt: "2026-10-02T09:00:00.000Z",
      deadlineAt: "2026-10-04T16:59:00.000Z",
      evidence: "transcript",
      arm: "sol",
      fields: FIELDS,
      fieldsSha256: "sha-1",
      billing: { sessionStatus: "COMPLETED", creditsConsumed: 1 },
      sonioxTranscriptionId: "job-1",
      firstShotPostId: "post-1",
      currentVerdictId: null,
      verdict: null,
      ownerFlagOpen: false,
      humanSavedSincePost: false,
      guided: false,
      pipeline: { evidence: "transcript", promptVersion: 5, styleGuide: null },
      studentFullName: "Somsri (Pim.Ta) Testwong",
      studentDisplayName: "Pim",
      className: "Somsri (Pim.Ta) Testwong",
    } satisfies NightlyTarget);
  });

  it("prefers the Class Feedback mirror's class name, the stamp's evidence, and hashes text with no stored hash", () => {
    const target = targetFromRow(row({
      mirrorClassName: "Nokrak (Nok.Ka) Testwong",
      evidence: "transcript",
      firstShotPipeline: { evidence: "summary" },
      fieldsSha256: null,
    }), NO_FACTS);
    expect(target?.studentDisplayName).toBe("Nok");
    expect(target?.evidence).toBe("summary");
    expect(target?.fieldsSha256).toBe(fieldsHash(FIELDS));
  });

  it("takes the current verdict, else the newest; owner flags; and saves by a person after our post", () => {
    const facts = {
      verdicts: [{ id: "v2", verdict: "needs_fix" as const }, { id: "v1", verdict: "approve" as const }],
      ownerFlagOpen: true,
      humanSaves: [new Date("2026-10-02T09:00:00Z"), new Date("2026-10-02T11:00:00Z")],
    };
    expect(targetFromRow(row({ currentVerdictId: "v1" }), facts)).toMatchObject({
      verdict: "approve", currentVerdictId: "v1", ownerFlagOpen: true, humanSavedSincePost: true,
    });
    expect(targetFromRow(row(), { ...facts, humanSaves: [new Date("2026-10-02T09:00:00Z")] })).toMatchObject({
      verdict: "needs_fix", humanSavedSincePost: false,
    });
  });

  it("keeps a verified post whose first shot is not recorded yet, timing person saves from the row's own POST", () => {
    const target = targetFromRow(row({
      firstShotPostId: null, firstShotPipeline: null, firstShotStartedAt: null, firstShotRecordedAt: null,
      metadata: { className: "Somsri (Pim.Ta) Testwong", pipeline: { evidence: "transcript", lessonEvidenceHash: "h" } },
    }), { verdicts: [], ownerFlagOpen: false, humanSaves: [new Date("2026-10-02T09:39:00Z"), new Date("2026-10-02T09:50:00Z")] });
    expect(target).toMatchObject({ firstShotPostId: null, guided: true, pipeline: { lessonEvidenceHash: "h" }, humanSavedSincePost: true });
    const early = targetFromRow(row({ firstShotPostId: null, firstShotStartedAt: null, firstShotRecordedAt: null, sessionPostStartedAt: null }), {
      verdicts: [], ownerFlagOpen: false, humanSaves: [new Date("2026-10-02T08:00:00Z")],
    });
    // Without any POST time, only saves after the class ended count.
    expect(early?.humanSavedSincePost).toBe(false);
  });

  it("skips a row whose text is not four readable fields", () => {
    expect(targetFromRow(row({ fields: { topics: "x" } }), NO_FACTS)).toBeNull();
    expect(targetFromRow(row({ scheduledEndAt: null }), NO_FACTS)).toBeNull();
  });

  it("marks guided drafts (style, format, Atom or retained lesson evidence)", () => {
    expect(guidedStamp(null)).toBe(false);
    expect(guidedStamp({ styleGuide: null, formatGuide: null, atomEvidenceHash: null, lessonEvidenceHash: null })).toBe(false);
    expect(guidedStamp({ formatGuide: { id: "iseb", version: 1 } })).toBe(true);
    expect(guidedStamp({ lessonEvidenceHash: "abc" })).toBe(true);
  });
});

describe("loadNightlyTargets", () => {
  const MAIN_ORDER = [
    "wiseSessionId", "wiseClassId", "postWiseClassId", "wiseTeacherUserId", "scheduledEndAt", "deadlineAt", "evidence", "arm",
    "fields", "fieldsSha256", "billing", "sonioxTranscriptionId", "metadata", "sessionPostStartedAt", "firstShotPostId", "firstShotPipeline",
    "firstShotStartedAt", "firstShotRecordedAt", "reviewTutorKey", "currentVerdictId", "mirrorClassName",
  ];

  it("reads only (SELECTs), bounds the Bangkok day and LEFT-joins the first-shot post by the autowriter", async () => {
    const { db, queries } = fakeDb((query) => {
      if (query.sql.includes("from \"feedback_autowriter_sessions\"")) {
        return asRows(MAIN_ORDER, [{
          ...row(), scheduledEndAt: "2026-10-02 09:00:00+00", deadlineAt: "2026-10-04 16:59:00+00", sessionPostStartedAt: "2026-10-02 09:40:00+00",
          firstShotStartedAt: "2026-10-02 09:40:00+00", firstShotRecordedAt: "2026-10-02 10:27:00+00",
        }]);
      }
      if (query.sql.includes("from \"feedback_autowriter_verdicts\"")) return [["v1", SID, "approve"]];
      if (query.sql.includes("from \"feedback_autowriter_flags\"")) return [];
      if (query.sql.includes("from \"feedback_autowriter_fix_events\"")) return [[SID, "2026-10-02 12:00:00+00"]];
      return [];
    });
    const targets = await loadNightlyTargets(db, { night: "2026-10-02" });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ wiseSessionId: SID, verdict: "approve", humanSavedSincePost: true, studentDisplayName: "Pim" });
    expect(queries.every((query) => /^\s*select\b/iu.test(query.sql))).toBe(true);
    const main = queries[0];
    expect(main.sql).toMatch(/left join "feedback_autowriter_posts"/u);
    expect(main.sql).toMatch(/"feedback_autowriter_posts"\."kind" = \$\d+/u);
    expect(main.sql).toMatch(/"feedback_autowriter_posts"\."actor_kind" = \$\d+/u);
    expect(main.params).toEqual(expect.arrayContaining(["first_shot", "autowriter", "verified"]));
    // 00:00–24:00 Asia/Bangkok on the night.
    expect(main.params).toEqual(expect.arrayContaining(["2026-10-01T17:00:00.000Z", "2026-10-02T17:00:00.000Z"]));
    const fixEvents = queries.find((query) => query.sql.includes("feedback_autowriter_fix_events"));
    expect(fixEvents?.params).toEqual(expect.arrayContaining(["owner_web", "tutor", "other_staff", "api_actor_unmatched"]));
    const flags = queries.find((query) => query.sql.includes("feedback_autowriter_flags"));
    expect(flags?.params).toEqual(expect.arrayContaining(["owner"]));
  });

  it("asks nothing more when the night has no posts", async () => {
    const { db, queries } = fakeDb(() => []);
    expect(await loadNightlyTargets(db, { night: "2026-10-02", sessionIds: [SID] })).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0].params).toContain(SID);
  });
});

describe("chooseTargets", () => {
  const target = (sid: string, end: string, sha = "sha"): NightlyTarget => ({
    ...(targetFromRow(row(), NO_FACTS) as NightlyTarget), wiseSessionId: sid, scheduledEndAt: end, fieldsSha256: sha,
  });

  it("keeps audited and twice-failed classes in the night, newest first, and caps only the classes still to audit", () => {
    const targets = [
      target("6a0000000000000000000a01", "2026-10-02T03:00:00.000Z"),
      target("6a0000000000000000000a02", "2026-10-02T09:00:00.000Z"),
      target("6a0000000000000000000a03", "2026-10-02T06:00:00.000Z"),
      target("6a0000000000000000000a04", "2026-10-02T07:00:00.000Z"),
      target("6a0000000000000000000a05", "2026-10-02T01:00:00.000Z"),
    ];
    const audited = new Set([auditKey({ wiseSessionId: "6a0000000000000000000a03", fieldsSha256: "sha", auditVersion: 1 })]);
    const failedKey = auditKey({ wiseSessionId: "6a0000000000000000000a04", fieldsSha256: "sha", auditVersion: 1 });
    const choice = chooseTargets({ targets, audited, failures: (key) => (key === failedKey ? 2 : 0), auditVersion: 1, maxTargets: 2 });
    expect(choice.chosen.map((item) => item.wiseSessionId)).toEqual([
      "6a0000000000000000000a02", "6a0000000000000000000a04", "6a0000000000000000000a03", "6a0000000000000000000a01",
    ]);
    expect(choice.skipped).toEqual([{ wiseSessionId: "6a0000000000000000000a05", reason: "over_cap" }]);
    expect(choice.counts).toEqual({ alreadyAudited: 1, failedTwice: 1, toAudit: 2, late: 0, kept: 0 });
    // A new audit version is a new key: every class needs an audit again.
    expect(chooseTargets({ targets, audited, failures: () => 0, auditVersion: 2, maxTargets: 60 }).counts.toAudit).toBe(5);
  });

  it("never drops a class an earlier selection chose, and lets the newest data win", () => {
    const earlier = [target("6a0000000000000000000a01", "2026-10-02T03:00:00.000Z", "old-sha"), target("6a0000000000000000000a09", "2026-10-02T02:00:00.000Z")];
    const audited = new Set([auditKey({ wiseSessionId: "6a0000000000000000000a09", fieldsSha256: "sha", auditVersion: 1 })]);
    const choice = chooseTargets({
      targets: [target("6a0000000000000000000a01", "2026-10-02T03:00:00.000Z", "new-sha"), target("6a0000000000000000000a02", "2026-10-02T09:00:00.000Z")],
      previous: earlier, audited, failures: () => 0, auditVersion: 1, maxTargets: 1,
    });
    // a09 is no longer returned by the query (audited earlier): kept. a01 keeps its place with its new text; a02 is over the cap.
    expect(choice.chosen.map((item) => [item.wiseSessionId, item.fieldsSha256])).toEqual([
      ["6a0000000000000000000a01", "new-sha"], ["6a0000000000000000000a09", "sha"],
    ]);
    expect(choice.skipped).toEqual([{ wiseSessionId: "6a0000000000000000000a02", reason: "over_cap" }]);
    expect(choice.counts).toMatchObject({ kept: 2, alreadyAudited: 1, toAudit: 1 });
  });

  it("puts late pickups after the night's own posts and labels them", () => {
    const late = latePickups({
      posts: [target("6a0000000000000000000b01", "2026-10-01T15:00:00.000Z"), target("6a0000000000000000000b02", "2026-10-01T14:00:00.000Z"),
        target("6a0000000000000000000b03", "2026-10-01T13:00:00.000Z")],
      night: "2026-10-01",
      earlier: { chosen: [target("6a0000000000000000000b02", "2026-10-01T14:00:00.000Z")], skipped: [] },
      audited: new Set([auditKey({ wiseSessionId: "6a0000000000000000000b03", fieldsSha256: "sha", auditVersion: 1 })]),
      auditVersion: 1,
    });
    // b02 was selected that night; b03 was audited: only b01 is late.
    expect(late.map((item) => [item.wiseSessionId, item.lateFrom])).toEqual([["6a0000000000000000000b01", "2026-10-01"]]);
    // A night never selected is not caught up.
    expect(latePickups({ posts: [target("6a0000000000000000000b01", "2026-10-01T15:00:00.000Z")], night: "2026-10-01", earlier: null, audited: new Set(), auditVersion: 1 })).toEqual([]);
    const choice = chooseTargets({ targets: [target("6a0000000000000000000a01", "2026-10-02T03:00:00.000Z")], late, audited: new Set(), failures: () => 0, auditVersion: 1, maxTargets: 60 });
    expect(choice.chosen.map((item) => [item.wiseSessionId, item.lateFrom ?? null])).toEqual([
      ["6a0000000000000000000a01", null], ["6a0000000000000000000b01", "2026-10-01"],
    ]);
    expect(choice.counts.late).toBe(1);
  });

  it("reads finished audits from the metadata ledger", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-select-"));
    try {
      const file = path.join(dir, "ledger.jsonl");
      appendJsonl(file, { type: "audit", key: "audit:a:sha:a1", verdict: "major" });
      appendJsonl(file, { type: "audit", key: "audit:b:sha:a1", verdict: null, failure: "unparseable" });
      appendJsonl(file, { type: "class_report", key: "audit:c:sha:a1", verdict: "accurate" });
      expect([...auditedKeys(file)]).toEqual(["audit:a:sha:a1"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

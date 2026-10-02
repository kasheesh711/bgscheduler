import { describe, expect, it } from "vitest";
import { answers, autoBlankSubmission, sessionDetail } from "../../__tests__/fixtures";
import type { RawEvidence } from "../evidence";
import { loadOtherStudentNames, runPrechecks } from "../prechecks";
import { asRows, fakeDb } from "./fake-db";
import { CID, PIM_FIELDS, SID, nightlyBundle, nightlyTarget } from "./nightly-fixtures";

function raw(submissions: unknown[]): RawEvidence {
  return {
    wiseSessionId: SID,
    detail: { data: sessionDetail({ _id: SID, classId: CID, feedbackSubmissions: submissions }) },
    iseb: null, transcript: null, zoomVtt: null,
    rowMeta: { speakerMethod: "zoom_alignment", judge: null, joinedAsGuest: null },
    status: { collectedAt: "", rowMeta: "read", iseb: "not_guided", detail: "fetched", soniox: "fetched", zoom: "none", retranscribe: "not_needed" },
    notes: [],
  };
}

const posted = autoBlankSubmission({
  answers: answers([PIM_FIELDS.topics, PIM_FIELDS.performance, PIM_FIELDS.improvement, PIM_FIELDS.homework]),
  metadata: {},
});

const run = (patch: { bundle?: Parameters<typeof nightlyBundle>[0]; target?: Parameters<typeof nightlyTarget>[0]; raw?: RawEvidence | null; others?: string[] } = {}) =>
  runPrechecks({
    bundle: nightlyBundle(patch.bundle),
    target: nightlyTarget(patch.target),
    otherStudentNames: patch.others ?? ["Nok"],
    priorFeedback: [],
    raw: patch.raw === undefined ? raw([posted]) : patch.raw,
  });

describe("runPrechecks", () => {
  it("leaves a sound post with info findings only", () => {
    const findings = run();
    expect(findings.filter((finding) => finding.severity !== "info")).toEqual([]);
    expect(findings.map((finding) => finding.code)).toEqual(["evidence_grade_rebuilt"]);
  });

  it("raises billing drift and an extra teacher submission as critical", () => {
    const drift = run({ raw: raw([{ ...posted, creditsConsumed: 2 }]) });
    expect(drift).toEqual(expect.arrayContaining([expect.objectContaining({ code: "billing_drift", severity: "critical", mode: "M13", candidate: false })]));
    const extra = run({ raw: raw([posted, { ...posted, _id: "6a0000000000000000000099" }]) });
    expect(extra).toEqual(expect.arrayContaining([expect.objectContaining({ code: "teacher_submissions_2", severity: "critical", mode: "M13" })]));
    expect(run({ target: { billing: null } })).toEqual(expect.arrayContaining([expect.objectContaining({ code: "billing_unknown", severity: "info" })]));
  });

  it("notes a text edited in Wise since our post as info, never a correction target", () => {
    expect(run({ bundle: { wiseTextMatchesPost: false } })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "wise_text_edited", severity: "info", mode: null }),
    ]));
  });

  it("turns validator, naming and meta-word problems into floors and candidates", () => {
    const fields = {
      ...PIM_FIELDS,
      performance: `${PIM_FIELDS.performance} Pimchanok and Nok both used the zoom tool.`,
    };
    const findings = run({ bundle: { postedFields: fields } });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "student_name_form", severity: "major", mode: "M11", candidate: false }),
      expect.objectContaining({ code: "other_student_named", severity: "critical", mode: "M02", candidate: true }),
      expect.objectContaining({ code: "meta_word:zoom", severity: "major", mode: "M12", candidate: true }),
    ]));
    // Codes never carry the name; the detail does (local files only).
    expect(findings.find((finding) => finding.code === "other_student_named")?.detail).toContain("Nok");
    const validator = run({ bundle: { postedFields: { ...PIM_FIELDS, topics: `${PIM_FIELDS.topics} [STUDENT_1]` } } });
    expect(validator).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "validator:placeholder_token:topics", severity: "major", mode: "M12" }),
    ]));
  });

  it("adds the class's context as info", () => {
    const findings = run({ target: { guided: true, humanSavedSincePost: true, ownerFlagOpen: true, verdict: "approve", firstShotPostId: null } });
    expect(findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "guided_post", "human_save_since_post", "owner_flag_open", "owner_verdict_approve", "no_first_shot_row",
    ]));
    expect(findings.find((finding) => finding.code === "no_first_shot_row")?.severity).toBe("info");
    expect(run({ bundle: { studentFullName: null, studentDisplayName: null }, target: { studentFullName: null } }).map((f) => f.code)).toContain("student_unknown");
  });
});

describe("loadOtherStudentNames", () => {
  it("reads the tutor's other students (SELECT only) and keeps names, not course labels", async () => {
    const { db, queries } = fakeDb(() => asRows(["wiseClassId", "metadata", "mirror"], [
      { wiseClassId: CID, metadata: { className: "Pimchanok (Pim.Ta) Testwong" }, mirror: null },
      { wiseClassId: "6a00000000000000000000c2", metadata: { className: "Noknoi (Nok.Ka) Samplename" }, mirror: null },
      { wiseClassId: "6a00000000000000000000c3", metadata: {}, mirror: "Tawanchai Example" },
      { wiseClassId: "6a00000000000000000000c4", metadata: { className: "Maths Y5 group" }, mirror: null },
    ]));
    const names = await loadOtherStudentNames(db, { tutorKey: "Kevin", excludeClassId: CID, now: new Date("2026-10-03T00:00:00Z") });
    expect(names).toEqual(["Nok", "Tawanchai"]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/^select/iu);
    expect(await loadOtherStudentNames(db, { tutorKey: null, excludeClassId: CID, now: new Date() })).toEqual([]);
    expect(await loadOtherStudentNames(db, { tutorKey: "Nobody", excludeClassId: CID, now: new Date() })).toEqual([]);
  });
});

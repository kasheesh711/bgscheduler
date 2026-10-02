import { describe, expect, it } from "vitest";
import {
  ATTEMPT_AT_PATTERN,
  PROVEN_TUTOR_KEYS,
  ROSTER_SIGHTING_SLACK_MS,
  addDays,
  bangkokDateKey,
  bangkokDayBounds,
  DATA_QUALITY_REASONS,
  buildDailyMetrics,
  classifyCoverage,
  computeGateFacts,
  countsTowardFix,
  coverageRatio,
  dataQualityReason,
  downgradeOf,
  dailyGateDate,
  emptyCoverageCounts,
  evaluateGate,
  fixRoundBucket,
  floorPercent,
  gateWindow,
  isAccurate,
  metricDates,
  nextExpansionSize,
  postingWindowEligibility,
  reviewInclusion,
  tutorWroteFirst,
  wilsonLowerBound,
  type ControlStateChange,
  type GateInput,
} from "../quality";
import { SUMMARY_FALLBACK_CAUSES } from "../types";

const gate = (overrides: Partial<GateInput> = {}): GateInput => ({
  reviewed: 20, accurate: 20, criticalVerdicts: 0, unresolvedCriticalFlags: 0, pendingFlaggedReviews: 0,
  requiredPending: 0, unrecordedPosts: 0, unexplainedApiWrites: 0, coverageNum: 8, coverageDen: 10, ...overrides,
});

describe("wilsonLowerBound (two-sided 95%)", () => {
  it("matches reference values", () => {
    expect(wilsonLowerBound(20, 20)).toBeCloseTo(0.839, 3);
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, 5)).toBe(0);
    expect(wilsonLowerBound(24, 25)).toBeCloseTo(0.8046, 4);
  });

  it("needs 9 clean reviews for the head start and 16 to pass; one factual error pushes the pass to 25", () => {
    expect(wilsonLowerBound(8, 8)).toBeLessThan(0.7);
    expect(wilsonLowerBound(9, 9)).toBeGreaterThanOrEqual(0.7);
    expect(wilsonLowerBound(15, 15)).toBeLessThan(0.8);
    expect(wilsonLowerBound(16, 16)).toBeGreaterThanOrEqual(0.8);
    expect(wilsonLowerBound(23, 24)).toBeLessThan(0.8);
    expect(wilsonLowerBound(24, 25)).toBeGreaterThanOrEqual(0.8);
  });
});

describe("isAccurate", () => {
  it("counts approvals and cosmetic fixes only", () => {
    expect(isAccurate({ verdict: "approve", severity: null })).toBe(true);
    expect(isAccurate({ verdict: "needs_fix", severity: "cosmetic" })).toBe(true);
    expect(isAccurate({ verdict: "needs_fix", severity: "factual" })).toBe(false);
    expect(isAccurate({ verdict: "needs_fix", severity: "critical" })).toBe(false);
  });
});

describe("classifyCoverage", () => {
  it.each([
    ["verified", "verified", "posted"],
    ["awaiting_event", null, "posted"],
    // Handed back at the deadline with nothing showing its tutor off as the window closed (no history here): judged
    // like the expiry it replaced (fail-closed). With the tutor off then, it is left out (D-03, below).
    ["skipped_scope", "tutor_off_at_deadline", "miss_expired"],
    ["skipped_scope", "class_type_GROUP", "excluded_scope"],
    // D-03: a hold for the class's own data is left out; a hold on our drafts is a miss.
    ["held", "student_count_0", "excluded_data_quality"],
    ["held", "attendance_30pct", "excluded_data_quality"],
    ["held", "student_not_wise_user", "excluded_data_quality"],
    ["held", "student_id_missing", "excluded_data_quality"],
    ["held", "recording_too_short", "excluded_data_quality"],
    ["held", "glm:unfaithful:…", "miss_held"],
    ["expired", "deadline_passed_or_too_close", "miss_expired"],
    ["rejected", null, "miss_failed"],
    ["unknown_outcome", null, "miss_failed"],
    ["verify_failed", null, "miss_failed"],
    ["pending", null, "pending"],
    ["posting", null, "pending"],
    ["awaiting_recording", "thai_summary", "pending"],
    // Transcript first: waiting for the recording, being transcribed, or back on the summary after a fallback is
    // still in the works — never a miss while the posting window is open.
    ["awaiting_recording", "transcript_first", "pending"],
    ["transcribing", "zoom_transcript_pending", "pending"],
    ["pending", "summary_fallback:no_recording", "pending"],
    ["would_submit", "shadow", "pending"],
  ] as const)("%s (%s) → %s", (state, reason, expected) => {
    expect(classifyCoverage({ state, reason })).toBe(expected);
  });

  it("leaves in-person classes out entirely", () => {
    expect(classifyCoverage({ state: "skipped_scope", reason: "session_type_OFFLINE" })).toBeNull();
    expect(classifyCoverage({ state: "skipped_scope", reason: "session_type_in_person_title" })).toBeNull();
  });

  it("counts a class the autowriter never saw only when proven online one-to-one and on the roster", () => {
    const workable = { onRoster: true, workable: true, tutorOffThroughout: false, tutorOffAtWindowEnd: false };
    expect(classifyCoverage({ state: null, reason: null, provenOnlineOneToOne: true, eligibility: workable })).toBe("miss_unseen");
    expect(classifyCoverage({ state: null, reason: null, provenOnlineOneToOne: false, eligibility: workable })).toBeNull();
    expect(classifyCoverage({ state: null, reason: null, provenOnlineOneToOne: true, eligibility: { ...workable, onRoster: false, workable: false } })).toBeNull();
  });

  it("excludes a class the switches never let us write, whatever its state — but never a posted one", () => {
    const notLive = { onRoster: true, workable: false, tutorOffThroughout: false, tutorOffAtWindowEnd: false };
    const tutorOff = { onRoster: true, workable: false, tutorOffThroughout: true, tutorOffAtWindowEnd: true };
    expect(classifyCoverage({ state: null, reason: null, provenOnlineOneToOne: true, eligibility: notLive })).toBe("excluded_not_live");
    expect(classifyCoverage({ state: null, reason: null, provenOnlineOneToOne: true, eligibility: tutorOff })).toBe("excluded_tutor_off");
    expect(classifyCoverage({ state: "held", reason: "glm:unfaithful", eligibility: notLive })).toBe("excluded_not_live");
    expect(classifyCoverage({ state: "expired", reason: null, eligibility: tutorOff })).toBe("excluded_tutor_off");
    expect(classifyCoverage({ state: "verified", reason: null, eligibility: notLive })).toBe("posted");
  });

  it("leaves out a class handed back at the deadline because its tutor was switched off (D-03), however long it was workable", () => {
    const workableThenOff = { onRoster: true, workable: true, tutorOffThroughout: false, tutorOffAtWindowEnd: true };
    const tutorOff = { onRoster: true, workable: false, tutorOffThroughout: true, tutorOffAtWindowEnd: true };
    expect(classifyCoverage({ state: "skipped_scope", reason: "tutor_off_at_deadline", eligibility: tutorOff })).toBe("excluded_tutor_off");
    expect(classifyCoverage({ state: "skipped_scope", reason: "tutor_off_at_deadline", eligibility: workableThenOff })).toBe("excluded_tutor_off");
  });

  it("judges a hand-back whose tutor was still on as its window closed like the expiry it replaced", () => {
    const workable = { onRoster: true, workable: true, tutorOffThroughout: false, tutorOffAtWindowEnd: false };
    const notLive = { onRoster: true, workable: false, tutorOffThroughout: false, tutorOffAtWindowEnd: false };
    expect(classifyCoverage({ state: "skipped_scope", reason: "tutor_off_at_deadline", eligibility: workable })).toBe("miss_expired");
    expect(classifyCoverage({ state: "expired", reason: "deadline_passed_or_too_close", eligibility: workable })).toBe("miss_expired");
    expect(classifyCoverage({ state: "skipped_scope", reason: "tutor_off_at_deadline", eligibility: notLive })).toBe("excluded_not_live");
    expect(classifyCoverage({ state: "expired", reason: "deadline_passed_or_too_close", eligibility: notLive })).toBe("excluded_not_live");
    // Only the hand-back reason is judged by the history; any other scope skip stays out of scope.
    expect(classifyCoverage({ state: "skipped_scope", reason: "class_type_GROUP", eligibility: workable })).toBe("excluded_scope");
  });

  // D-03 (owner, 30 Sep): every reason the autowriter holds a class for (job.ts, session.ts gates, pipeline.ts), and the
  // class it lands in. Only the class's own data leaves the denominator; anything about our drafts, the form, billing
  // or our pipeline is a miss — and so is a reason nobody listed (fail-closed).
  it.each([
    // Data quality: nothing any draft could fix.
    ["recording_too_short", "excluded_data_quality"],
    ["recording_multiple_parts", "excluded_data_quality"],
    ["speakers_unclear", "excluded_data_quality"],
    ["transcript_too_short", "excluded_data_quality"],
    ["student_count_0", "excluded_data_quality"],
    ["attendance_0pct", "excluded_data_quality"],
    ["attendance_45pct", "excluded_data_quality"],
    ["student_not_wise_user", "excluded_data_quality"],
    // The same fact found only by the POST's fresh read (submit.ts precheck).
    ["student_id_missing", "excluded_data_quality"],
    // The judge or the validator rejected our drafts (one reason per writer arm, "; "-joined).
    ["glm:unfaithful:homework not in the summary", "miss_held"],
    ["glm:unfaithful:a | b; luna:unfaithful:c", "miss_held"],
    ["glm:markdown:improvement; luna:output_not_json", "miss_held"],
    ["glm:thai_text:topics", "miss_held"],
    ["glm:placeholder_token:homework", "miss_held"],
    // The model's own claim that the student was absent is a validation hold, not Wise's attendance: a miss.
    ["glm:model_reports_student_not_attended", "miss_held"],
    // The form, billing or our pipeline.
    ["feedback_form_question_unmapped", "miss_held"],
    ["feedback_form_missing_or_disabled", "miss_held"],
    ["billing:auto_status_CANCELLED", "miss_held"],
    ["billing:insufficient_student_credits", "miss_held"],
    ["error:TypeError: fetch failed", "miss_held"],
    ["transcript_pass_unavailable", "miss_held"],
    ["soniox_timeout", "miss_held"],
    ["soniox_error:bad audio", "miss_held"],
    // Also what the transcript-first handover holds a class for (no student name, or a tutor off the roster).
    ["missing_student_or_tutor", "miss_held"],
    ["missing_summary_student_or_tutor", "miss_held"],
    // Transcript first: after a fallback, a mostly-Thai summary is held for a person. We chose not to write from it,
    // whatever sent the class back, so it is a miss — not in the owner's list.
    ["thai_summary_no_transcript", "miss_held"],
    ["submission_ambiguous:two_teacher_submissions", "miss_held"],
    ["non_teacher_submission_with_billing", "miss_held"],
    // Not whole matches of a data-quality reason, and no reason at all. (The gate names a fractional attendance by
    // its whole percent, so "attendance_42.5pct" is never produced: session.test.ts.)
    ["recording_too_short_maybe", "miss_held"],
    ["glm:speakers_unclear", "miss_held"],
    // A fallback's reason names its cause, and is never a hold reason of its own: not a data-quality match either.
    ["summary_fallback:speakers_unclear", "miss_held"],
    ["summary_fallback:recording_multiple_parts", "miss_held"],
    ["attendance_42.5pct", "miss_held"],
    [null, "miss_held"],
  ] as const)("a hold for %s → %s", (reason, expected) => {
    expect(classifyCoverage({ state: "held", reason })).toBe(expected);
  });

  // Transcript first: the handover and the fallback are steps on the way, so a class is judged by where it ends. The
  // fallback's cause never leaves it out — not even one that is a data-quality hold on the second pass (a recording in
  // several parts, speakers unclear): the summary was still there to write from.
  it.each(SUMMARY_FALLBACK_CAUSES)("keeps a class that fell back to the summary (%s) in the works until its window closes", (cause) => {
    const reason = `summary_fallback:${cause}`;
    expect(dataQualityReason(reason)).toBeNull();
    expect(classifyCoverage({ state: "pending", reason })).toBe("pending");
    expect(classifyCoverage({ state: "generating", reason })).toBe("pending");
    expect(classifyCoverage({ state: "pending", reason, windowClosed: true })).toBe("miss_expired");
  });

  it("judges a class that fell back by its final outcome", () => {
    expect(classifyCoverage({ state: "verified", reason: "verified" })).toBe("posted");
    expect(classifyCoverage({ state: "held", reason: "thai_summary_no_transcript" })).toBe("miss_held");
    expect(classifyCoverage({ state: "held", reason: "sol:unfaithful:homework not set: …" })).toBe("miss_held");
    expect(classifyCoverage({ state: "expired", reason: "deadline_passed_or_too_close" })).toBe("miss_expired");
  });

  it("counts a transcript-first class still waiting for its recording as a miss only once its window has closed", () => {
    expect(classifyCoverage({ state: "awaiting_recording", reason: "transcript_first" })).toBe("pending");
    expect(classifyCoverage({ state: "transcribing", reason: "infra:sol:timeout", windowClosed: false })).toBe("pending");
    expect(classifyCoverage({ state: "awaiting_recording", reason: "transcript_first", windowClosed: true })).toBe("miss_expired");
    // The tutor wrote it while we waited for the recording (no writer call yet): left out, as on the summary path.
    expect(classifyCoverage({ state: "skipped_human", reason: "human_submission", tutorWroteFirst: true })).toBe("excluded_tutor_first");
    // What still holds a transcript-first class for its own data (it never falls back on these) stays left out.
    expect(classifyCoverage({ state: "held", reason: "recording_too_short" })).toBe("excluded_data_quality");
    expect(classifyCoverage({ state: "held", reason: "transcript_too_short" })).toBe("excluded_data_quality");
  });

  it("lists exactly the owner's data-quality reasons, each with a label", () => {
    expect(DATA_QUALITY_REASONS.map((entry) => [entry.label, entry.coverage])).toEqual([
      ["Recording too short", "excluded_data_quality"],
      ["Recording in several parts", "excluded_data_quality"],
      ["Speakers unclear", "excluded_data_quality"],
      ["Transcript too short", "excluded_data_quality"],
      ["No student", "excluded_data_quality"],
      ["Student absent (attendance below the minimum)", "excluded_data_quality"],
      ["Student not a Wise user", "excluded_data_quality"],
      ["Student may have joined as a guest", "excluded_data_quality"],
      ["Student not a Wise user (POST check)", "excluded_data_quality"],
      ["Tutor switched off", "excluded_tutor_off"],
    ]);
    expect(dataQualityReason("tutor_off_at_deadline")?.label).toBe("Tutor switched off");
    // Matched whole, and never a global regex (a stateful lastIndex would skip every other match).
    expect(DATA_QUALITY_REASONS.every((entry) => entry.match.source.startsWith("^") && entry.match.source.endsWith("$") && !entry.match.global)).toBe(true);
    expect([1, 2, 3].map(() => dataQualityReason("speakers_unclear")?.label)).toEqual(["Speakers unclear", "Speakers unclear", "Speakers unclear"]);
    // A data-quality hold of a class the switches never let us write stays "not live"; a tutor-off reason never excuses a hold.
    expect(classifyCoverage({ state: "held", reason: "tutor_off_at_deadline" })).toBe("miss_held");
    expect(classifyCoverage({
      state: "held", reason: "speakers_unclear", eligibility: { onRoster: true, workable: false, tutorOffThroughout: false, tutorOffAtWindowEnd: false },
    })).toBe("excluded_not_live");
  });

  it("counts a skipped class as the tutor's only when they wrote before we started writing", () => {
    expect(classifyCoverage({ state: "skipped_human", reason: "human_submission", tutorWroteFirst: true })).toBe("excluded_tutor_first");
    expect(classifyCoverage({ state: "skipped_human", reason: "submission_changed_to_human", tutorWroteFirst: false })).toBe("miss_late");
    // Not proven either way → a miss (fail-closed).
    expect(classifyCoverage({ state: "skipped_human", reason: "human_submission" })).toBe("miss_late");
  });

  it("counts a class still unsettled after its posting window as expired, even before the sweep expires it", () => {
    expect(classifyCoverage({ state: "pending", reason: "attendance_unknown", windowClosed: true })).toBe("miss_expired");
    expect(classifyCoverage({ state: "awaiting_recording", reason: null, windowClosed: true })).toBe("miss_expired");
    expect(classifyCoverage({ state: "posting", reason: null, windowClosed: true })).toBe("pending");
    expect(classifyCoverage({ state: "pending", reason: null, windowClosed: false })).toBe("pending");
  });

  it("coverage is posted over posted plus misses", () => {
    const counts = { ...emptyCoverageCounts(), posted: 7, miss_held: 1, miss_late: 1, miss_unseen: 1, excluded_tutor_first: 5, pending: 3 };
    expect(coverageRatio(counts)).toEqual({ num: 7, den: 10, ratio: 0.7 });
    expect(coverageRatio(emptyCoverageCounts()).ratio).toBeNull();
  });
});

describe("postingWindowEligibility", () => {
  const TUTOR = "tutor-a";
  const at = (iso: string) => new Date(iso);
  const window = { start: at("2026-09-29T03:00:00Z"), end: at("2026-10-01T16:29:59Z") };
  const change = (iso: string, mode: ControlStateChange["mode"], disabledTutors: string[] = []): ControlStateChange =>
    ({ changedAt: at(iso), mode, disabledTutors });

  it("assumes live and every tutor on before the history starts (fail-closed)", () => {
    expect(postingWindowEligibility({ teacherId: TUTOR, window, history: [] }))
      .toEqual({ onRoster: true, workable: true, tutorOffThroughout: false, tutorOffAtWindowEnd: false });
    expect(postingWindowEligibility({ teacherId: TUTOR, window, history: [change("2026-09-30T00:00:00Z", "off")] }).workable).toBe(true);
  });

  it("reads the tutor's switch in effect at the window's end, whatever the mode", () => {
    const off = (history: ControlStateChange[]) => postingWindowEligibility({ teacherId: TUTOR, window, history }).tutorOffAtWindowEnd;
    expect(off([change("2026-09-28T00:00:00Z", "live"), change("2026-10-01T10:00:00Z", "live", [TUTOR])])).toBe(true);
    expect(off([change("2026-09-28T00:00:00Z", "live"), change("2026-10-01T10:00:00Z", "off", [TUTOR])])).toBe(true);
    // A change at the window's last instant counts; one a millisecond later does not.
    expect(off([change("2026-09-28T00:00:00Z", "live"), change("2026-10-01T16:29:59.000Z", "live", [TUTOR])])).toBe(true);
    expect(off([change("2026-09-28T00:00:00Z", "live"), change("2026-10-01T16:29:59.001Z", "live", [TUTOR])])).toBe(false);
    // Off during the window but back on before it closed; another tutor off; nothing recorded yet (fail-closed).
    expect(off([change("2026-09-28T00:00:00Z", "live", [TUTOR]), change("2026-10-01T00:00:00Z", "live")])).toBe(false);
    expect(off([change("2026-09-28T00:00:00Z", "live", ["tutor-b"])])).toBe(false);
    expect(off([change("2026-10-02T00:00:00Z", "live", [TUTOR])])).toBe(false);
    expect(postingWindowEligibility({ teacherId: null, window, history: [change("2026-09-28T00:00:00Z", "live", [TUTOR])] }).tutorOffAtWindowEnd).toBe(false);
  });

  it("judges by the switches during the class's own window, not today's", () => {
    // Off for the whole window, switched live only afterwards: not workable.
    const offThenLive = [change("2026-09-28T00:00:00Z", "off"), change("2026-10-02T00:00:00Z", "live")];
    expect(postingWindowEligibility({ teacherId: TUTOR, window, history: offThenLive })).toMatchObject({ workable: false, tutorOffThroughout: false });
    // Live at some point of the window: workable, even if off since.
    const liveThenOff = [change("2026-09-28T00:00:00Z", "live"), change("2026-09-29T02:00:00Z", "off"), change("2026-09-30T00:00:00Z", "live"), change("2026-09-30T01:00:00Z", "off")];
    expect(postingWindowEligibility({ teacherId: TUTOR, window, history: liveThenOff }).workable).toBe(true);
    // The tutor was switched off whenever the mode was live.
    const tutorOff = [change("2026-09-28T00:00:00Z", "live", [TUTOR])];
    expect(postingWindowEligibility({ teacherId: TUTOR, window, history: tutorOff })).toMatchObject({ workable: false, tutorOffThroughout: true });
    // Switched off only after the window: still workable.
    const offLater = [change("2026-09-28T00:00:00Z", "live"), change("2026-10-05T00:00:00Z", "live", [TUTOR])];
    expect(postingWindowEligibility({ teacherId: TUTOR, window, history: offLater }).workable).toBe(true);
  });

  it("counts an unseen class only while its account was on the roster", () => {
    const history = [change("2026-09-28T00:00:00Z", "live")];
    const joinedLater = { firstSeenAt: at("2026-10-03T00:00:00Z"), lastSeenAt: at("2026-10-05T00:00:00Z") };
    expect(postingWindowEligibility({ teacherId: TUTOR, window, history, roster: joinedLater })).toMatchObject({ onRoster: false, workable: false });
    const joinedMidWindow = { firstSeenAt: at("2026-09-30T00:00:00Z"), lastSeenAt: at("2026-10-05T00:00:00Z") };
    expect(postingWindowEligibility({ teacherId: TUTOR, window, history, roster: joinedMidWindow })).toMatchObject({ onRoster: true, workable: true });
    const leftBefore = { firstSeenAt: at("2026-09-01T00:00:00Z"), lastSeenAt: new Date(window.start.getTime() - ROSTER_SIGHTING_SLACK_MS - 1) };
    expect(postingWindowEligibility({ teacherId: TUTOR, window, history, roster: leftBefore }).onRoster).toBe(false);
    expect(postingWindowEligibility({ teacherId: TUTOR, window, history, roster: null }).onRoster).toBe(false);
  });
});

// The sweep (:08/:22/:38/:52, skipped while the mode is `off`) stamps `tutor_off_at_deadline` from the switches when it
// runs; coverage must judge the hand-back by the control history as the class's window closed, never by a later switch.
describe("a deadline hand-back (tutor_off_at_deadline)", () => {
  const TUTOR = "tutor-a";
  const at = (iso: string) => new Date(iso);
  // A class ending 19:00 Bangkok on 29 Sep: its posting window closes at 23:29:59.999 Bangkok on 1 Oct.
  const window = { start: at("2026-09-29T12:00:00Z"), end: at("2026-10-01T16:29:59.999Z") };
  const change = (iso: string, mode: ControlStateChange["mode"], disabledTutors: string[] = []): ControlStateChange =>
    ({ changedAt: at(iso), mode, disabledTutors });
  const handBack = (history: ControlStateChange[]) => classifyCoverage({
    state: "skipped_scope",
    reason: "tutor_off_at_deadline",
    eligibility: postingWindowEligibility({ teacherId: TUTOR, window, history }),
    windowClosed: true,
  });

  it("is a miss when the tutor was switched off only after the window closed", () => {
    // Live and on all window; switched off five minutes after it closed, handed back by the :38 sweep.
    expect(handBack([change("2026-09-20T00:00:00Z", "live"), change("2026-10-01T16:35:00Z", "live", [TUTOR])])).toBe("miss_expired");
    // The mode set off after the window (the sweep waits), the tutor switched off, then live again.
    expect(handBack([
      change("2026-09-20T00:00:00Z", "live"), change("2026-10-01T17:00:00Z", "off"),
      change("2026-10-02T01:00:00Z", "off", [TUTOR]), change("2026-10-02T02:00:00Z", "live", [TUTOR]),
    ])).toBe("miss_expired");
    // Nothing recorded before the window closed: nothing shows the tutor off then (fail-closed).
    expect(handBack([change("2026-10-02T00:00:00Z", "live", [TUTOR])])).toBe("miss_expired");
  });

  it("is left out when the tutor was switched off before the window closed, however long it was workable (D-03)", () => {
    expect(handBack([change("2026-09-20T00:00:00Z", "live"), change("2026-10-01T16:00:00Z", "live", [TUTOR])])).toBe("excluded_tutor_off");
    // Switched off at the window's last instant.
    expect(handBack([change("2026-09-20T00:00:00Z", "live"), change("2026-10-01T16:29:59.999Z", "live", [TUTOR])])).toBe("excluded_tutor_off");
    // Switched off, then the mode set off too, before the window closed.
    expect(handBack([
      change("2026-09-20T00:00:00Z", "live"), change("2026-10-01T10:00:00Z", "live", [TUTOR]), change("2026-10-01T12:00:00Z", "off", [TUTOR]),
    ])).toBe("excluded_tutor_off");
  });

  it("with the mode not live as the window closed and the tutor on, is judged like the expiry it replaced", () => {
    // Never live during the window: the switches never let us write it — left out, like any such class.
    expect(handBack([change("2026-09-20T00:00:00Z", "off"), change("2026-10-02T00:00:00Z", "live", [TUTOR])])).toBe("excluded_not_live");
    expect(handBack([change("2026-09-20T00:00:00Z", "shadow"), change("2026-10-01T16:35:00Z", "shadow", [TUTOR])])).toBe("excluded_not_live");
    // Live and on for part of the window, mode off before it closed: workable, and the same class left to expire is a
    // miss — a tutor switch made after the window closed never turns it into an exclusion.
    const liveThenOff = [change("2026-09-20T00:00:00Z", "live"), change("2026-10-01T10:00:00Z", "off")];
    expect(handBack([...liveThenOff, change("2026-10-02T00:00:00Z", "live", [TUTOR])])).toBe("miss_expired");
    expect(classifyCoverage({
      state: "expired", reason: "deadline_passed_or_too_close", windowClosed: true,
      eligibility: postingWindowEligibility({ teacherId: TUTOR, window, history: liveThenOff }),
    })).toBe("miss_expired");
  });
});

describe("tutorWroteFirst", () => {
  it("needs a recorded save before our first writer call (successful or not)", () => {
    const started = new Date("2026-09-29T13:40:00Z");
    // The tutor wrote while we were still waiting for the evidence.
    expect(tutorWroteFirst({ firstWriterCallAt: null, firstHumanSaveAt: new Date("2026-09-29T13:30:00Z") })).toBe(true);
    expect(tutorWroteFirst({ firstWriterCallAt: started, firstHumanSaveAt: new Date("2026-09-29T13:30:00Z") })).toBe(true);
    // We had started (a draft, or a writer outage): the tutor's later save is our miss.
    expect(tutorWroteFirst({ firstWriterCallAt: started, firstHumanSaveAt: new Date("2026-09-29T14:30:00Z") })).toBe(false);
    // A save not mirrored yet cannot prove anything: a miss until it is.
    expect(tutorWroteFirst({ firstWriterCallAt: started, firstHumanSaveAt: null })).toBe(false);
    expect(tutorWroteFirst({ firstWriterCallAt: null, firstHumanSaveAt: null })).toBe(false);
  });
});

describe("ATTEMPT_AT_PATTERN (the `attemptAt` of a call record that may be cast to a time)", () => {
  const pattern = new RegExp(ATTEMPT_AT_PATTERN);

  it("matches the time our records write (Date#toISOString) on every day of a year, leap or not", () => {
    for (const year of [2000, 2024, 2026, 2099]) {
      for (let day = Date.UTC(year, 0, 1); day < Date.UTC(year + 1, 0, 1); day += 86_400_000) {
        const written = new Date(day + 45_296_789).toISOString();
        if (!pattern.test(written)) throw new Error(`not matched: ${written}`);
      }
    }
    expect(pattern.test("2026-09-30T00:00:00.000Z")).toBe(true);
    expect(pattern.test("2026-09-30T23:59:59.999Z")).toBe(true);
    expect(pattern.test("2028-02-29T12:40:00Z")).toBe(true);
  });

  it("matches nothing else: no other form, and no day or time that does not exist (the cast would fail)", () => {
    const malformed = [
      "", "not a time", "null", "12345", "{}", "2026-09-30", "2026-09-30 12:40:00+00", "2026-09-30T12:40:00.000+07:00",
      "2026-09-30T12:40:00.000", " 2026-09-30T12:40:00.000Z", "2026-09-30T12:40:00.000Z ", "2026-09-30T12:40:00.000Z; select 1",
      "2026-13-01T00:00:00.000Z", "2026-00-10T00:00:00.000Z", "2026-09-00T00:00:00.000Z", "2026-02-30T10:00:00.000Z",
      "2026-04-31T10:00:00.000Z", "2026-09-31T10:00:00.000Z", "2027-02-29T10:00:00.000Z", "2026-09-30T24:00:00.000Z",
      "2026-09-30T12:60:00.000Z", "2026-09-30T12:40:60.000Z", "1999-12-31T23:59:59.000Z", "0000-01-01T00:00:00.000Z",
      "2100-02-29T00:00:00.000Z", "99999-01-01T00:00:00.000Z",
    ];
    for (const value of malformed) expect(pattern.test(value), JSON.stringify(value)).toBe(false);
  });
});

describe("downgradeOf", () => {
  const approve = { verdict: "approve" as const, severity: null };
  const needsFix = (severity: "cosmetic" | "factual" | "critical") => ({ verdict: "needs_fix" as const, severity });
  it("calls any milder verdict on a major or critical judgement a downgrade, and nothing else", () => {
    expect(downgradeOf({ current: needsFix("critical"), openCriticalFlag: false, next: approve })).toBe("critical");
    expect(downgradeOf({ current: needsFix("critical"), openCriticalFlag: false, next: needsFix("factual") })).toBe("critical");
    expect(downgradeOf({ current: needsFix("critical"), openCriticalFlag: false, next: needsFix("critical") })).toBeNull();
    expect(downgradeOf({ current: needsFix("factual"), openCriticalFlag: false, next: approve })).toBe("factual");
    expect(downgradeOf({ current: needsFix("factual"), openCriticalFlag: false, next: needsFix("cosmetic") })).toBe("factual");
    expect(downgradeOf({ current: needsFix("factual"), openCriticalFlag: false, next: needsFix("factual") })).toBeNull();
    expect(downgradeOf({ current: needsFix("cosmetic"), openCriticalFlag: false, next: approve })).toBeNull();
    expect(downgradeOf({ current: null, openCriticalFlag: true, next: needsFix("factual") })).toBe("critical");
    expect(downgradeOf({ current: null, openCriticalFlag: false, next: approve })).toBeNull();
  });
});

describe("measured fixes", () => {
  const approvedAt = new Date("2026-09-30T10:00:00Z");
  it("count saves after our first post up to the owner's current Approve", () => {
    const before = { countsAsFix: true, eventAt: new Date("2026-09-30T09:00:00Z") };
    const after = { countsAsFix: true, eventAt: new Date("2026-10-02T09:00:00Z") };
    expect(countsTowardFix(before, { verdict: "approve", createdAt: approvedAt })).toBe(true);
    expect(countsTowardFix(after, { verdict: "approve", createdAt: approvedAt })).toBe(false);
    expect(countsTowardFix(after, { verdict: "needs_fix", createdAt: approvedAt })).toBe(true);
    expect(countsTowardFix(after, null)).toBe(true);
    expect(countsTowardFix({ countsAsFix: false, eventAt: before.eventAt }, null)).toBe(false);
  });

  it("put a class in a fix-round bucket only once the owner approved it", () => {
    expect(fixRoundBucket({ verdict: "approve" }, 0)).toBe("zero");
    expect(fixRoundBucket({ verdict: "approve" }, 1)).toBe("one");
    expect(fixRoundBucket({ verdict: "approve" }, 2)).toBe("two");
    expect(fixRoundBucket({ verdict: "approve" }, 5)).toBe("threePlus");
    expect(fixRoundBucket({ verdict: "needs_fix" }, 1)).toBe("unresolved");
    expect(fixRoundBucket(null, 0)).toBe("unresolved");
  });
});

describe("floorPercent", () => {
  it("rounds a measured ratio down, so it never reads as a threshold it missed", () => {
    expect(floorPercent(wilsonLowerBound(87, 99))).toBe("79.9%");
    expect(floorPercent(0.8)).toBe("80%");
    expect(floorPercent(0.7225)).toBe("72.2%");
    expect(floorPercent(0.29)).toBe("29%");
  });
});

describe("evaluateGate", () => {
  it("passes with LB ≥ 80%, no critical, coverage ≥ 70% and no pending flagged review", () => {
    const result = evaluateGate(gate());
    expect(result.status).toBe("pass");
    expect(result.reasons).toEqual([]);
  });

  it("reports insufficient data when nothing was reviewed", () => {
    expect(evaluateGate(gate({ reviewed: 0, accurate: 0 })).status).toBe("insufficient_data");
  });

  it("blocks on a critical verdict or an unresolved critical flag, whatever the accuracy", () => {
    expect(evaluateGate(gate({ criticalVerdicts: 1 })).status).toBe("blocked_critical");
    expect(evaluateGate(gate({ unresolvedCriticalFlags: 1, reviewed: 0, accurate: 0 })).status).toBe("blocked_critical");
  });

  it("gives the head start at LB ≥ 70% but not a pass below 80%", () => {
    expect(evaluateGate(gate({ reviewed: 10, accurate: 10 })).status).toBe("head_start");
    expect(evaluateGate(gate({ reviewed: 8, accurate: 8 })).status).toBe("below_head_start");
  });

  it("does not pass while a flagged post waits for review, or with coverage under 70%", () => {
    const flagged = evaluateGate(gate({ pendingFlaggedReviews: 1 }));
    expect(flagged.status).toBe("head_start");
    expect(flagged.reasons).toContain("1 flagged post(s) waiting for review");
    expect(evaluateGate(gate({ coverageNum: 6, coverageDen: 10 })).status).toBe("head_start");
    expect(evaluateGate(gate({ coverageNum: 0, coverageDen: 0 })).status).toBe("head_start");
  });

  it("does not pass on a hand-picked subset: 16/16 reviewed with one required post still unreviewed is a head start", () => {
    expect(evaluateGate(gate({ reviewed: 16, accurate: 16 })).status).toBe("pass");
    const pending = evaluateGate(gate({ reviewed: 16, accurate: 16, requiredPending: 1 }));
    expect(pending.status).toBe("head_start");
    expect(pending.reasons).toContain("1 required post(s) not yet reviewed");
  });

  it("does not pass while a posted class's first shot is not recorded", () => {
    const result = evaluateGate(gate({ unrecordedPosts: 2 }));
    expect(result.status).toBe("head_start");
    expect(result.reasons).toContain("2 posted class(es) whose first shot is not recorded yet");
  });

  it("blocks on an API write to Wise no post explains until the owner acknowledges it", () => {
    const result = evaluateGate(gate({ unexplainedApiWrites: 1 }));
    expect(result.status).toBe("blocked_critical");
    expect(result.reasons).toContain("1 API write(s) to Wise no post explains, not acknowledged");
  });

  it("reports a bound just under the threshold as under it (87/99 → 79.9%, head start)", () => {
    const result = evaluateGate(gate({ reviewed: 99, accurate: 87 }));
    expect(result.wilsonLower).toBeLessThan(0.8);
    expect(result.status).toBe("head_start");
    expect(result.reasons).toContain("accuracy lower bound 79.9% < 80% (87/99)");
  });
});

describe("computeGateFacts", () => {
  const window = { start: "2026-09-17", end: "2026-09-30" };
  it("counts required reviews with verdicts only, criticals whatever the sampling, pending required posts, and coverage", () => {
    const facts = computeGateFacts({
      window,
      unresolvedCriticalFlags: 0,
      unrecordedPosts: 1,
      unexplainedApiWrites: 2,
      reviews: [
        { bangkokDate: "2026-09-29", inclusionReason: "new_tutor", verdict: { verdict: "approve", severity: null }, hasOpenFlag: false },
        { bangkokDate: "2026-09-29", inclusionReason: "new_tutor", verdict: { verdict: "needs_fix", severity: "factual" }, hasOpenFlag: false },
        { bangkokDate: "2026-09-29", inclusionReason: "new_tutor", verdict: null, hasOpenFlag: true },
        // A voluntary review of a post that was not sampled never counts toward accuracy …
        { bangkokDate: "2026-09-29", inclusionReason: "not_sampled", verdict: { verdict: "approve", severity: null }, hasOpenFlag: false },
        // … but a critical one still blocks.
        { bangkokDate: "2026-09-30", inclusionReason: "not_sampled", verdict: { verdict: "needs_fix", severity: "critical" }, hasOpenFlag: false },
        { bangkokDate: "2026-09-01", inclusionReason: "new_tutor", verdict: { verdict: "approve", severity: null }, hasOpenFlag: true },
      ],
      metrics: [
        { metricDate: "2026-09-29", tutorKey: "*", posted: 8, eligible: 9 },
        // Every class was judged by its own window, so a day's all-tutor row counts whatever the mode today.
        { metricDate: "2026-09-28", tutorKey: "*", posted: 1, eligible: 4 },
        { metricDate: "2026-09-29", tutorKey: "Mimi", posted: 6, eligible: 6 },
        { metricDate: "2026-09-01", tutorKey: "*", posted: 1, eligible: 9 },
      ],
    });
    expect(facts).toEqual({
      reviewed: 2, accurate: 1, criticalVerdicts: 1, unresolvedCriticalFlags: 0, pendingFlaggedReviews: 1,
      requiredPending: 1, unrecordedPosts: 1, unexplainedApiWrites: 2, coverageNum: 9, coverageDen: 13,
    });
  });
});

describe("reviewInclusion", () => {
  it("reviews every post of an unproven tutor (all of them in Phase 1)", () => {
    expect(PROVEN_TUTOR_KEYS.size).toBe(0);
    expect(reviewInclusion({ tutorProven: false, draw: 0.99 })).toEqual({ reason: "new_tutor", probability: 1 });
  });

  it("samples 30% of a proven tutor's posts from the stored draw", () => {
    expect(reviewInclusion({ tutorProven: true, draw: 0.29 })).toEqual({ reason: "random_sample", probability: 0.3 });
    expect(reviewInclusion({ tutorProven: true, draw: 0.3 })).toEqual({ reason: "not_sampled", probability: 0.3 });
  });
});

describe("nextExpansionSize", () => {
  it("grows by half, rounded up: 5 → 8 → 12 → 18", () => {
    const sizes = [5];
    for (let step = 0; step < 3; step += 1) sizes.push(nextExpansionSize(sizes.at(-1)!));
    expect(sizes).toEqual([5, 8, 12, 18]);
  });
});

describe("Bangkok dates", () => {
  it("keys, shifts and bounds dates in Bangkok", () => {
    expect(bangkokDateKey(new Date("2026-09-29T17:30:00Z"))).toBe("2026-09-30");
    expect(addDays("2026-10-01", -2)).toBe("2026-09-29");
    expect(bangkokDayBounds("2026-09-29")).toEqual({
      start: new Date("2026-09-28T17:00:00.000Z"), end: new Date("2026-09-29T17:00:00.000Z"),
    });
    expect(gateWindow("2026-09-30")).toEqual({ start: "2026-09-17", end: "2026-09-30" });
  });

  it("evaluates today's gate from 22:00 Bangkok, yesterday's before", () => {
    expect(dailyGateDate(new Date("2026-09-29T15:27:00Z"))).toBe("2026-09-29");
    expect(dailyGateDate(new Date("2026-09-29T14:27:00Z"))).toBe("2026-09-28");
  });

  it("recomputes every date of the next gate window and the dashboard window, never just the last few days", () => {
    // 00:27 Bangkok on D+3: the class of D expired at 23:38 on D+2 must still be recomputed.
    const afterExpiry = metricDates(new Date("2026-10-01T17:27:00Z"));
    expect(afterExpiry).toContain("2026-09-29");
    expect(afterExpiry).toHaveLength(15);
    expect(afterExpiry[0]).toBe("2026-09-18");
    expect(afterExpiry.at(-1)).toBe("2026-10-02");
    // From 22:00 the gate window ends today: 14 dates.
    expect(metricDates(new Date("2026-10-01T15:27:00Z"))).toEqual(Array.from({ length: 14 }, (_, index) => addDays("2026-09-18", index)));
  });
});

describe("buildDailyMetrics", () => {
  it("rolls classes and reviews into per-tutor rows plus the all-tutor row", () => {
    const rows = buildDailyMetrics({
      tutorKeys: ["Mimi", "Ek"],
      classes: [
        { tutorKey: "Mimi", coverage: "posted" },
        { tutorKey: "Mimi", coverage: "posted" },
        { tutorKey: "Ek", coverage: "posted" },
        { tutorKey: "Ek", coverage: "miss_held" },
        { tutorKey: "Ek", coverage: "excluded_tutor_first" },
        { tutorKey: "Ek", coverage: null },
        { tutorKey: "Mimi", coverage: "excluded_data_quality" },
        { tutorKey: "Mimi", coverage: "miss_late" },
        { tutorKey: "Ek", coverage: "excluded_not_live" },
      ],
      reviews: [
        { tutorKey: "Mimi", inclusionReason: "new_tutor", verdict: { verdict: "needs_fix", severity: "cosmetic" }, measuredFixCount: 1, correctionsVerified: 1 },
        { tutorKey: "Mimi", inclusionReason: "new_tutor", verdict: null, measuredFixCount: 0, correctionsVerified: 0 },
        { tutorKey: "Ek", inclusionReason: "new_tutor", verdict: { verdict: "needs_fix", severity: "factual" }, measuredFixCount: 0, correctionsVerified: 0 },
      ],
    });
    const all = rows.find((row) => row.tutorKey === "*")!;
    expect(all).toMatchObject({
      posted: 3, required: 3, reviewed: 2, requiredPending: 1, accurate: 1, cosmetic: 1, factual: 1, critical: 0,
      eligible: 5, held: 1, excludedDataQuality: 1, late: 1, excludedTutorFirst: 1, excludedNotLive: 1, measuredFixClasses: 1, correctionsVerified: 1,
    });
    expect(rows.find((row) => row.tutorKey === "Ek")).toMatchObject({ posted: 1, eligible: 2, held: 1, excludedNotLive: 1 });
    expect(rows.map((row) => row.tutorKey)).toEqual(["Mimi", "Ek", "*"]);
  });
});

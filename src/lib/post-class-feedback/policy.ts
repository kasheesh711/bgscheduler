import {
  POST_CLASS_REQUIRED_FIELDS,
  type TimingEvidenceSource,
  type EventTimingEvidence,
  type FeedbackContentAssessment,
  type FeedbackEventEvidence,
  type FeedbackFieldAnswers,
  type FeedbackSubmitterRole,
  type FeedbackVersion,
  type FieldAssessment,
  type PostClassRequiredField,
  type SessionComplianceAssessment,
  type SessionComplianceInput,
  type SessionEligibilityInput,
  type SessionEligibilityResult,
} from "./types";

export const POST_CLASS_MIN_COMBINED_CHARACTERS = 300;
export const POST_CLASS_SHORT_FIELD_CHARACTERS = 50;

const SIMPLE_PLACEHOLDERS = new Set([
  "n/a",
  "na",
  "none",
  "nothing",
  "nil",
  "not applicable",
  "no comment",
  "no comments",
  "same as usual",
  "all good",
  "ok",
  "okay",
  "good",
  "fine",
  "done",
  "test",
  "asdf",
  "xxx",
  "tbc",
  "tbd",
  "ไม่มี",
  "ไม่มีอะไร",
  "ไม่ระบุ",
  "ไม่เกี่ยวข้อง",
  "ปกติ",
  "ดี",
  "โอเค",
  "เรียบร้อย",
  "ทดสอบ",
]);

const NO_IMPROVEMENT_PATTERNS = [
  /\bno\s+(?:further\s+)?improvements?\s+(?:(?:is|are)\s+)?(?:needed|required|necessary)\b/u,
  /\bnothing\s+(?:more\s+)?to\s+(?:improve|work\s+on)\b/u,
  /\bno\s+areas?\s+(?:need|to)\s+(?:work|improve)/u,
  /ไม่(?:มี|ต้อง)\s*(?:จุด|เรื่อง|สิ่ง)?\s*(?:ที่)?\s*(?:ต้อง)?\s*(?:ปรับปรุง|พัฒนา)/u,
];

const POSITIVE_GOAL_PATTERNS = [
  /\b(?:next|continue|focus|practi[cs]e|aim|goal|develop|improve|work\s+on|build|extend)\b/u,
  /(?:ต่อไป|เป้าหมาย|ฝึก|พัฒนา|เน้น|ควร|จะ|ต่อยอด)/u,
];

const RATIONALE_PATTERNS = [
  /\b(?:because|so\s+that|in\s+order\s+to|to\s+help|which\s+will|as\s+this)\b/u,
  /(?:เพื่อ|เพราะ|เนื่องจาก|ซึ่งจะ|จะช่วย)/u,
];

const EMPTY_FIELDS: FeedbackFieldAnswers = {
  topics: "",
  performance: "",
  improvement: "",
  homework: "",
};

export function countUnicodeCodePoints(value: string): number {
  return [...value].length;
}

export function normalizeFeedbackText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizePlaceholderText(value: string): string {
  return normalizeFeedbackText(value)
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function withoutThaiPoliteSuffix(value: string): string {
  // Strip politeness only at the end, and only for exact-placeholder
  // comparison. A substantive sentence that merely contains these tokens is
  // left intact and continues through the normal language checks.
  return value
    .replace(/(?:\s*(?:นะ)?(?:ครับ|ค่ะ|คะ|จ้า|จ้ะ))+$/u, "")
    .trim();
}

function compactPlaceholderText(value: string): string {
  return normalizeFeedbackText(value).replace(/[\p{P}\p{S}\s]+/gu, "");
}

function isRepeatedKnownPlaceholder(value: string): boolean {
  const normalized = normalizeFeedbackText(value);
  const compact = compactPlaceholderText(normalized);
  for (const placeholder of SIMPLE_PLACEHOLDERS) {
    const unit = compactPlaceholderText(placeholder);
    if (!unit || compact.length < unit.length * 2 || compact.length % unit.length !== 0) continue;
    if (unit.repeat(compact.length / unit.length) === compact) return true;
  }

  const tokens = normalized
    .split(/\s+/u)
    .map(normalizePlaceholderText)
    .filter(Boolean);
  for (let unitLength = 1; unitLength <= Math.floor(tokens.length / 2); unitLength += 1) {
    if (tokens.length % unitLength !== 0) continue;
    const unit = tokens.slice(0, unitLength);
    const repeats = tokens.every((token, index) => token === unit[index % unitLength]);
    if (!repeats) continue;
    const phrase = unit.join(" ");
    const compactPhrase = compactPlaceholderText(phrase);
    if (
      SIMPLE_PLACEHOLDERS.has(phrase) ||
      SIMPLE_PLACEHOLDERS.has(withoutThaiPoliteSuffix(phrase)) ||
      compactPhrase === "na" ||
      compactPhrase === "notapplicable"
    ) return true;
  }
  return false;
}

function isLowDiversityRepeatedText(value: string): boolean {
  const normalized = normalizeFeedbackText(value);
  const tokens = normalized
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens.length >= 8) {
    const uniqueTokenRatio = new Set(tokens).size / tokens.length;
    if (uniqueTokenRatio <= 0.25) return true;
    // Catch a repeated multi-token phrase even when its words are individually
    // diverse enough to evade the ratio check.
    for (let unitLength = 1; unitLength <= Math.min(8, Math.floor(tokens.length / 2)); unitLength += 1) {
      if (tokens.length % unitLength !== 0) continue;
      if (tokens.every((token, index) => token === tokens[index % unitLength])) return true;
    }
  }

  // Thai feedback often has no word-separating spaces. Detect an exact long
  // periodic unit after removing separators, without penalizing ordinary
  // prose that merely repeats terminology a few times.
  const compact = [...normalized.replace(/[^\p{L}\p{M}\p{N}]/gu, "")];
  if (compact.length < 24) return false;
  const compactText = compact.join("");
  for (let unitLength = 1; unitLength <= Math.min(32, Math.floor(compact.length / 3)); unitLength += 1) {
    if (compact.length % unitLength !== 0) continue;
    const unit = compact.slice(0, unitLength).join("");
    if (unit.repeat(compact.length / unitLength) === compactText) return true;
  }
  return false;
}

function isLowInformationGibberish(value: string): boolean {
  const languageCharacters = [...normalizeFeedbackText(value).replace(/[^\p{L}\p{M}]/gu, "")];
  if (languageCharacters.length < 8) return false;
  const counts = new Map<string, number>();
  for (const character of languageCharacters) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  if (counts.size <= 2) return true;
  const highestFrequency = Math.max(...counts.values());
  return highestFrequency / languageCharacters.length >= 0.85;
}

export function containsNoImprovementClaim(value: string): boolean {
  const normalized = normalizeFeedbackText(value);
  return NO_IMPROVEMENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasPositiveGoalAndRationale(value: string): boolean {
  const normalized = normalizeFeedbackText(value);
  return POSITIVE_GOAL_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    RATIONALE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isPlaceholderFeedback(value: string): boolean {
  const normalized = normalizePlaceholderText(value);
  if (!normalized) return true;
  if (SIMPLE_PLACEHOLDERS.has(normalized) ||
    SIMPLE_PLACEHOLDERS.has(withoutThaiPoliteSuffix(normalized))) return true;
  if (
    isRepeatedKnownPlaceholder(normalized) ||
    isLowDiversityRepeatedText(normalized) ||
    isLowInformationGibberish(normalized)
  ) return true;
  const compactLatin = normalized.replace(/[\s./\\_-]+/gu, "");
  if (compactLatin === "na" || compactLatin === "notapplicable") return true;
  if (containsNoImprovementClaim(value)) {
    return !hasPositiveGoalAndRationale(value);
  }
  // Compliance text must contain actual English/Latin or Thai language, not
  // only numbers, symbols, emoji, or an unrelated script.
  return !/[\p{Script=Latin}\p{Script=Thai}]/u.test(normalized);
}

export function assessRequiredField(
  field: PostClassRequiredField,
  value: string,
): FieldAssessment {
  const empty = normalizeFeedbackText(value).length === 0;
  const noImprovementClaim = containsNoImprovementClaim(value);
  const positiveGoalAndRationale = noImprovementClaim
    ? hasPositiveGoalAndRationale(value)
    : false;
  const placeholder = !empty && isPlaceholderFeedback(value);
  const failures: FieldAssessment["failures"] = [];
  if (empty) failures.push("empty");
  if (placeholder) failures.push("placeholder");
  if (noImprovementClaim && !positiveGoalAndRationale) {
    failures.push("no_goal_or_rationale");
  }

  return {
    field,
    rawCharacterCount: countUnicodeCodePoints(value),
    meaningful: failures.length === 0,
    placeholder,
    noImprovementClaim,
    hasPositiveGoalAndRationale: positiveGoalAndRationale,
    failures,
  };
}

export function assessFeedbackContent(
  fields: Partial<FeedbackFieldAnswers>,
): FeedbackContentAssessment {
  const values: FeedbackFieldAnswers = { ...EMPTY_FIELDS, ...fields };
  const fieldAssessments = Object.fromEntries(
    POST_CLASS_REQUIRED_FIELDS.map((field) => [
      field,
      assessRequiredField(field, values[field]),
    ]),
  ) as Record<PostClassRequiredField, FieldAssessment>;
  const combinedRawCharacterCount = POST_CLASS_REQUIRED_FIELDS.reduce(
    (total, field) => total + countUnicodeCodePoints(values[field]),
    0,
  );
  const failedFields = POST_CLASS_REQUIRED_FIELDS.filter(
    (field) => !fieldAssessments[field].meaningful,
  );
  const nonEmptyCount = POST_CLASS_REQUIRED_FIELDS.filter(
    (field) => normalizeFeedbackText(values[field]).length > 0,
  ).length;
  const failureReasons = [
    ...failedFields.map((field) => `${field}:${fieldAssessments[field].failures.join("+")}`),
    ...(combinedRawCharacterCount < POST_CLASS_MIN_COMBINED_CHARACTERS
      ? [`combined_characters:${combinedRawCharacterCount}/${POST_CLASS_MIN_COMBINED_CHARACTERS}`]
      : []),
  ];

  return {
    compliant:
      failedFields.length === 0 &&
      combinedRawCharacterCount >= POST_CLASS_MIN_COMBINED_CHARACTERS,
    contentStatus:
      nonEmptyCount === 0 ? "blank" : "substantive",
    combinedRawCharacterCount,
    fields: fieldAssessments,
    failedFields,
    failureReasons,
  };
}

/**
 * Returns 23:59:59.999 Asia/Bangkok on the second calendar day after the
 * session's Bangkok scheduled-end date. Thailand is permanently UTC+07:00.
 */
export function calculateFeedbackDeadline(scheduledEndAt: Date): Date {
  if (Number.isNaN(scheduledEndAt.getTime())) {
    throw new Error("A valid scheduled end time is required");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(scheduledEndAt);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  // 23:59:59.999 at UTC+07:00 is 16:59:59.999 UTC.
  return new Date(Date.UTC(year, month - 1, day + 2, 16, 59, 59, 999));
}

/**
 * Classify the actor Wise recorded on a feedback activity event.
 *
 * `autoSubmitted` wins over the actor role: Wise emits auto-submissions with
 * no actor object at all, so an auto event can never be tutor-authored.
 */
export function feedbackSubmitterRole(event: FeedbackEventEvidence): FeedbackSubmitterRole {
  if (event.autoSubmitted === true) return "AUTO";
  const role = event.actorRole?.trim().toUpperCase();
  if (role === "TEACHER" || role === "ADMIN" || role === "STUDENT") return role;
  return "UNKNOWN";
}

/**
 * Derive timing from the immutable Wise activity-event stream.
 *
 * The event store is the only evidence of *when* feedback was written — session
 * detail records a tutor, an admin, and a Wise auto-submission all alike as
 * `profile: "teacher"`, and Wise rarely returns a trustworthy `updatedAt`.
 *
 * **D-EVT-04 — the actor role is not an authorship gate.** Wise stamps
 * `actorRole` from the *account's* role, not from who wrote the text: a tutor
 * who also holds an admin account submits their own feedback and Wise records
 * `ADMIN`. Gating on `TEACHER` therefore discarded genuine pre-deadline tutor
 * submissions and proved lateness against them. Any human-actor event now
 * qualifies; `submitterRoles` still records every role observed, so who
 * submitted stays fully auditable even though it no longer changes the verdict.
 *
 * Steps:
 *  1. A qualifying event is any event Wise did not auto-submit.
 *  2. Earliest qualifying event at or before the deadline proves `on_time`.
 *  3. No qualifying event, with the deadline inside event coverage, proves `late`.
 *  4. A deadline predating the coverage floor proves nothing (fail closed to
 *     `unknown`) — the events were never collected, so their absence is not
 *     evidence of tutor inaction.
 */
export function deriveEventTimingEvidence(input: {
  events: FeedbackEventEvidence[];
  deadlineAt: Date;
  eventCoverageFrom: Date | null;
}): EventTimingEvidence {
  const { events, deadlineAt, eventCoverageFrom } = input;
  const submitterRoles = [...new Set(events.map(feedbackSubmitterRole))].toSorted();

  const qualifying = events
    .filter((event) => feedbackSubmitterRole(event) !== "AUTO")
    .toSorted((left, right) => left.eventTimestamp.getTime() - right.eventTimestamp.getTime());

  const provenOnTime = qualifying.find((event) => event.eventTimestamp.getTime() <= deadlineAt.getTime());
  if (provenOnTime) {
    return {
      status: "on_time",
      provenAt: provenOnTime.eventTimestamp,
      submitterRoles,
      source: "activity_event",
      coverageFrom: eventCoverageFrom,
    };
  }

  // Absence of a tutor event only proves lateness where the event store
  // actually covers the deadline. D-EVT-01.
  const covered = Boolean(eventCoverageFrom && deadlineAt.getTime() >= eventCoverageFrom.getTime());
  if (covered) {
    return {
      status: "late",
      provenAt: qualifying[0]?.eventTimestamp ?? null,
      submitterRoles,
      source: "activity_event",
      coverageFrom: eventCoverageFrom,
    };
  }

  return {
    status: "unknown",
    provenAt: null,
    submitterRoles,
    source: "none",
    coverageFrom: eventCoverageFrom,
  };
}

export function evaluateSessionEligibility(
  input: SessionEligibilityInput,
): SessionEligibilityResult {
  const normalizeStatus = (value: string | null | undefined) =>
    value?.trim().toUpperCase().replace(/[\s-]+/gu, "_") ?? "";
  const isMissedStatus = (value: string) =>
    value === "MISSED" ||
    value === "NO_SHOW" ||
    value === "NOSHOW" ||
    value === "STUDENT_MISSED" ||
    value === "MISSED_BY_STUDENT";
  const isCancelledStatus = (value: string) =>
    value === "CANCELLED" || value === "CANCELED";
  const status = normalizeStatus(input.meetingStatus);
  const attendanceEvidence = [
    input.meetingStatus,
    input.attendanceStatus,
    ...(input.submissionSessionStatuses ?? []),
  ].map(normalizeStatus);
  if (attendanceEvidence.some(isCancelledStatus)) {
    return { status: "ineligible", eligible: false, reason: "cancelled" };
  }
  if (attendanceEvidence.some(isMissedStatus)) {
    return { status: "ineligible", eligible: false, reason: "missed_or_no_show" };
  }
  if (status !== "ENDED") {
    return { status: "ineligible", eligible: false, reason: "not_ended" };
  }
  // `type` is frequently Wise's ONLINE/OFFLINE modality. Classroom
  // `classType` is the authoritative business classification when present.
  const eligibilityType = (input.classType?.trim() || input.sessionType?.trim() || "")
    .toUpperCase();
  if (eligibilityType === "OTHER") {
    return { status: "ineligible", eligible: false, reason: "excluded_session_type" };
  }
  if (
    input.complimentaryOrTrial === true ||
    eligibilityType.includes("TRIAL") ||
    eligibilityType.includes("COMPLIMENTARY")
  ) {
    return { status: "ineligible", eligible: false, reason: "complimentary_or_trial" };
  }
  if (typeof input.creditsConsumed === "number" && input.creditsConsumed > 0) {
    return { status: "eligible", eligible: true, reason: "ended_positive_credits" };
  }
  if (input.payoutEligible === true) {
    return { status: "eligible", eligible: true, reason: "ended_payout_eligible" };
  }
  const creditsKnown = typeof input.creditsConsumed === "number";
  const payoutKnown = typeof input.payoutEligible === "boolean";
  if (creditsKnown && payoutKnown) {
    return { status: "ineligible", eligible: false, reason: "non_billable" };
  }
  return {
    status: "ambiguous",
    eligible: false,
    reason: "billing_evidence_missing",
  };
}

function versionKey(version: FeedbackVersion): string {
  return version.submissionId
    ? `${version.submissionId}:${version.contentHash}`
    : version.contentHash;
}

function compareVersions(left: FeedbackVersion, right: FeedbackVersion): number {
  // Even an untrusted createdAt cannot prove when mutable content was written,
  // but it still orders distinct submissions. Observation time breaks ties for
  // mutable same-ID versions that retain one creation timestamp.
  const leftTime = left.sourceCreatedAt?.getTime() ?? left.observedAt.getTime();
  const rightTime = right.sourceCreatedAt?.getTime() ?? right.observedAt.getTime();
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.observedAt.getTime() - right.observedAt.getTime();
}

function emptyContentAssessment(contentStatus: "missing" | "blank" = "missing") {
  const assessed = assessFeedbackContent(EMPTY_FIELDS);
  return { ...assessed, contentStatus };
}

function isSubstantiveVersion(version: FeedbackVersion): boolean {
  return assessFeedbackContent(version.fields).contentStatus === "substantive";
}

function trustedVersionTime(version: FeedbackVersion): Date | null {
  if (version.sourceTimestampTrustworthy && version.sourceCreatedAt) {
    return version.sourceCreatedAt;
  }
  return null;
}

function versionProvesLate(version: FeedbackVersion, deadlineAt: Date): boolean {
  const sourceTime = version.sourceCreatedAt;
  if (!sourceTime) return false;
  if (version.sourceTimestampTrustworthy) return sourceTime.getTime() > deadlineAt.getTime();
  // createdAt may not prove unchanged content, but a submission first created
  // after the deadline could not have contained any on-time content.
  return version.sourceTimestampKind === "created" &&
    sourceTime.getTime() > deadlineAt.getTime();
}

export function evaluateSessionCompliance(
  input: SessionComplianceInput,
): SessionComplianceAssessment {
  const deadlineAt = calculateFeedbackDeadline(input.scheduledEndAt);
  const due = input.now.getTime() >= deadlineAt.getTime();
  const policyApplies = Boolean(
    input.policyEffectiveAt &&
    input.scheduledEndAt.getTime() >= input.policyEffectiveAt.getTime(),
  );
  const teacherVersions = input.versions
    .filter((version) =>
      version.profile?.trim().toLocaleLowerCase("en-US") === "teacher")
    .sort(compareVersions);
  const substantive = teacherVersions.filter(isSubstantiveVersion);
  const governingVersion = substantive.at(-1) ?? null;
  const content = governingVersion
    ? assessFeedbackContent(governingVersion.fields)
    : emptyContentAssessment(teacherVersions.length > 0 ? "blank" : "missing");

  const sourceReady = input.sourceStatus === "ready";
  const scopedLockRequired = input.policyVersion !== undefined &&
    input.mappingVersion !== undefined;
  const previousLock = input.previousOnTimeLock && (
    !scopedLockRequired ||
    (
      input.previousOnTimeLock.policyVersion === input.policyVersion &&
      input.previousOnTimeLock.mappingVersion === input.mappingVersion &&
      input.previousOnTimeLock.scheduledEndAt?.getTime() === input.scheduledEndAt.getTime() &&
      input.previousOnTimeLock.deadlineAt?.getTime() === deadlineAt.getTime()
    )
  )
    ? input.previousOnTimeLock
    : null;
  const eventTiming = input.eventTiming ?? null;
  // Observation and enforcement are separate. Sessions ending before the
  // policy effective instant are still assessed and scored so historical
  // timeliness is visible, but they can never create a deduction. D-EVT-03.
  const enforcementActive = input.enforcementMode === "live" && policyApplies;
  const assessmentBase = {
    sourceStatus: input.sourceStatus,
    contentStatus: content.contentStatus,
    deadlineAt,
    governingVersionKey: governingVersion ? versionKey(governingVersion) : null,
    content,
    due,
    policyApplies,
    timingEvidenceSource: "none" as TimingEvidenceSource,
    submitterRoles: eventTiming?.submitterRoles ?? [],
    tutorSubmittedAt: eventTiming?.provenAt ?? null,
  };

  // A broken source or a paused feature suspends assessment outright. Being
  // outside the enforcement window does not: those sessions still flow through
  // so historical timeliness is observable, with every enforcement output
  // neutralised by `enforcementActive`.
  if (!sourceReady || input.enforcementMode === "paused") {
    return {
      ...assessmentBase,
      timingStatus: due ? "unknown" : "not_due",
      onTimeVersionKey: previousLock?.versionKey ?? null,
      onTimeComplianceLocked: previousLock?.locked ?? false,
      assessed: false,
      rawOnTimeCompliant: false,
      adjustedCompliant: false,
      violation: false,
      remediatedLate: false,
      deductionCandidate: false,
    };
  }

  if (previousLock?.locked) {
    return {
      ...assessmentBase,
      timingStatus: "on_time",
      onTimeVersionKey: previousLock.versionKey,
      onTimeComplianceLocked: true,
      assessed: true,
      rawOnTimeCompliant: true,
      adjustedCompliant: true,
      violation: false,
      remediatedLate: false,
      deductionCandidate: false,
    };
  }

  // A Wise activity event is immutable server-side proof of when the feedback
  // was submitted, and the only evidence that separates a human submission from
  // a Wise auto-submission. It therefore
  // outranks the mutable submission timestamps below, and — like any newly
  // discovered pre-deadline proof — can clear a prior violation lock. D-EVT-02.
  if (eventTiming?.status === "on_time") {
    const onTimeBase = {
      ...assessmentBase,
      timingStatus: "on_time" as const,
      timingEvidenceSource: "activity_event" as TimingEvidenceSource,
    };
    // Timing and content stay independent: proving the tutor submitted on time
    // does not excuse feedback that fails the objective content bar.
    if (governingVersion && content.compliant) {
      return {
        ...onTimeBase,
        onTimeVersionKey: versionKey(governingVersion),
        onTimeComplianceLocked: true,
        assessed: true,
        rawOnTimeCompliant: true,
        adjustedCompliant: true,
        violation: false,
        remediatedLate: false,
        deductionCandidate: false,
      };
    }
    return {
      ...onTimeBase,
      onTimeVersionKey: null,
      onTimeComplianceLocked: false,
      assessed: due,
      rawOnTimeCompliant: false,
      adjustedCompliant: false,
      violation: due,
      remediatedLate: false,
      deductionCandidate: due && enforcementActive,
    };
  }

  // Event-derived lateness is only meaningful once the deadline has passed —
  // before that, a missing tutor event just means the tutor has not written it
  // yet. Coverage-floor gating already happened in deriveEventTimingEvidence.
  if (due && eventTiming?.status === "late") {
    return {
      ...assessmentBase,
      timingStatus: "late",
      timingEvidenceSource: "activity_event",
      onTimeVersionKey: null,
      onTimeComplianceLocked: false,
      assessed: true,
      rawOnTimeCompliant: false,
      adjustedCompliant: false,
      violation: true,
      remediatedLate: Boolean(governingVersion && content.compliant),
      deductionCandidate: enforcementActive,
    };
  }

  // Only a trustworthy Wise source timestamp proves raw on-time completion.
  // Observation time is retained as evidence, but it cannot manufacture a
  // source timestamp that Wise did not provide.
  const preDeadlineVersions = substantive.filter((version) => {
    const trusted = trustedVersionTime(version);
    return Boolean(trusted && trusted.getTime() <= deadlineAt.getTime());
  });
  const provenOnTimeVersion = preDeadlineVersions
    .filter((version) => assessFeedbackContent(version.fields).compliant)
    .at(-1) ?? null;
  if (provenOnTimeVersion) {
    return {
      ...assessmentBase,
      timingStatus: "on_time",
      timingEvidenceSource: "source_timestamp",
      onTimeVersionKey: versionKey(provenOnTimeVersion),
      onTimeComplianceLocked: true,
      assessed: true,
      rawOnTimeCompliant: true,
      adjustedCompliant: true,
      violation: false,
      remediatedLate: false,
      deductionCandidate: false,
    };
  }

  // A canonical detail snapshot taken at/after the deadline can prove that no
  // compliant version existed then. A later untimestamped/late backfill cannot
  // erase it, but newly discovered trustworthy pre-deadline proof can.
  if (previousLock?.violationLocked) {
    const lockedTimingUnknown = Boolean(
      governingVersion &&
      !trustedVersionTime(governingVersion) &&
      !versionProvesLate(governingVersion, deadlineAt),
    );
    return {
      ...assessmentBase,
      timingStatus: lockedTimingUnknown ? "unknown" : "late",
      timingEvidenceSource: lockedTimingUnknown ? "none" : "source_timestamp",
      onTimeVersionKey: null,
      onTimeComplianceLocked: false,
      assessed: true,
      rawOnTimeCompliant: false,
      adjustedCompliant: false,
      violation: true,
      remediatedLate: Boolean(governingVersion && content.compliant),
      deductionCandidate: enforcementActive,
    };
  }

  if (!due) {
    if (governingVersion && content.compliant) {
      return {
        ...assessmentBase,
        timingStatus: "unknown",
        onTimeVersionKey: null,
        onTimeComplianceLocked: false,
        assessed: true,
        rawOnTimeCompliant: false,
        adjustedCompliant: true,
        violation: false,
        remediatedLate: false,
        deductionCandidate: false,
      };
    }
    return {
      ...assessmentBase,
      timingStatus: "not_due",
      onTimeVersionKey: null,
      onTimeComplianceLocked: false,
      assessed: false,
      rawOnTimeCompliant: false,
      adjustedCompliant: false,
      violation: false,
      remediatedLate: false,
      deductionCandidate: false,
    };
  }

  if (governingVersion && content.compliant) {
    const trusted = trustedVersionTime(governingVersion);
    const timingStatus = trusted || versionProvesLate(governingVersion, deadlineAt)
      ? "late"
      : "unknown";
    const timingUnknown = timingStatus === "unknown";
    return {
      ...assessmentBase,
      timingStatus,
      timingEvidenceSource: timingUnknown ? "none" : "source_timestamp",
      onTimeVersionKey: null,
      onTimeComplianceLocked: false,
      assessed: true,
      rawOnTimeCompliant: false,
      adjustedCompliant: timingUnknown,
      violation: !timingUnknown,
      remediatedLate: !timingUnknown,
      deductionCandidate: !timingUnknown && enforcementActive,
    };
  }

  return {
    ...assessmentBase,
    timingStatus: "late",
    onTimeVersionKey: null,
    onTimeComplianceLocked: false,
    assessed: true,
    rawOnTimeCompliant: false,
    adjustedCompliant: false,
    violation: true,
    remediatedLate: false,
    deductionCandidate: enforcementActive,
  };
}

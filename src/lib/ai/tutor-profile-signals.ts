import type { IndexedTutorGroup } from "@/lib/search/index";
import type { SearchFilters } from "@/lib/search/types";
import type {
  SchedulerBusinessRequirements,
  SchedulerSubjectIntent,
} from "@/lib/ai/scheduler-conversation";

type SignalSource = "wise" | "profile" | "notes" | "missing" | "review";

export interface TutorProfileSignal {
  label: string;
  source: SignalSource;
  score: number;
}

export interface TutorProfileSignalResult {
  score: number;
  evidence: string[];
  reviewReasons: string[];
}

export interface TutorProfileSignalInput {
  group: IndexedTutorGroup;
  filters: SearchFilters;
  subjectIntent?: SchedulerSubjectIntent;
  businessRequirements: SchedulerBusinessRequirements;
}

const ENGLISH_SUBJECTS = new Set(["english", "englishvr", "efl", "esl", "literature", "nonvr"]);

function normalize(value: string | undefined | null): string {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function profileText(group: IndexedTutorGroup): string {
  const profile = group.businessProfile;
  if (!profile) return "";
  return [
    profile.parentSafeSummary,
    profile.internalNotes,
    profile.youngLearnerNotes,
    profile.teachingStyleNotes,
    profile.studentFitNotes,
    profile.doNotUseForNotes,
    ...profile.education.flatMap((entry) => [entry.institution, entry.country, entry.program, entry.notes]),
    ...profile.languages.flatMap((entry) => [entry.language, entry.proficiency, entry.verificationSource]),
  ].filter(Boolean).join(" ");
}

function includesNormalized(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

function includesTag(values: string[] | undefined, tag: string): boolean {
  return (values ?? []).some((value) => normalize(value) === normalize(tag));
}

function matchingQualification(group: IndexedTutorGroup, filters: SearchFilters) {
  return group.qualifications.find((qualification) => {
    if (filters.subject && normalize(qualification.subject) !== normalize(filters.subject)) return false;
    if (filters.curriculum && normalize(qualification.curriculum) !== normalize(filters.curriculum)) return false;
    if (filters.level && normalize(qualification.level) !== normalize(filters.level)) return false;
    return true;
  });
}

function requestedStrengthTags(input: TutorProfileSignalInput): string[] {
  const tags = [
    ...(input.businessRequirements.strengthTags ?? []),
    ...(input.subjectIntent?.skillTags ?? []),
  ];
  const subject = normalize(input.filters.subject);
  const level = normalize(input.filters.level);
  if (subject.includes("englishvr") || subject.includes("nonvr") || level.includes("11+/13+") || level.includes("16+")) {
    tags.push("exam prep");
  }
  if (subject.includes("math")) tags.push("math problem solving");
  if (subject.includes("science")) tags.push("science concepts");
  return unique(tags);
}

function requestedCurriculumExperience(input: TutorProfileSignalInput): string[] {
  return unique([
    ...(input.businessRequirements.curriculumExperience ?? []),
    input.filters.curriculum ?? "",
  ]);
}

function requestedEnglish(input: TutorProfileSignalInput): boolean {
  return ENGLISH_SUBJECTS.has(normalize(input.filters.subject)) ||
    input.subjectIntent?.family === "english" ||
    Boolean(input.businessRequirements.englishProficiency && input.businessRequirements.englishProficiency !== "unknown");
}

function englishEvidence(group: IndexedTutorGroup): TutorProfileSignal | undefined {
  const profile = group.businessProfile;
  if (!profile || profile.englishProficiency === "unknown") return undefined;
  const rank = {
    basic: 0.25,
    conversational: 0.5,
    fluent: 0.9,
    "near-native": 1.2,
    native: 1.4,
    unknown: 0,
  }[profile.englishProficiency] ?? 0;
  return {
    label: `English proficiency: ${profile.englishProficiency}`,
    source: "profile",
    score: rank,
  };
}

function addTagSignals(input: {
  signals: TutorProfileSignal[];
  structuredValues: string[] | undefined;
  notes: string;
  requested: string[];
  structuredPrefix: string;
  notesPrefix: string;
  structuredScore: number;
  notesScore: number;
}) {
  for (const tag of input.requested) {
    if (includesTag(input.structuredValues, tag)) {
      input.signals.push({
        label: `${input.structuredPrefix}: ${tag}`,
        source: "profile",
        score: input.structuredScore,
      });
    } else if (includesNormalized(input.notes, tag)) {
      input.signals.push({
        label: `${input.notesPrefix}: ${tag}`,
        source: "notes",
        score: input.notesScore,
      });
    }
  }
}

function addSchoolSignals(input: TutorProfileSignalInput, signals: TutorProfileSignal[], notes: string) {
  const keywords = input.businessRequirements.schoolKeywords ?? [];
  if (keywords.length === 0) return;
  const educationText = (input.group.businessProfile?.education ?? [])
    .flatMap((entry) => [entry.institution, entry.country, entry.program, entry.notes])
    .filter(Boolean)
    .join(" ");
  for (const keyword of keywords) {
    if (includesNormalized(educationText, keyword)) {
      signals.push({ label: `Education match: ${keyword}`, source: "profile", score: 2 });
    } else if (includesNormalized(notes, keyword)) {
      signals.push({ label: `Profile notes mention school fit: ${keyword}`, source: "notes", score: 0.8 });
    }
  }
}

function addYoungLearnerSignal(input: TutorProfileSignalInput, signals: TutorProfileSignal[]) {
  const age = input.businessRequirements.youngLearnerAge;
  const profile = input.group.businessProfile;
  if (!age || !profile) return;
  if (
    profile.youngLearnerFit === "comfortable" &&
    profile.youngestComfortableAge !== null &&
    profile.youngestComfortableAge <= age
  ) {
    signals.push({
      label: `Young learner fit: age ${age}+`,
      source: "profile",
      score: 2,
    });
  }
}

function addAvoidSignal(input: TutorProfileSignalInput, signals: TutorProfileSignal[]) {
  const note = input.group.businessProfile?.doNotUseForNotes;
  if (!note?.trim()) return;
  const requestedParts = [
    input.filters.subject,
    input.filters.curriculum,
    input.filters.level,
    input.subjectIntent?.label,
    ...(input.subjectIntent?.skillTags ?? []),
    ...(input.businessRequirements.strengthTags ?? []),
    ...(input.businessRequirements.curriculumExperience ?? []),
    ...(input.businessRequirements.teachingStyleTags ?? []),
    ...(input.businessRequirements.schoolKeywords ?? []),
  ].filter(Boolean);
  const requestedText = requestedParts.join(" ");
  const matchesRequest = Boolean(requestedText && (
    includesNormalized(note, requestedText) ||
    requestedParts.some((part) => part && includesNormalized(note, part))
  ));
  signals.push({
    label: matchesRequest ? "Profile caution matches this request" : "Profile caution note present",
    source: matchesRequest ? "review" : "notes",
    score: matchesRequest ? -6 : -1,
  });
}

export function scoreTutorProfileSignals(input: TutorProfileSignalInput): TutorProfileSignalResult {
  const signals: TutorProfileSignal[] = [];
  const profile = input.group.businessProfile;
  const notes = profileText(input.group);
  const qualification = matchingQualification(input.group, input.filters);

  if (qualification) {
    signals.push({
      label: `Wise qualification: ${[qualification.subject, qualification.curriculum, qualification.level].filter(Boolean).join(" ")}`,
      source: "wise",
      score: 3,
    });
  }

  if (requestedEnglish(input)) {
    const signal = englishEvidence(input.group);
    if (signal) signals.push(signal);
  }

  addTagSignals({
    signals,
    structuredValues: profile?.strengthTags,
    notes,
    requested: requestedStrengthTags(input),
    structuredPrefix: "Profile strength",
    notesPrefix: "Profile notes mention strength",
    structuredScore: 2,
    notesScore: 0.8,
  });

  addTagSignals({
    signals,
    structuredValues: profile?.curriculumExperience,
    notes,
    requested: requestedCurriculumExperience(input),
    structuredPrefix: "Curriculum experience",
    notesPrefix: "Profile notes mention curriculum",
    structuredScore: 1.5,
    notesScore: 0.7,
  });

  addTagSignals({
    signals,
    structuredValues: profile?.teachingStyleTags,
    notes,
    requested: input.businessRequirements.teachingStyleTags ?? [],
    structuredPrefix: "Teaching style",
    notesPrefix: "Profile notes mention teaching style",
    structuredScore: 1,
    notesScore: 0.5,
  });

  addYoungLearnerSignal(input, signals);
  addSchoolSignals(input, signals, notes);
  addAvoidSignal(input, signals);

  const evidence = unique(signals
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .map((signal) => `${signal.source}: ${signal.label}`));
  const reviewReasons = signals
    .filter((signal) => signal.source === "review")
    .map((signal) => signal.label);
  const score = signals.reduce((sum, signal) => sum + signal.score, 0);

  return {
    score,
    evidence,
    reviewReasons,
  };
}

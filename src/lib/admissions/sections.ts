// Admissions Case Management — guided self-report section forms (CM-121).
//
// Design: docs/casemanagementsystem_design.md §2.4 (self-report is the
// student-writable surface; counselor override is attributed via the audit
// actorRole), §3 (admissions_self_report_sections: one row per case per
// sectionKey, autosave writes payload), §5.2 (guided multi-step forms, 5–10
// fields per step, inline examples), §6 (section-level ownership). PRD CM-121.
//
// Core rules:
// - SECTION_DEFINITIONS is the About-You family from the SummitEd source
//   sheet (About You / Q&A Survey / Personality / Random Facts / Essay
//   Moments / Majors & Careers Reflection). Definitions are code, not data —
//   payloads are validated against them on every write (unknown keys
//   rejected, fail-closed).
// - Autosave-friendly: saveSectionDraft merges a PARTIAL payload into the
//   stored payload (only provided keys change; `null` / empty string clears
//   a key). A save with no effective change writes nothing.
// - State machine (CM-121): draft → submitted → reviewed. Submit is the ONLY
//   notify event — submitSection returns `{ notify: true }` for the route;
//   Phase 5 wires the real notification transport. An EFFECTIVE edit to a
//   submitted OR reviewed section returns it to "draft" (submittedAt /
//   reviewedByEmail cleared) with the state transition recorded in the same
//   audit row — the counselor must re-review after any change.
// - A case with no row for a section reads as an EMPTY DRAFT (getSectionState
//   virtualizes it); the row is materialized on first save. Submitting a
//   never-saved (or otherwise non-draft) section is a Conflict — there is
//   nothing to review.
//
// Error contract (admissionsErrorResponse maps these): unknown sectionKey /
// malformed caseId → Error("NotFound"); role violations → Error("Forbidden");
// state-machine violations → Error("Conflict"); payload-shape violations
// throw descriptive Errors (routes' Zod schemas are the 400 boundary).

import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsSelfReportSections } from "@/lib/db/schema";
import {
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsFieldDiff,
  type AdmissionsWriteDb,
} from "./audit";
import { roleAtLeast } from "./config";
import { isUuidShaped } from "./members";
import type { CaseAccess } from "./types";

type SectionRow = typeof admissionsSelfReportSections.$inferSelect;

// ── State union (mirrors admissions_submission_state pgEnum) ────────────

/** Section review state (mirrors admissions_submission_state). */
export type AdmissionsSubmissionState = "draft" | "submitted" | "reviewed";

/** All valid submission states, for boundary validation. */
export const ADMISSIONS_SUBMISSION_STATES: readonly AdmissionsSubmissionState[] = [
  "draft",
  "submitted",
  "reviewed",
];

// ── Definition shapes ───────────────────────────────────────────────────

/** Stable section identifiers, in student-facing display order. */
export const ADMISSIONS_SECTION_KEYS = [
  "about_you",
  "q_and_a_survey",
  "personality",
  "random_facts",
  "essay_moments",
  "majors_reflection",
] as const;

/** Stable self-report section key ("about_you" … "majors_reflection"). */
export type AdmissionsSectionKey = (typeof ADMISSIONS_SECTION_KEYS)[number];

/** Input widget for one guided-form field (design §5.2). */
export type AdmissionsSectionFieldType = "text" | "textarea" | "select" | "multiselect";

/** One field of a guided-form step; `example` renders as inline microcopy. */
export interface AdmissionsSectionField {
  /** Stable payload key (snake_case), unique within the section. */
  key: string;
  label: string;
  type: AdmissionsSectionFieldType;
  /** Allowed values for select/multiselect; absent for free-text types. */
  options?: readonly string[];
  /** Hard character cap for text/textarea (UI counters hard-stop, CM-121). */
  maxLength?: number;
  /** Short guidance rendered under the label. */
  helper: string;
  /** Optional inline example answer (design §5.2 "example microcopy"). */
  example?: string;
}

/** One step of a guided multi-step form (5–10 fields per design §5.2). */
export interface AdmissionsSectionStep {
  key: string;
  title: string;
  fields: readonly AdmissionsSectionField[];
}

/** One guided self-report section definition (CM-121). */
export interface AdmissionsSectionDefinition {
  id: AdmissionsSectionKey;
  title: string;
  description: string;
  steps: readonly AdmissionsSectionStep[];
}

// ── Section definitions (SummitEd About-You family, PRD §4.13 / CM-121) ─

/**
 * The guided self-report sections, in display order. Content mirrors the
 * SummitEd workbook's About You family (PRD §4 About You / Majors & Careers):
 * intake self-discovery, counselor Q&A survey, personality portrait, fun
 * facts, an essay story bank, and the majors/careers reflection.
 */
export const SECTION_DEFINITIONS: readonly AdmissionsSectionDefinition[] = [
  {
    id: "about_you",
    title: "About You",
    description:
      "The intake questionnaire — your background, interests, and goals. Counselors reuse this everywhere, so be specific.",
    steps: [
      {
        key: "basics",
        title: "The basics",
        fields: [
          {
            key: "preferred_name",
            label: "Preferred name",
            type: "text",
            maxLength: 50,
            helper: "What you like to be called day to day.",
            example: "Mint",
          },
          {
            key: "hometown",
            label: "Hometown",
            type: "text",
            maxLength: 80,
            helper: "Where you grew up or consider home.",
            example: "Bangkok, Thailand",
          },
          {
            key: "languages",
            label: "Languages you speak",
            type: "text",
            maxLength: 120,
            helper: "All languages, with rough fluency.",
            example: "Thai (native), English (fluent), Mandarin (basic)",
          },
          {
            key: "family_background",
            label: "Family background",
            type: "textarea",
            maxLength: 600,
            helper: "Who is in your family and anything that shaped you — jobs, moves, traditions.",
          },
          {
            key: "school_life",
            label: "A typical school week",
            type: "textarea",
            maxLength: 600,
            helper: "Classes, clubs, commitments — what your week actually looks like.",
          },
        ],
      },
      {
        key: "interests",
        title: "Interests & goals",
        fields: [
          {
            key: "favorite_subjects",
            label: "Favorite subjects",
            type: "multiselect",
            options: [
              "Math",
              "Physics",
              "Chemistry",
              "Biology",
              "Computer Science",
              "Economics",
              "Business",
              "History",
              "Geography",
              "English Literature",
              "Art & Design",
              "Music",
              "Languages",
              "Psychology",
              "Politics",
            ],
            helper: "Pick every subject you genuinely enjoy.",
          },
          {
            key: "academic_interests",
            label: "What do you love learning about?",
            type: "textarea",
            maxLength: 600,
            helper: "Topics you explore beyond homework — videos, books, projects.",
            example: "I watch aerospace videos and built a model rocket with friends.",
          },
          {
            key: "activities_outside_school",
            label: "Life outside school",
            type: "textarea",
            maxLength: 600,
            helper: "Sports, arts, volunteering, part-time work, family duties.",
          },
          {
            key: "proudest_achievement",
            label: "Proudest achievement so far",
            type: "textarea",
            maxLength: 400,
            helper: "One thing you are proud of — big or small — and why it mattered.",
          },
          {
            key: "five_year_goal",
            label: "Where do you hope to be in five years?",
            type: "textarea",
            maxLength: 400,
            helper: "A rough picture is fine — studying what, living where, doing what.",
          },
        ],
      },
    ],
  },
  {
    id: "q_and_a_survey",
    title: "Q&A Survey",
    description:
      "Quick preference survey — helps your counselor shape the college long list.",
    steps: [
      {
        key: "survey",
        title: "Your preferences",
        fields: [
          {
            key: "why_college",
            label: "Why do you want to go to college?",
            type: "textarea",
            maxLength: 500,
            helper: "Your honest reasons — there is no wrong answer.",
          },
          {
            key: "dream_school_qualities",
            label: "What would your dream school have?",
            type: "textarea",
            maxLength: 500,
            helper: "Programs, vibe, people, opportunities — describe the ideal.",
          },
          {
            key: "preferred_environment",
            label: "Preferred campus setting",
            type: "select",
            options: ["Big city", "College town", "Suburban", "Rural", "No preference"],
            helper: "Where would you feel most at home?",
          },
          {
            key: "preferred_size",
            label: "Preferred school size",
            type: "select",
            options: ["Under 5,000 students", "5,000–15,000 students", "Over 15,000 students", "No preference"],
            helper: "Small seminar campus or big-school energy?",
          },
          {
            key: "distance_from_home",
            label: "How far from home?",
            type: "select",
            options: [
              "As close as possible",
              "Same region",
              "Anywhere in the country",
              "Anywhere in the world",
            ],
            helper: "Be honest — this affects the whole list.",
          },
          {
            key: "weather_preference",
            label: "Weather preference",
            type: "select",
            options: ["Warm all year", "Four seasons", "Cold is fine", "No preference"],
            helper: "Four years is a long time to be cold.",
          },
          {
            key: "budget_conversation",
            label: "Have you discussed budget with your family?",
            type: "select",
            options: ["Yes, we have discussed it", "Not yet", "I don't know"],
            helper: "No numbers needed here — just whether the conversation has happened.",
          },
          {
            key: "biggest_worry",
            label: "Biggest worry about this process",
            type: "textarea",
            maxLength: 400,
            helper: "Whatever keeps you up at night — your counselor can help.",
          },
        ],
      },
    ],
  },
  {
    id: "personality",
    title: "Personality",
    description:
      "How you see yourself and how others see you — raw material for essays and recommendations.",
    steps: [
      {
        key: "self_portrait",
        title: "Self portrait",
        fields: [
          {
            key: "three_words",
            label: "Three words that describe you",
            type: "text",
            maxLength: 120,
            helper: "First instinct — do not overthink it.",
            example: "curious, stubborn, funny",
          },
          {
            key: "friends_say",
            label: "What would your friends say about you?",
            type: "textarea",
            maxLength: 400,
            helper: "How the people closest to you would describe you.",
          },
          {
            key: "teachers_say",
            label: "What would your teachers say about you?",
            type: "textarea",
            maxLength: 400,
            helper: "Think of the teacher who knows you best.",
          },
          {
            key: "work_style",
            label: "Your work style",
            type: "select",
            options: [
              "Plan far ahead",
              "Sprint near deadlines",
              "Steady daily work",
              "Depends on the task",
            ],
            helper: "How you actually work — not how you wish you worked.",
          },
          {
            key: "team_role",
            label: "Your role in a team",
            type: "select",
            options: ["Leader", "Organizer", "Idea generator", "Supporter", "Finisher"],
            helper: "The role you naturally fall into on group projects.",
          },
          {
            key: "stress_response",
            label: "How do you handle stress?",
            type: "textarea",
            maxLength: 400,
            helper: "What stresses you, and what you do about it.",
          },
          {
            key: "core_values",
            label: "Core values",
            type: "multiselect",
            options: [
              "Honesty",
              "Curiosity",
              "Loyalty",
              "Independence",
              "Creativity",
              "Discipline",
              "Kindness",
              "Ambition",
              "Humor",
              "Family",
            ],
            helper: "Pick the three to five that matter most to you.",
          },
        ],
      },
    ],
  },
  {
    id: "random_facts",
    title: "Random Facts",
    description:
      "The fun stuff — details that make you memorable in essays and interviews.",
    steps: [
      {
        key: "fun_facts",
        title: "Fun facts",
        fields: [
          {
            key: "hidden_talent",
            label: "Hidden talent",
            type: "text",
            maxLength: 150,
            helper: "Something most people do not know you can do.",
            example: "I can solve a Rubik's cube in under a minute.",
          },
          {
            key: "favorite_book",
            label: "Favorite book",
            type: "text",
            maxLength: 120,
            helper: "The one you would actually recommend.",
          },
          {
            key: "favorite_movie_show",
            label: "Favorite movie or show",
            type: "text",
            maxLength: 120,
            helper: "What you rewatch or cannot stop talking about.",
          },
          {
            key: "go_to_hobby",
            label: "Go-to hobby",
            type: "text",
            maxLength: 150,
            helper: "What you do when you finally have free time.",
          },
          {
            key: "perfect_weekend",
            label: "Describe a perfect weekend",
            type: "textarea",
            maxLength: 400,
            helper: "Real or imagined — what does it look like?",
          },
          {
            key: "surprising_fact",
            label: "A fact that surprises people",
            type: "textarea",
            maxLength: 300,
            helper: "The thing that makes people say 'really?'",
          },
        ],
      },
    ],
  },
  {
    id: "essay_moments",
    title: "Essay Moments",
    description:
      "A story bank for your essays — capture moments now, shape them into drafts later.",
    steps: [
      {
        key: "stories",
        title: "Defining stories",
        fields: [
          {
            key: "challenge_overcome",
            label: "A challenge you overcame",
            type: "textarea",
            maxLength: 800,
            helper: "What happened, what you did, and what changed in you.",
          },
          {
            key: "moment_of_growth",
            label: "A moment you grew up a little",
            type: "textarea",
            maxLength: 800,
            helper: "A realization or turning point — even a quiet one.",
          },
          {
            key: "time_you_led",
            label: "A time you led or took responsibility",
            type: "textarea",
            maxLength: 800,
            helper: "Formal titles not required — leading can be small and real.",
          },
          {
            key: "belief_questioned",
            label: "A belief or idea you questioned",
            type: "textarea",
            maxLength: 800,
            helper: "When you changed your mind, or chose not to.",
          },
          {
            key: "community_you_belong_to",
            label: "A community you belong to",
            type: "textarea",
            maxLength: 800,
            helper: "Any group that shaped you — family, team, online, neighborhood.",
          },
        ],
      },
      {
        key: "sparks",
        title: "Sparks & details",
        fields: [
          {
            key: "something_you_built",
            label: "Something you built or created",
            type: "textarea",
            maxLength: 600,
            helper: "A project, event, artwork, program — anything you made exist.",
          },
          {
            key: "lose_track_of_time",
            label: "What makes you lose track of time?",
            type: "textarea",
            maxLength: 600,
            helper: "The activity or topic where hours disappear.",
          },
          {
            key: "person_you_admire",
            label: "A person you admire and why",
            type: "textarea",
            maxLength: 600,
            helper: "Anyone — famous or not. The 'why' is the interesting part.",
          },
          {
            key: "failure_that_taught_you",
            label: "A failure that taught you something",
            type: "textarea",
            maxLength: 600,
            helper: "Colleges love honest reflection more than perfection.",
          },
          {
            key: "conversation_you_remember",
            label: "A conversation you still think about",
            type: "textarea",
            maxLength: 600,
            helper: "Who it was with and why it stuck.",
          },
        ],
      },
    ],
  },
  {
    id: "majors_reflection",
    title: "Majors & Careers Reflection",
    description:
      "Your current thinking on majors and careers — a direction, not a contract.",
    steps: [
      {
        key: "majors",
        title: "Majors",
        fields: [
          {
            key: "intended_majors",
            label: "Majors you are considering",
            type: "multiselect",
            options: [
              "Business",
              "Economics",
              "Computer Science",
              "Engineering",
              "Mathematics",
              "Biology",
              "Chemistry",
              "Physics",
              "Psychology",
              "Political Science",
              "International Relations",
              "English",
              "History",
              "Art & Design",
              "Music",
              "Communications",
              "Pre-Med",
              "Pre-Law",
              "Undecided",
            ],
            helper: "Pick every major you are seriously considering.",
          },
          {
            key: "why_these_majors",
            label: "Why these majors?",
            type: "textarea",
            maxLength: 600,
            helper: "What draws you to them — classes, experiences, people.",
          },
          {
            key: "supporting_experiences",
            label: "Experiences that support this direction",
            type: "textarea",
            maxLength: 600,
            helper: "Courses, projects, competitions, jobs, or reading that back it up.",
          },
          {
            key: "favorite_class_moment",
            label: "A class moment that excited you",
            type: "textarea",
            maxLength: 400,
            helper: "A lesson, lab, or discussion you still remember.",
          },
          {
            key: "open_to_undecided",
            label: "Open to applying undecided?",
            type: "select",
            options: ["Yes", "No", "Not sure"],
            helper: "Many schools let you explore first — is that appealing?",
          },
        ],
      },
      {
        key: "careers",
        title: "Careers",
        fields: [
          {
            key: "careers_considered",
            label: "Careers you have considered",
            type: "textarea",
            maxLength: 500,
            helper: "List everything, even the long shots.",
          },
          {
            key: "dream_job",
            label: "Dream job",
            type: "text",
            maxLength: 150,
            helper: "If anything were possible, what would you do?",
            example: "Game designer at my own studio",
          },
          {
            key: "role_models_in_field",
            label: "Role models in that field",
            type: "textarea",
            maxLength: 400,
            helper: "People whose careers you would want — and what they did.",
          },
          {
            key: "skills_to_build",
            label: "Skills you want to build",
            type: "textarea",
            maxLength: 400,
            helper: "What you would need to learn to get there.",
          },
          {
            key: "plan_b",
            label: "A realistic plan B",
            type: "textarea",
            maxLength: 400,
            helper: "A backup direction you would still be happy with.",
          },
        ],
      },
    ],
  },
];

/** The definition for a section key, or null when the key is unknown. */
export function getSectionDefinition(sectionKey: string): AdmissionsSectionDefinition | null {
  return SECTION_DEFINITIONS.find((definition) => definition.id === sectionKey) ?? null;
}

// ── DTOs ────────────────────────────────────────────────────────────────

/** One section's full state for the guided-form UI (definition + answers). */
export interface AdmissionsSectionStateDto {
  caseId: string;
  sectionKey: AdmissionsSectionKey;
  definition: AdmissionsSectionDefinition;
  /** Saved answers keyed by field key; {} for a never-saved section. */
  payload: Record<string, unknown>;
  state: AdmissionsSubmissionState;
  submittedAt: string | null;
  reviewedByEmail: string | null;
  /** Null for a virtual empty draft (no row persisted yet). */
  updatedAt: string | null;
}

/** Lightweight per-section status row (student home / This Week nudges). */
export interface AdmissionsSectionSummary {
  sectionKey: AdmissionsSectionKey;
  title: string;
  state: AdmissionsSubmissionState;
  submittedAt: string | null;
  /** Null when the section has never been saved. */
  updatedAt: string | null;
}

// ── Internal helpers ────────────────────────────────────────────────────

/** Every field of a definition, keyed by field key (steps flattened). */
function getFieldMap(definition: AdmissionsSectionDefinition): Map<string, AdmissionsSectionField> {
  const fields = new Map<string, AdmissionsSectionField>();
  for (const step of definition.steps) {
    for (const field of step.fields) fields.set(field.key, field);
  }
  return fields;
}

function toSectionDto(
  definition: AdmissionsSectionDefinition,
  row: SectionRow,
): AdmissionsSectionStateDto {
  return {
    caseId: row.caseId,
    sectionKey: definition.id,
    definition,
    payload: row.payload ?? {},
    state: row.state,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    reviewedByEmail: row.reviewedByEmail,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The virtual empty-draft DTO for a section with no persisted row. */
function toEmptyDraftDto(
  definition: AdmissionsSectionDefinition,
  caseId: string,
): AdmissionsSectionStateDto {
  return {
    caseId,
    sectionKey: definition.id,
    definition,
    payload: {},
    state: "draft",
    submittedAt: null,
    reviewedByEmail: null,
    updatedAt: null,
  };
}

/** Loads the (caseId, sectionKey) row; null when the section was never saved. */
async function findSectionRow(
  db: AdmissionsWriteDb,
  caseId: string,
  sectionKey: string,
): Promise<SectionRow | null> {
  const rows = await db
    .select()
    .from(admissionsSelfReportSections)
    .where(and(
      eq(admissionsSelfReportSections.caseId, caseId),
      eq(admissionsSelfReportSections.sectionKey, sectionKey),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/** Result of validating a partial payload against a section definition. */
interface ValidatedSectionPayload {
  /** Field key → validated value to set (strings trimmed, multiselect deduped). */
  updates: Record<string, unknown>;
  /** Field keys the caller cleared (null / empty string / empty array). */
  cleared: string[];
}

/**
 * Validates a PARTIAL payload against the section definition (fail-closed):
 *
 * - Unknown keys are rejected with a descriptive Error — payload keys must
 *   exist in the definition's steps.
 * - `null`, an empty/whitespace-only string, and an empty array all mean
 *   "clear this field" (autosave sends whatever the input holds on blur).
 * - text/textarea/select values must be strings; they are trimmed and the
 *   field's maxLength is enforced as a hard stop (CM-121 char counters).
 * - select values must be one of the field's options; multiselect values
 *   must be string arrays whose every element is an option (duplicates are
 *   collapsed, first occurrence wins).
 */
function validateSectionPayload(
  definition: AdmissionsSectionDefinition,
  payload: Record<string, unknown>,
): ValidatedSectionPayload {
  const fields = getFieldMap(definition);
  const updates: Record<string, unknown> = {};
  const cleared: string[] = [];

  for (const [key, rawValue] of Object.entries(payload)) {
    const field = fields.get(key);
    if (!field) {
      throw new Error(`Unknown field "${key}" for section "${definition.id}"`);
    }

    if (rawValue === null) {
      cleared.push(key);
      continue;
    }

    if (field.type === "multiselect") {
      if (!Array.isArray(rawValue) || rawValue.some((entry) => typeof entry !== "string")) {
        throw new Error(`Field "${key}" expects an array of strings`);
      }
      const values = [...new Set(rawValue as string[])];
      const options = field.options ?? [];
      for (const value of values) {
        if (!options.includes(value)) {
          throw new Error(`Field "${key}" has an unknown option: "${value}"`);
        }
      }
      if (values.length === 0) cleared.push(key);
      else updates[key] = values;
      continue;
    }

    if (typeof rawValue !== "string") {
      throw new Error(`Field "${key}" expects a string value`);
    }
    const value = rawValue.trim();
    if (value === "") {
      cleared.push(key);
      continue;
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      throw new Error(`Field "${key}" exceeds ${field.maxLength} characters`);
    }
    if (field.type === "select" && !(field.options ?? []).includes(value)) {
      throw new Error(`Field "${key}" has an unknown option: "${value}"`);
    }
    updates[key] = value;
  }

  return { updates, cleared };
}

/** True when two already-validated payload values are the same content. */
function isSamePayloadValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  }
  return false;
}

// ── Reads ───────────────────────────────────────────────────────────────

/**
 * One section's definition + saved answers + review state (CM-121). A case
 * with no persisted row reads as an EMPTY DRAFT (payload {}, state "draft",
 * updatedAt null) — no row is written by this read. Unknown sectionKey or a
 * malformed caseId throws "NotFound".
 *
 * @returns the section state DTO the guided-form UI renders.
 */
export async function getSectionState(
  caseId: string,
  sectionKey: string,
  db: Database = getDb(),
): Promise<AdmissionsSectionStateDto> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");
  const definition = getSectionDefinition(sectionKey);
  if (!definition) throw new Error("NotFound");

  const row = await findSectionRow(db, caseId, sectionKey);
  return row ? toSectionDto(definition, row) : toEmptyDraftDto(definition, caseId);
}

/**
 * Per-section status for EVERY defined section, in display order — the
 * student home's section list and buildThisWeek's unsubmitted-section
 * nudges. Sections with no persisted row read as drafts (updatedAt null).
 * A malformed caseId fails closed to an empty list.
 */
export async function listSectionStates(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsSectionSummary[]> {
  if (!isUuidShaped(caseId)) return [];

  const rows = await db
    .select({
      sectionKey: admissionsSelfReportSections.sectionKey,
      state: admissionsSelfReportSections.state,
      submittedAt: admissionsSelfReportSections.submittedAt,
      updatedAt: admissionsSelfReportSections.updatedAt,
    })
    .from(admissionsSelfReportSections)
    .where(eq(admissionsSelfReportSections.caseId, caseId));
  const rowsByKey = new Map(rows.map((row) => [row.sectionKey, row]));

  return SECTION_DEFINITIONS.map((definition) => {
    const row = rowsByKey.get(definition.id);
    return {
      sectionKey: definition.id,
      title: definition.title,
      state: row?.state ?? "draft",
      submittedAt: row?.submittedAt ? row.submittedAt.toISOString() : null,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });
}

// ── Draft autosave (CM-121, design §2.4) ────────────────────────────────

/** saveSectionDraft input; `access` must come from requireCaseAccess. */
export interface SaveSectionDraftInput {
  access: CaseAccess;
  sectionKey: string;
  /** PARTIAL payload — only the provided keys change (autosave on blur). */
  payload: Record<string, unknown>;
}

/**
 * Autosaves a partial payload into a section draft (CM-121). Student-writable
 * (design §2.4 self-report surface); counselor/admin edits are allowed and
 * attributed via the audit actorRole; parents never write.
 *
 * 1. Role gate (parent → Forbidden); unknown sectionKey / malformed input →
 *    NotFound / descriptive Error. The payload is validated against the
 *    definition BEFORE any write: unknown keys rejected, per-field type /
 *    option / maxLength checks (fail-closed).
 * 2. Merge semantics: provided keys overwrite the stored payload; `null`,
 *    empty strings, and empty arrays clear their key; untouched keys are
 *    preserved. A save with no effective change writes nothing (and never
 *    reverts state).
 * 3. State machine (documented rule): an EFFECTIVE edit to a "submitted" OR
 *    "reviewed" section returns it to "draft" — submittedAt and
 *    reviewedByEmail are cleared and the state transition is recorded in the
 *    same audit row ("editing a submitted section returns it to draft").
 * 4. First save materializes the row (the empty virtual draft becomes real);
 *    the upsert and its audit row commit atomically (entityType
 *    "self_report_section", action "save_draft", field-level payload diff).
 *
 * @returns the updated section state DTO.
 */
export async function saveSectionDraft(
  input: SaveSectionDraftInput,
  db: Database = getDb(),
): Promise<AdmissionsSectionStateDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.access.caseId)) throw new Error("NotFound");
  const definition = getSectionDefinition(input.sectionKey);
  if (!definition) throw new Error("NotFound");

  const { updates, cleared } = validateSectionPayload(definition, input.payload);

  return withAuditedTransaction(async (tx) => {
    const row = await findSectionRow(tx, input.access.caseId, input.sectionKey);
    const oldPayload: Record<string, unknown> = row?.payload ?? {};

    // Field-level diff limited to EFFECTIVE changes: skip same-value writes
    // and clears of keys that were never set (autosave replays are no-ops).
    const diff: AdmissionsFieldDiff = {};
    const merged: Record<string, unknown> = { ...oldPayload };
    for (const [key, value] of Object.entries(updates)) {
      if (isSamePayloadValue(oldPayload[key], value)) continue;
      diff[key] = { old: oldPayload[key] ?? null, new: value };
      merged[key] = value;
    }
    for (const key of cleared) {
      if (!(key in oldPayload)) continue;
      diff[key] = { old: oldPayload[key] ?? null, new: null };
      delete merged[key];
    }

    if (Object.keys(diff).length === 0) {
      return row ? toSectionDto(definition, row) : toEmptyDraftDto(definition, input.access.caseId);
    }

    const now = new Date();
    const reverts = row !== null && row.state !== "draft";
    const auditDiff: AdmissionsFieldDiff = reverts
      ? { ...diff, state: { old: row.state, new: "draft" } }
      : diff;

    let saved: SectionRow;
    if (row === null) {
      const insertedRows = await tx
        .insert(admissionsSelfReportSections)
        .values({
          caseId: input.access.caseId,
          sectionKey: definition.id,
          payload: merged,
          state: "draft",
        })
        .returning();
      const inserted = insertedRows[0];
      if (!inserted) throw new Error("Section insert returned no row");
      saved = inserted;
    } else {
      const setValues = {
        payload: merged,
        updatedAt: now,
        ...(reverts
          ? { state: "draft" as const, submittedAt: null, reviewedByEmail: null }
          : {}),
      };
      await tx
        .update(admissionsSelfReportSections)
        .set(setValues)
        .where(eq(admissionsSelfReportSections.id, row.id));
      saved = { ...row, ...setValues };
    }

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "self_report_section",
      entityId: saved.id,
      action: "save_draft",
      diff: auditDiff,
    });

    return toSectionDto(definition, saved);
  }, db);
}

// ── Submit / review state machine (CM-121) ──────────────────────────────

/** submitSection result; `notify` is the counselor-notification marker. */
export interface SubmitSectionResult {
  section: AdmissionsSectionStateDto;
  /**
   * Always true on a successful submit — submit is the ONLY event that
   * notifies the counselor (CM-121). The route carries this marker; Phase 5
   * wires the real notification transport.
   */
  notify: boolean;
}

/** submitSection / reviewSection input; `access` from requireCaseAccess. */
export interface SectionTransitionInput {
  access: CaseAccess;
  sectionKey: string;
}

/**
 * Submits a section for counselor review: draft → submitted (CM-121).
 * Student-writable (counselor/admin may submit on the student's behalf,
 * attributed); parents never write.
 *
 * 1. Role gate; unknown sectionKey → NotFound.
 * 2. The section must have a persisted row in state "draft" — a never-saved
 *    section (the empty virtual draft) or an already-submitted/reviewed one
 *    throws Error("Conflict"): there is nothing (new) to review.
 * 3. Stamps state "submitted" + submittedAt; the mutation and its audit row
 *    (action "submit") commit atomically.
 *
 * @returns the submitted section DTO plus the `{ notify: true }` marker.
 */
export async function submitSection(
  input: SectionTransitionInput,
  db: Database = getDb(),
): Promise<SubmitSectionResult> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.access.caseId)) throw new Error("NotFound");
  const definition = getSectionDefinition(input.sectionKey);
  if (!definition) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findSectionRow(tx, input.access.caseId, input.sectionKey);
    if (row === null || row.state !== "draft") throw new Error("Conflict");

    const now = new Date();
    const setValues = {
      state: "submitted" as const,
      submittedAt: now,
      reviewedByEmail: null,
      updatedAt: now,
    };
    await tx
      .update(admissionsSelfReportSections)
      .set(setValues)
      .where(eq(admissionsSelfReportSections.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "self_report_section",
      entityId: row.id,
      action: "submit",
      diff: {
        state: { old: row.state, new: "submitted" },
        submittedAt: { old: null, new: now.toISOString() },
      },
    });

    return { section: toSectionDto(definition, { ...row, ...setValues }), notify: true };
  }, db);
}

/**
 * Marks a submitted section reviewed: submitted → reviewed (CM-121).
 * Counselor+ only; stamps reviewedByEmail with the reviewer. Review from any
 * other state throws Error("Conflict") — a draft has not been submitted and
 * a reviewed section needs a fresh submit cycle first. Reviewing does NOT
 * notify anyone (submit is the only notify event). Audited atomically
 * (action "review").
 *
 * @returns the reviewed section DTO.
 */
export async function reviewSection(
  input: SectionTransitionInput,
  db: Database = getDb(),
): Promise<AdmissionsSectionStateDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.access.caseId)) throw new Error("NotFound");
  const definition = getSectionDefinition(input.sectionKey);
  if (!definition) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findSectionRow(tx, input.access.caseId, input.sectionKey);
    if (row === null) throw new Error("NotFound");
    if (row.state !== "submitted") throw new Error("Conflict");

    const now = new Date();
    const setValues = {
      state: "reviewed" as const,
      reviewedByEmail: input.access.email,
      updatedAt: now,
    };
    await tx
      .update(admissionsSelfReportSections)
      .set(setValues)
      .where(eq(admissionsSelfReportSections.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "self_report_section",
      entityId: row.id,
      action: "review",
      diff: {
        state: { old: row.state, new: "reviewed" },
        reviewedByEmail: { old: row.reviewedByEmail, new: input.access.email },
      },
    });

    return toSectionDto(definition, { ...row, ...setValues });
  }, db);
}

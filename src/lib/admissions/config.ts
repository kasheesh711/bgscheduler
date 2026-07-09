// Admissions Case Management — shared constants and pure role helpers.
//
// Design: docs/casemanagementsystem_design.md §2.2 (role ordering) and the
// PRD's CM-20 (10-phase SummitEd checklist template, About You → Transition).

import type { AdmissionsTaskOwner } from "./meetings";
import type { CaseRole } from "./types";

/** Route prefix this domain's pages and APIs live under. */
export const ADMISSIONS_ROUTE = "/admissions";

/**
 * Within-case role precedence (design §2.2): parent < student < counselor < admin.
 * Higher number = more rights.
 */
export const CASE_ROLE_PRECEDENCE: Record<CaseRole, number> = {
  parent: 0,
  student: 1,
  counselor: 2,
  admin: 3,
};

/**
 * Returns true when `role` grants at least the rights of `minRole` under the
 * parent < student < counselor < admin ordering.
 */
export function roleAtLeast(role: CaseRole, minRole: CaseRole): boolean {
  return CASE_ROLE_PRECEDENCE[role] >= CASE_ROLE_PRECEDENCE[minRole];
}

/**
 * The 10 checklist phases mirroring the SummitEd workbook (PRD CM-20),
 * in canonical order. `key` is the stable identifier persisted on
 * admissions_template_items.phase / admissions_case_tasks.phase; `label`
 * is the display string.
 */
export const ADMISSIONS_CHECKLIST_PHASES = [
  { key: "about_you", label: "About You" },
  { key: "academics", label: "Academics" },
  { key: "testing", label: "Testing" },
  { key: "activities", label: "Activities & Awards" },
  { key: "college_research", label: "College Research" },
  { key: "essays", label: "Essays" },
  { key: "recommendations", label: "Recommendations" },
  { key: "applications", label: "Applications" },
  { key: "decisions_aid", label: "Decisions & Financial Aid" },
  { key: "transition", label: "Transition to College" },
] as const;

/** Stable checklist phase key ("about_you" … "transition"). */
export type AdmissionsPhaseKey = (typeof ADMISSIONS_CHECKLIST_PHASES)[number]["key"];

/** Type guard: is `value` one of the 10 canonical checklist phase keys? */
export function isAdmissionsPhaseKey(value: string): value is AdmissionsPhaseKey {
  return ADMISSIONS_CHECKLIST_PHASES.some((entry) => entry.key === value);
}

/** Display label for a phase key, or null when the key is unknown. */
export function getAdmissionsPhaseLabel(phaseKey: string): string | null {
  const phase = ADMISSIONS_CHECKLIST_PHASES.find((entry) => entry.key === phaseKey);
  return phase ? phase.label : null;
}

// ── Default checklist template seed (PRD CM-20, design §1 module map) ───

/**
 * One seed row for a checklist-template version (admissions_template_items
 * columns minus ids). `itemKey` is the stable snake_case identity that
 * survives template versions (CM-21 push-new-items matches on it).
 */
export interface AdmissionsTemplateItemSeed {
  itemKey: string;
  phase: AdmissionsPhaseKey;
  title: string;
  description: string | null;
  defaultOwner: AdmissionsTaskOwner;
  sortOrder: number;
}

/**
 * The SummitEd 10-phase default checklist (PRD §4.3 / CM-20), covering every
 * canonical phase in ADMISSIONS_CHECKLIST_PHASES order. Self-report items
 * (About You, activities, essay drafting, testing self-entries, research
 * notes) default to the student; structural/verification work defaults to
 * the counselor. Order in this array is the seed order.
 */
const DEFAULT_CHECKLIST_ITEM_ROWS: ReadonlyArray<Omit<AdmissionsTemplateItemSeed, "sortOrder">> = [
  // About You — intake self-discovery (SummitEd "About You" tab).
  {
    itemKey: "complete_intake_questionnaire",
    phase: "about_you",
    title: "Complete the intake questionnaire",
    description: "Fill in the About You intake form covering background, interests, and goals.",
    defaultOwner: "student",
  },
  {
    itemKey: "write_personal_background_summary",
    phase: "about_you",
    title: "Write your personal background summary",
    description: "A short self-introduction counselors reuse across essays and recommendations.",
    defaultOwner: "student",
  },
  {
    itemKey: "explore_majors_and_careers",
    phase: "about_you",
    title: "Explore majors and career interests",
    description: "Research possible majors and careers and note your top directions.",
    defaultOwner: "student",
  },
  {
    itemKey: "confirm_profile_details",
    phase: "about_you",
    title: "Confirm profile and contact details",
    description: "Verify name, emails, phone, school, and school counselor on the case profile.",
    defaultOwner: "counselor",
  },
  {
    itemKey: "set_up_drive_folder",
    phase: "about_you",
    title: "Set up the shared Drive folder",
    description: "Create the per-student Drive folder (intake doc, essays, resume) and link it to the case.",
    defaultOwner: "counselor",
  },
  // Academics — counselor-edited records (CM-11/CM-12).
  {
    itemKey: "record_current_transcript",
    phase: "academics",
    title: "Record the current transcript",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "enter_gpa_or_predicted_grades",
    phase: "academics",
    title: "Enter GPA or predicted grades",
    description: "US GPA (unweighted/weighted, class rank), UK A-level/IGCSE predicted, or IB predicted points.",
    defaultOwner: "counselor",
  },
  {
    itemKey: "plan_course_selection",
    phase: "academics",
    title: "Plan next term's course selection",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "review_midyear_grades",
    phase: "academics",
    title: "Review the midyear grade report",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "update_final_grades",
    phase: "academics",
    title: "Update achieved and final grades",
    description: null,
    defaultOwner: "counselor",
  },
  // Testing — plan is staff work; registrations/sittings are self-report.
  {
    itemKey: "build_testing_plan",
    phase: "testing",
    title: "Build the standardized testing plan",
    description: "Which tests, which sittings, and target scores for the college list.",
    defaultOwner: "counselor",
  },
  {
    itemKey: "register_for_admissions_tests",
    phase: "testing",
    title: "Register for SAT/ACT sittings",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "complete_first_sitting",
    phase: "testing",
    title: "Complete the first official test sitting",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "report_new_scores",
    phase: "testing",
    title: "Report new score results",
    description: "Log registered/taken/received milestones so the counselor can review and release scores.",
    defaultOwner: "student",
  },
  {
    itemKey: "plan_english_proficiency_test",
    phase: "testing",
    title: "Plan English proficiency testing (TOEFL/IELTS)",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "release_scores_to_family",
    phase: "testing",
    title: "Review and release scores to the family",
    description: "Raw scores stay staff-only until the counselor marks them released.",
    defaultOwner: "counselor",
  },
  // Activities & Awards — student self-report with counselor review.
  {
    itemKey: "draft_activities_list",
    phase: "activities",
    title: "Draft the activities list",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "record_honors_and_awards",
    phase: "activities",
    title: "Record honors and awards",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "plan_summer_activities",
    phase: "activities",
    title: "Plan summer activities",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "review_activities_with_counselor",
    phase: "activities",
    title: "Review the activities list with your counselor",
    description: null,
    defaultOwner: "counselor",
  },
  // College Research — long list to balanced shortlist.
  {
    itemKey: "build_college_longlist",
    phase: "college_research",
    title: "Build the initial college long list",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "research_college_fit",
    phase: "college_research",
    title: "Research fit notes for each college",
    description: "Programs, campus, cost, and admission profile notes per college on the list.",
    defaultOwner: "student",
  },
  {
    itemKey: "attend_info_sessions",
    phase: "college_research",
    title: "Attend college info sessions or fairs",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "categorize_reach_match_safety",
    phase: "college_research",
    title: "Categorize colleges as reach/match/safety",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "finalize_college_shortlist",
    phase: "college_research",
    title: "Finalize the balanced shortlist",
    description: null,
    defaultOwner: "counselor",
  },
  // Essays — drafting is self-report; feedback/final review is staff work.
  {
    itemKey: "brainstorm_essay_topics",
    phase: "essays",
    title: "Brainstorm personal statement topics",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "draft_personal_statement",
    phase: "essays",
    title: "Draft the personal statement",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "personal_statement_feedback",
    phase: "essays",
    title: "Complete a counselor feedback round on the personal statement",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "finalize_personal_statement",
    phase: "essays",
    title: "Finalize the personal statement",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "draft_supplemental_essays",
    phase: "essays",
    title: "Draft supplemental essays",
    description: "One per college requirement; track status per essay in the Essays tab.",
    defaultOwner: "student",
  },
  {
    itemKey: "final_essay_review",
    phase: "essays",
    title: "Final counselor review of all essays",
    description: null,
    defaultOwner: "counselor",
  },
  // Recommendations — asks are the student's; confirmation/tracking is staff.
  {
    itemKey: "identify_recommenders",
    phase: "recommendations",
    title: "Identify recommenders",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "ask_recommenders",
    phase: "recommendations",
    title: "Ask recommenders in person",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "share_brag_sheet",
    phase: "recommendations",
    title: "Share your brag sheet with recommenders",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "confirm_recommender_agreement",
    phase: "recommendations",
    title: "Confirm recommender agreements",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "track_recommendation_submissions",
    phase: "recommendations",
    title: "Track recommendation submissions",
    description: null,
    defaultOwner: "counselor",
  },
  // Applications — accounts/forms are the student's; rounds/verification staff.
  {
    itemKey: "create_application_accounts",
    phase: "applications",
    title: "Create application platform accounts",
    description: "Common App, UCAS, or institution portals as required by the college list.",
    defaultOwner: "student",
  },
  {
    itemKey: "confirm_application_rounds",
    phase: "applications",
    title: "Confirm application rounds and deadlines",
    description: "ED/ED2/EA/REA/RD/Rolling per college, with per-round deadlines on the list.",
    defaultOwner: "counselor",
  },
  {
    itemKey: "complete_application_profile",
    phase: "applications",
    title: "Complete the application profile sections",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "request_transcripts",
    phase: "applications",
    title: "Request official transcripts be sent",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "submit_applications",
    phase: "applications",
    title: "Submit each application before its deadline",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "verify_materials_received",
    phase: "applications",
    title: "Verify all materials are received by each college",
    description: null,
    defaultOwner: "counselor",
  },
  // Decisions & Financial Aid — aid/scholarship forms + decision tracking.
  {
    itemKey: "complete_financial_aid_forms",
    phase: "decisions_aid",
    title: "Complete financial aid forms",
    description: "CSS Profile or institutional aid forms where applicable.",
    defaultOwner: "student",
  },
  {
    itemKey: "research_scholarships",
    phase: "decisions_aid",
    title: "Research scholarship opportunities",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "submit_scholarship_applications",
    phase: "decisions_aid",
    title: "Submit scholarship applications",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "track_admission_decisions",
    phase: "decisions_aid",
    title: "Track admission decisions",
    description: "Log deferred/waitlisted/accepted/denied events per college as they arrive.",
    defaultOwner: "counselor",
  },
  {
    itemKey: "compare_offers",
    phase: "decisions_aid",
    title: "Compare offers and aid packages",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "submit_enrollment_deposit",
    phase: "decisions_aid",
    title: "Submit the enrollment deposit",
    description: null,
    defaultOwner: "student",
  },
  // Transition to College — close-out logistics.
  {
    itemKey: "send_final_transcript",
    phase: "transition",
    title: "Send the final transcript",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "complete_enrollment_forms",
    phase: "transition",
    title: "Complete housing and orientation forms",
    description: null,
    defaultOwner: "student",
  },
  {
    itemKey: "plan_visa_and_travel",
    phase: "transition",
    title: "Plan visa and travel logistics",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "confirm_transition_checklist",
    phase: "transition",
    title: "Confirm the transition checklist is complete",
    description: null,
    defaultOwner: "counselor",
  },
  {
    itemKey: "collect_testimonial",
    phase: "transition",
    title: "Collect a closing testimonial",
    description: null,
    defaultOwner: "counselor",
  },
];

/**
 * The default SummitEd checklist template items (CM-20), in seed order with
 * derived sequential sortOrder. seedDefaultTemplate (checklists.ts) writes
 * these into a new published template version for a cohort.
 */
export const DEFAULT_CHECKLIST_ITEMS: readonly AdmissionsTemplateItemSeed[] =
  DEFAULT_CHECKLIST_ITEM_ROWS.map((item, index) => ({ ...item, sortOrder: index }));

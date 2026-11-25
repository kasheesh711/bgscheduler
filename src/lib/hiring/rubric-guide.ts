import type { RubricItem, StressTicks } from "./marking-sheet";

// Text from "Teacher Assessment Rubric_Nov2026" (Kevin, 20 Nov 2026). Keep it word for word.

export const BAND_LABELS = ["Excellence (10)", "Satisfactory (7)", "Needs improvement (4)", "Unsatisfactory (1)"] as const;

/** What each band means for each item, best first. `hint` is the rubric's "look for" text. */
export const RUBRIC_GUIDE: Record<RubricItem, { hint?: string; bands: readonly [string, string, string, string] }> = {
  accuracy: {
    bands: [
      "All information provided is accurate, relevant, and aligned with the curriculum.",
      "Most information provided is accurate and relevant, with minor errors or omissions.",
      "Some information provided is inaccurate or irrelevant to the curriculum.",
      "Information provided is largely incorrect or irrelevant.",
    ],
  },
  concepts: {
    bands: [
      "Demonstrates a deep understanding of subject concepts and can explain them clearly and concisely.",
      "Shows a reasonable understanding of subject concepts but may struggle with some complex aspects.",
      "Demonstrates a superficial understanding of key concepts.",
      "Lack of understanding of fundamental subject concepts.",
    ],
  },
  clarity: {
    bands: [
      "Explains concepts clearly, provides relevant examples, and addresses student questions effectively.",
      "Explains concepts clearly but may need further clarity in some instances.",
      "Provides explanations that are confusing or unclear.",
      "Struggles to explain concepts and fails to address student questions.",
    ],
  },
  presentation: {
    bands: [
      "Keeps students engaged through a well-structured and dynamic presentation style.",
      "Keeps students reasonably engaged but lacks consistent enthusiasm.",
      "Presentation is somewhat monotonous or uninteresting.",
      "Fails to capture student interest throughout the class.",
    ],
  },
  interaction: {
    hint: "Includes interpersonal skill: connection with the student, warmth, sense of humour.",
    bands: [
      "Actively involves students through questions, discussions, and activities, fostering participation. Builds rapport naturally, with warmth and appropriate humour, so the student is comfortable to speak.",
      "Attempts to involve students but engagement is limited. Friendly and polite, but rapport or humour feels limited or forced at times.",
      "Rarely involves students, leading to passive learning. Formal or distant, with little attempt to connect.",
      "Does not engage with students, resulting in disinterest. Cold, dismissive or uses inappropriate humour.",
    ],
  },
  pace: {
    bands: [
      "Manages class time effectively, covering the planned material without rushing or unnecessary delays.",
      "Generally maintains an appropriate pace but may run slightly over or under time.",
      "Struggles to manage time, leaving some topics partially covered.",
      "Poor time management, significant portions of material are not covered.",
    ],
  },
  organization: {
    hint: "Includes presentation skill: agenda at the start, logical sequence, clear key message.",
    bands: [
      "Presents a well-organised class that opens with a clear agenda and follows a logical sequence. The key message is clear and supported by illustrated diagrams or visuals that aid student understanding.",
      "Provides an organised class with a somewhat clear structure. An agenda is stated, but the key message or visuals could be clearer.",
      "Class organisation is lacking in parts, causing confusion. No clear agenda, and the key message is only partly clear.",
      "Poor organisation and lack of clear structure disrupt the class. No agenda, and the student cannot identify the key message.",
    ],
  },
  materials: {
    bands: [
      "Effectively utilizes teaching materials (slides, resources) that enhance understanding and engagement.",
      "Uses teaching materials adequately, with occasional inconsistencies.",
      "Relies on teaching materials that are unclear or do not contribute to learning.",
      "Poor choice and use of teaching materials hinder understanding.",
    ],
  },
  formative: {
    bands: [
      "Integrates well-designed formative assessments that effectively gauge student understanding.",
      "Includes formative assessments but may lack variety or clear alignment with lesson objectives.",
      "Formative assessments are limited in number or do not align with objectives.",
      "No meaningful formative assessments are included.",
    ],
  },
  feedback: {
    bands: [
      "Provides insightful, constructive, and personalised feedback on student performance.",
      "Offers feedback that is generally helpful but may lack depth in some areas.",
      "Feedback provided is vague or does not contribute to student improvement.",
      "Feedback is minimal or not relevant to student progress.",
    ],
  },
  hygiene: {
    hint: "Look for: how presentable, clean and appropriate the candidate is (incl. camera/background if online).",
    bands: [
      "Clean, well-groomed and dressed professionally and appropriately. Online setup (camera, background) is tidy. No hygiene concerns.",
      "Generally clean and presentable, with minor issues (e.g., slightly too casual, untidy background).",
      "Noticeable issues, e.g., unkempt appearance or attire that is too casual for a tutoring setting.",
      "Serious hygiene concerns (e.g., noticeable body odour) or clearly inappropriate attire.",
    ],
  },
  stress: {
    hint: "Parent role-play; see the scenario in the interviewer guide. Look for: (A) listens and acknowledges, (B) explains without blaming, (C) proposes a concrete plan.",
    bands: [
      "Stays calm and professional throughout. Clearly shows all 3 elements (A, B, C), and the \"parent\" leaves reassured with a clear next step.",
      "Stays calm. Shows 2 of the 3 elements, or all 3 but the action plan is vague.",
      "Becomes hesitant or defensive. Shows only 1 element, and the plan is unclear or missing.",
      "Loses composure, blames the student or parent, or makes unrealistic promises (e.g., guarantees a grade). Shows none of the elements.",
    ],
  },
  safeguarding: {
    hint: "Use a safeguarding scenario from the question bank (Q1, Q2 or Q10).",
    bands: [
      "Recognises the welfare concern immediately. Responds calmly, keeps the student safe, does not promise secrecy, records the facts and escalates to the right person following school procedure. Keeps clear professional boundaries.",
      "Recognises the concern and would report it, but is unsure of the exact procedure or misses one key step (e.g., recording the facts).",
      "Treats the case only as a discipline issue, or is unsure whether it should be reported. Professional boundaries are unclear.",
      "Does not recognise the risk, would handle it alone or keep it secret, or suggests an action that breaches professional boundaries.",
    ],
  },
  curiosity: {
    hint: "Look for: how the candidate responds to a question outside the scope of the lesson (Q11 in the question bank).",
    bands: [
      "Welcomes the question. Gives a brief, accurate answer or honestly says they will find out, links it back to the lesson, and encourages further exploration (resource or follow-up) without derailing the class.",
      "Responds positively and answers, but misses the chance to extend the student's curiosity or spends too long off-topic.",
      "Gives a minimal or dismissive answer (e.g., \"that's not in the syllabus\") or guesses inaccurately.",
      "Ignores or discourages the question, or gives incorrect information with confidence.",
    ],
  },
};

export const STRESS_STEPS = [
  "You play the parent; the candidate is the tutor.",
  "Give the candidate 30 seconds to brainstorm before responding.",
] as const;
export const STRESS_SCENARIO =
  "A student has been studying with you for a month; however, the parents are unhappy with the overall progress so far. The child scored 19% on their most recent physics test. How do you handle this?";
export const STRESS_ELEMENTS: { key: keyof StressTicks; label: string; detail: string }[] = [
  {
    key: "listens",
    label: "A. Listens & acknowledges",
    detail: "Lets the parent finish, stays calm, acknowledges the concern and the parent's feelings before explaining (e.g., \"I understand this result is worrying\").",
  },
  {
    key: "explains",
    label: "B. Explains without blaming",
    detail: "Explains possible reasons using evidence (topics missed, exam technique, time since starting) without blaming the student, the parent or the school.",
  },
  {
    key: "plan",
    label: "C. Concrete plan & follow-up",
    detail: "Proposes specific next steps: review the test paper, target weak topics, set a timeline, agree how and when progress will be updated. No promise of a specific grade.",
  },
];

/** Optional questions for during or after the mock. The answers are evidence for the linked item; they are not scored separately. */
export const QUESTION_BANK: { question: string; informs: string; good: string }[] = [
  {
    question: "A student attends online class but doesn't talk at all. Their camera is off and they don't reply. What do you do?",
    informs: "Safeguarding; Interaction with Students",
    good: "Checks in kindly and privately, offers low-pressure ways to respond (chat, yes/no), rules out tech issues, and informs admin/parents if the pattern continues.",
  },
  {
    question: "A student asks to go to the toilet every class and stays for prolonged periods of time. What do you do?",
    informs: "Safeguarding",
    good: "Notices the pattern, checks in without accusing, considers welfare causes, records the facts and reports through the right channel.",
  },
  {
    question: "A student hasn't done their homework again. What do you do?",
    informs: "Classroom Management",
    good: "Finds out why, sets clear expectations, adjusts the workload or starts it in class, and updates parents/admin if it continues.",
  },
  {
    question: "You've explained it the same way three times and the student still doesn't get it. What do you do?",
    informs: "Clarity of Explanation",
    good: "Changes approach (diagram, example, smaller steps), checks for gaps in prior knowledge, and asks the student to explain it back.",
  },
  {
    question: "A student can't focus for more than a few minutes. How should you proceed?",
    informs: "Pace and Timing; Engaging Presentation",
    good: "Breaks the lesson into short chunks, varies activities, adds interactive tasks or short breaks, and watches for underlying causes.",
  },
  {
    question: "A student keeps checking their phone or playing games on their iPad in class. What steps would you take?",
    informs: "Classroom Management",
    good: "Sets device rules at the start, redirects calmly, uses the device for the task or asks to put it away, and involves parents if it repeats.",
  },
  {
    question: "A student says \"I understand\" to everything, then can't do the next question. What should you do?",
    informs: "Formative Assessment",
    good: "Checks understanding with a quick question, an example or by asking the student to explain, instead of asking \"Do you understand?\"",
  },
  {
    question: "\"My school teacher does it differently.\" How do you respond if a student says this?",
    informs: "Conceptual Understanding",
    good: "Respects the school's method, shows how both methods reach the same answer, and uses the method expected by the student's school or exam.",
  },
  {
    question: "A student has trouble explaining how they arrived at the answer. What next steps should you take?",
    informs: "Feedback Quality",
    good: "Asks the student to talk through each step, models clear working, and links it to how marks are given in the exam.",
  },
  {
    question: "A student damages classroom equipment. How would you handle it?",
    informs: "Safeguarding; Classroom Management",
    good: "Checks the student is safe first, stays calm, records what happened and reports to admin following company policy.",
  },
  {
    question: "If a student asks a question you don't have expertise in, how would you answer?",
    informs: "Nurture Curiosity",
    good: "Is honest, doesn't guess, promises to find out and follows up, and encourages the student to explore further.",
  },
  {
    question: "If another student disrupts your class, what actions would you take?",
    informs: "Classroom Management",
    good: "Redirects calmly and clearly, keeps the lesson going, follows up privately, and escalates to admin if it continues.",
  },
];

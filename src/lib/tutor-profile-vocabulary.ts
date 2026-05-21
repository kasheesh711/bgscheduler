export const TEACHING_STYLE_VOCABULARY = [
  {
    tag: "patient",
    label: "Patient",
    synonyms: ["patient", "calm", "gentle", "supportive"],
  },
  {
    tag: "structured",
    label: "Structured",
    synonyms: ["structured", "organized", "systematic", "clear plan"],
  },
  {
    tag: "interactive",
    label: "Interactive",
    synonyms: ["interactive", "engaging", "discussion", "participation"],
  },
  {
    tag: "exam-focused",
    label: "Exam-focused",
    synonyms: ["exam", "test prep", "past paper", "sat", "ielts", "igcse", "a-level", "ap"],
  },
  {
    tag: "concept-first",
    label: "Concept-first",
    synonyms: ["concept", "foundation", "understanding", "explain"],
  },
  {
    tag: "practice-heavy",
    label: "Practice-heavy",
    synonyms: ["practice", "drill", "problem solving", "worksheet"],
  },
  {
    tag: "gentle",
    label: "Gentle",
    synonyms: ["gentle", "kind", "warm", "friendly"],
  },
  {
    tag: "high-accountability",
    label: "High accountability",
    synonyms: ["strict", "accountability", "homework", "high expectations"],
  },
  {
    tag: "writing-feedback",
    label: "Writing feedback",
    synonyms: ["writing", "essay", "feedback", "paragraph", "report"],
  },
] as const;

export const CURRICULUM_EXPERIENCE_VOCABULARY = [
  "International",
  "Thai",
  "IB",
  "MYP",
  "IGCSE",
  "A-Level",
  "AP",
  "SAT",
  "IELTS",
  "GED",
] as const;

export const STRENGTH_TAG_VOCABULARY = [
  "writing",
  "exam prep",
  "young learners",
  "shy students",
  "advanced students",
  "foundation building",
  "math problem solving",
  "science concepts",
] as const;

export type TeachingStyleTag = typeof TEACHING_STYLE_VOCABULARY[number]["tag"];

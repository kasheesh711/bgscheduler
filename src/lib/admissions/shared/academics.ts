import { z } from "zod";
import { admissionsHttpUrlSchema } from "./urls";

const nullableUrlSchema = admissionsHttpUrlSchema.nullable().optional();
const nullableTextSchema = z.string().trim().min(1).nullable().optional();
const nullableGradeSchema = z.string().trim().min(1).max(30).nullable().optional();

export const ADMISSIONS_ACADEMIC_SYSTEMS = ["us", "ib", "a_level_igcse"] as const;
export type AdmissionsAcademicSystem = (typeof ADMISSIONS_ACADEMIC_SYSTEMS)[number];

export const admissionsCoursePlanItemSchema = z.object({
  gradeLevel: z.enum(["9", "10", "11", "12", "postgraduate"]),
  courseTitle: z.string().trim().min(1).max(200),
  level: z.string().trim().max(80).nullable().optional(),
  credits: z.number().min(0).max(20).nullable().optional(),
  finalGrade: nullableGradeSchema,
  planned: z.boolean().optional(),
}).strict();

export const admissionsUsAcademicPayloadSchema = z.object({
  system: z.literal("us"),
  gpaScale: z.number().positive().max(100),
  unweightedGpa: z.number().min(0).max(100).nullable().optional(),
  weightedGpa: z.number().min(0).max(100).nullable().optional(),
  coreGpa: z.number().min(0).max(100).nullable().optional(),
  classRank: z.number().int().positive().nullable().optional(),
  classSize: z.number().int().positive().nullable().optional(),
  courseRigor: z.enum([
    "most_demanding",
    "very_demanding",
    "demanding",
    "average",
    "not_reported",
  ]).nullable().optional(),
  fourYearCoursePlan: z.array(admissionsCoursePlanItemSchema).max(120).default([]),
  transcriptUrl: nullableUrlSchema,
  schoolProfileUrl: nullableUrlSchema,
}).strict().superRefine((payload, ctx) => {
  if (
    payload.classRank != null &&
    payload.classSize != null &&
    payload.classRank > payload.classSize
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["classRank"],
      message: "Class rank cannot exceed class size",
    });
  }
});

export const admissionsIbSubjectSchema = z.object({
  subject: z.string().trim().min(1).max(120),
  level: z.enum(["MYP", "SL", "HL"]),
  predictedGrade: z.number().int().min(1).max(7).nullable().optional(),
  finalGrade: z.number().int().min(1).max(7).nullable().optional(),
}).strict();

export const admissionsIbAcademicPayloadSchema = z.object({
  system: z.literal("ib"),
  program: z.enum(["myp", "dp", "myp_dp"]),
  subjects: z.array(admissionsIbSubjectSchema).max(30).default([]),
  tokGrade: z.enum(["A", "B", "C", "D", "E"]).nullable().optional(),
  extendedEssayGrade: z.enum(["A", "B", "C", "D", "E"]).nullable().optional(),
  casCompleted: z.boolean().nullable().optional(),
  predictedTotal: z.number().int().min(0).max(45).nullable().optional(),
  finalTotal: z.number().int().min(0).max(45).nullable().optional(),
  transcriptUrl: nullableUrlSchema,
  schoolProfileUrl: nullableUrlSchema,
}).strict();

export const admissionsUkSubjectSchema = z.object({
  qualification: z.enum(["igcse", "as", "a_level"]),
  subject: z.string().trim().min(1).max(120),
  board: z.string().trim().min(1).max(120),
  predictedGrade: nullableGradeSchema,
  achievedGrade: nullableGradeSchema,
}).strict();

export const admissionsUkAcademicPayloadSchema = z.object({
  system: z.literal("a_level_igcse"),
  subjects: z.array(admissionsUkSubjectSchema).max(60).default([]),
  curriculumNotes: nullableTextSchema,
  transcriptUrl: nullableUrlSchema,
  schoolProfileUrl: nullableUrlSchema,
}).strict();

/** Strict, discriminated storage/API contract for an academic record. */
export const academicRecordPayloadSchema = z.discriminatedUnion("system", [
  admissionsUsAcademicPayloadSchema,
  admissionsIbAcademicPayloadSchema,
  admissionsUkAcademicPayloadSchema,
]);

export type AdmissionsCoursePlanItem = z.infer<typeof admissionsCoursePlanItemSchema>;
export type AdmissionsUsAcademicPayload = z.infer<typeof admissionsUsAcademicPayloadSchema>;
export type AdmissionsIbSubject = z.infer<typeof admissionsIbSubjectSchema>;
export type AdmissionsIbAcademicPayload = z.infer<typeof admissionsIbAcademicPayloadSchema>;
export type AdmissionsUkSubject = z.infer<typeof admissionsUkSubjectSchema>;
export type AdmissionsUkAcademicPayload = z.infer<typeof admissionsUkAcademicPayloadSchema>;
export type AcademicRecordPayload = z.infer<typeof academicRecordPayloadSchema>;

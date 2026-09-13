import { z } from "zod";
import { paperSchema, markSchema, reportSchema, MAX_FILE_BYTES, SOURCE_TYPES } from "./model";

const id = z.string().uuid();
const revision = z.number().int().nonnegative();
const target = { id, expectedRevision: revision };
export const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create-paper"), title: z.string().trim().min(1).max(300), ownerKey: z.string().optional(), assessmentId: id.optional() }).strict(),
  z.object({ action: z.literal("attach-original"), ...target, sourceFileId: id, keyFileId: id.nullable() }).strict(),
  z.object({ action: z.literal("format-paper"), ...target, sourceFileId: id, keyFileId: id.nullable() }).strict(),
  z.object({ action: z.literal("approve-paper"), ...target, versionId: id, confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("approve-rubric"), ...target, versionId: id, confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("save-paper"), ...target, paper: paperSchema, sourceFileId: id.nullable(), keyFileId: id.nullable(), approved: z.boolean() }).strict(),
  z.object({ action: z.literal("process-paper"), ...target, sourceFileId: id, keyFileId: id.nullable() }).strict(),
  z.object({ action: z.literal("preview-paper"), ...target }).strict(),
  z.object({ action: z.literal("prepare"), ...target, paperVersionId: id, topics: z.string().trim().min(1).max(10000), studentInformed: z.boolean() }).strict(),
  z.object({ action: z.literal("submit"), ...target, sessionId: z.string().min(1).max(150), fileIds: z.array(id).min(1).max(30), pageOrder: z.array(z.object({ fileId: id, page: z.number().int().positive() }).strict()).min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("grade"), ...target }).strict(),
  z.object({ action: z.literal("report"), ...target }).strict(),
  z.object({ action: z.literal("save-review"), ...target, marks: z.array(markSchema).min(1).max(200), report: reportSchema }).strict(),
  z.object({ action: z.literal("save-marked-review"), ...target, markedFileId: id, earned: z.number().nonnegative(), possible: z.number().positive(), report: reportSchema }).strict(),
  z.object({ action: z.literal("preview-review"), ...target }).strict(),
  z.object({ action: z.literal("approve"), ...target, confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("publish"), ...target, publicationId: id.optional() }).strict(),
  z.object({ action: z.literal("upload-intent"), ownerKey: z.string().optional(), assessmentId: id.optional(), name: z.string().min(1).max(250), mime: z.enum(SOURCE_TYPES), size: z.number().int().positive().max(MAX_FILE_BYTES), purpose: z.enum(["paper", "key", "work", "marked"]) }).strict(),
  z.object({ action: z.literal("retry-job"), id }).strict(),
  z.object({ action: z.literal("publishing"), enabled: z.boolean(), expectedRevision: revision }).strict(),
  z.object({ action: z.literal("formatting"), enabled: z.boolean(), expectedRevision: revision }).strict(),
  z.object({ action: z.literal("activate") }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;

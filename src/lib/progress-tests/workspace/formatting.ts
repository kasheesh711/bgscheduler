import { and, eq, sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { DeferredProcessing, requireProcessingTime } from "./processing-budget";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { assertOwner, paperCoverageWarnings, structuredPaper, WorkspaceError } from "./model";
import { scopeForEmail } from "./access";
import { fileForScope, readBlobBytes, storeGenerated } from "./files";
import { visualPdf } from "./documents";
import { formatPaper, FORMAT_INSTRUCTIONS, FORMAT_PROMPT_VERSION, formatModel, formatEffort, type FormatEffort } from "./ai";
import { PAPER_RENDERER_VERSION, renderFormattedPaper, renderMarkingScheme } from "./paper-renderer";

type Job = typeof s.ptJobs.$inferSelect;
/** Each checkpoint belongs to this job's immutable source/version, not the latest library revision. */
export async function runFormatting(job: Job, db: Database, deadline = Date.now() + 280_000) {
  let checkpoint = { ...job.checkpoint }, stage = job.stage, stageStarted = job.stageStartedAt?.getTime() ?? Date.now();
  const timings = { ...job.timings };
  const guard = async (persistingResponse = false) => {
    const [settings] = await db.select().from(s.ptWorkspaceSettings).where(eq(s.ptWorkspaceSettings.id, "workspace"));
    if (settings && !settings.formattingEnabled && !persistingResponse) throw new DeferredProcessing("Formatting is paused. Your original paper remains available.");
    const scope = await scopeForEmail(job.createdBy, db);
    assertOwner(scope.keys, job.ownerKey);
    const [contact] = await db.select().from(s.tutorContacts).where(and(eq(s.tutorContacts.canonicalKey, job.ownerKey), eq(s.tutorContacts.active, true)));
    if (!contact) throw new WorkspaceError(403, "The tutor's access is no longer active.");
    const [lease] = await db.select({ id: s.ptJobs.id }).from(s.ptJobs).where(and(eq(s.ptJobs.id, job.id), eq(s.ptJobs.leaseToken, job.leaseToken!), eq(s.ptJobs.status, "running"), sql`${s.ptJobs.leaseUntil} > clock_timestamp()`));
    if (!lease) throw new WorkspaceError(503, "This worker lease expired. The next worker will resume the saved progress.");
    return scope;
  };
  const save = async (nextStage: string, patch: Record<string, unknown> = {}) => {
    await guard();
    const now = Date.now();
    if (nextStage !== stage) { if (stage !== "queued") timings[stage] = (timings[stage] ?? 0) + now - stageStarted; stageStarted = now; }
    checkpoint = { ...checkpoint, ...patch }; stage = nextStage;
    const rows = await db.update(s.ptJobs).set({ checkpoint, stage, stageStartedAt: new Date(stageStarted), timings }).where(and(eq(s.ptJobs.id, job.id), eq(s.ptJobs.leaseToken, job.leaseToken!), eq(s.ptJobs.status, "running"))).returning({ id: s.ptJobs.id });
    if (!rows.length) throw new WorkspaceError(409, "Processing moved to another worker.");
  };
  const normalize = async (inputId: string, key: string, expectedHash: unknown) => {
    const scope = await guard();
    const file = await fileForScope(scope, inputId, db);
    if (file.ownerKey !== job.ownerKey || file.status !== "ready" || file.sha256 !== expectedHash) throw new WorkspaceError(400, "An uploaded source no longer matches this formatting request.");
    if (typeof checkpoint[key] === "string") return checkpoint[key] as string;
    requireProcessingTime(deadline, job.leaseUntil, file.mime === "application/pdf" ? 5_000 : 45_000);
    const normalized = file.mime === "application/pdf" ? file : await storeGenerated(job.ownerKey, `${file.name}.visual.pdf`, await visualPdf(file), db);
    await save("reading", { [key]: normalized.id });
    return normalized.id;
  };
  await save("reading");
  if (job.input.sourceVersionId) {
    const [original] = await db.select().from(s.ptPaperVersions).where(and(eq(s.ptPaperVersions.id, String(job.input.sourceVersionId)), eq(s.ptPaperVersions.paperId, job.targetId)));
    if (!original || !("kind" in original.paper) || original.paper.kind !== "original" || original.sourceFileId !== job.input.sourceFileId || original.keyFileId !== job.input.keyFileId) throw new WorkspaceError(400, "The original paper version does not match this formatting request.");
  }
  const sourceId = await normalize(String(job.input.sourceFileId), "visualSourceId", job.input.sourceHash);
  const keyId = job.input.keyFileId ? await normalize(String(job.input.keyFileId), "visualKeyId", job.input.keyHash) : null;
  const read = async (id: string) => {
    const file = await fileForScope(await guard(), id, db);
    if (file.ownerKey !== job.ownerKey) throw new WorkspaceError(404, "Source file not found.");
    return { name: file.name, bytes: await readBlobBytes(file) };
  };
  const source = await read(sourceId);
  const pageCount = (await PDFDocument.load(source.bytes)).getPageCount();
  const versionId = String(job.input.versionId);
  let [version] = await db.select().from(s.ptPaperVersions).where(and(eq(s.ptPaperVersions.id, versionId), eq(s.ptPaperVersions.paperId, job.targetId)));
  await save("formatting", { pageCount, model: checkpoint.model ?? job.input.model ?? formatModel(), reasoningEffort: checkpoint.reasoningEffort ?? job.input.reasoningEffort ?? formatEffort(), promptVersion: checkpoint.promptVersion ?? job.input.promptVersion ?? FORMAT_PROMPT_VERSION });
  await db.update(s.ptJobAttempts).set({ model: version ? null : String(checkpoint.model), prompt: version ? null : String(job.input.formatPrompt ?? FORMAT_INSTRUCTIONS), input: { ...job.input, visualSourceId: sourceId, visualKeyId: keyId, pageCount, reasoningEffort: checkpoint.reasoningEffort, promptVersion: checkpoint.promptVersion, reusedVersionId: version?.id ?? null } }).where(and(eq(s.ptJobAttempts.jobId, job.id), eq(s.ptJobAttempts.attempt, job.attempts)));
  if (!version) {
    if (checkpoint.aiStartedAt) throw new WorkspaceError(400, "The earlier AI request was interrupted. Your original is available; retry explicitly to request formatting again.");
    requireProcessingTime(deadline, job.leaseUntil, 180_000);
    await save("formatting", { aiStartedAt: new Date().toISOString() });
    const result = await formatPaper([source, ...(keyId ? [await read(keyId)] : [])], pageCount, String(checkpoint.model), checkpoint.reasoningEffort as FormatEffort, String(job.input.formatPrompt ?? FORMAT_INSTRUCTIONS));
    const paper = { ...result.data, warnings: [...new Set([...result.data.warnings, ...paperCoverageWarnings(result.data, pageCount)])] };
    // Persist a completed response even if an administrator paused new formatting meanwhile.
    await guard(true);
    await withDatabaseTransaction(db, async tx => {
      const [lease] = await tx.select().from(s.ptJobs).where(and(eq(s.ptJobs.id, job.id), eq(s.ptJobs.leaseToken, job.leaseToken!), eq(s.ptJobs.status, "running"), sql`${s.ptJobs.leaseUntil} > clock_timestamp()`)).for("update");
      if (!lease) throw new WorkspaceError(503, "Processing moved to another worker; saved progress will resume.");
      [version] = await tx.insert(s.ptPaperVersions).values({ id: versionId, paperId: job.targetId, revision: job.expectedRevision, sourceVersionId: typeof job.input.sourceVersionId === "string" ? job.input.sourceVersionId : null, sourceFileId: String(job.input.sourceFileId), keyFileId: job.input.keyFileId ? String(job.input.keyFileId) : null, paper, model: result.model, createdBy: job.createdBy }).returning();
      await tx.update(s.ptPapers).set({ title: paper.title }).where(and(eq(s.ptPapers.id, job.targetId), eq(s.ptPapers.revision, job.expectedRevision)));
    });
    await save("building", { versionId, responseId: result.responseId, usage: result.usage });
  } else await save("building", { versionId });
  const content = structuredPaper(version.paper);
  const render = async (kind: "paper" | "key") => {
    const [existing] = await db.select().from(s.ptPaperArtifacts).where(and(eq(s.ptPaperArtifacts.versionId, versionId), eq(s.ptPaperArtifacts.kind, kind)));
    if (existing) return existing.fileId;
    const checkpointKey = `${kind}FileId`;
    let id = checkpoint[checkpointKey] as string | undefined;
    if (!id) {
      await guard();
      requireProcessingTime(deadline, job.leaseUntil, 45_000);
      const bytes = kind === "paper" ? await renderFormattedPaper(content, source.bytes) : await renderMarkingScheme(content);
      await guard();
      const file = await storeGenerated(job.ownerKey, `${version.paper.title} - ${kind === "paper" ? "test paper" : "private marking scheme"} - v${version.revision}.pdf`, bytes, db);
      id = file.id;
      await save("building", { [checkpointKey]: id });
    }
    await guard();
    await db.insert(s.ptPaperArtifacts).values({ versionId, kind, fileId: id, rendererVersion: PAPER_RENDERER_VERSION }).onConflictDoNothing();
    return id;
  };
  const fileId = await render("paper"), keyFileId = await render("key");
  await save("checking");
  for (const id of [fileId, keyFileId]) {
    const file = await fileForScope(await guard(), id, db);
    if (file.status !== "ready" || !file.sha256 || !file.pageCount) throw new WorkspaceError(503, "The generated PDF is not ready to download. Retrying verification.");
  }
  await save("ready");
  return { type: "formatted-paper", versionId, fileId, keyFileId, warnings: content.warnings };
}

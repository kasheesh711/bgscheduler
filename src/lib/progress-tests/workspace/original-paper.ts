import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { scopeForEmail } from "./access";
import { assertOwner, isOriginalPaper, WorkspaceError } from "./model";
import { fileForScope, readBlobBytes, storeGenerated, validateSource } from "./files";
import { convertDocx } from "./documents";
import { requireProcessingTime } from "./processing-budget";

export async function runOriginalConversion(job: typeof s.ptJobs.$inferSelect, db: Database, deadline: number) {
  const guard = async () => {
    const scope = await scopeForEmail(job.createdBy, db);
    assertOwner(scope.keys, job.ownerKey);
    const [lease] = await db.select().from(s.ptJobs).where(and(eq(s.ptJobs.id, job.id), eq(s.ptJobs.leaseToken, job.leaseToken!), eq(s.ptJobs.status, "running"), sql`${s.ptJobs.leaseUntil} > clock_timestamp()`));
    if (!lease) throw new WorkspaceError(503, "The conversion lease expired. Retry to resume.");
    return scope;
  };
  const scope = await guard();
  const [version] = await db.select().from(s.ptPaperVersions).where(eq(s.ptPaperVersions.id, job.targetId));
  const [paper] = version ? await db.select().from(s.ptPapers).where(eq(s.ptPapers.id, version.paperId)) : [];
  if (!version || !paper || paper.ownerKey !== job.ownerKey || !isOriginalPaper(version.paper) || version.sourceFileId !== job.input.sourceFileId) throw new WorkspaceError(404, "Original paper not found.");
  const [existing] = await db.select().from(s.ptPaperArtifacts).where(and(eq(s.ptPaperArtifacts.versionId, version.id), eq(s.ptPaperArtifacts.kind, "paper")));
  if (existing) return { versionId: version.id, fileId: existing.fileId };
  const source = await fileForScope(scope, version.sourceFileId!, db);
  if (source.ownerKey !== job.ownerKey || source.status !== "ready" || source.sha256 !== job.input.sourceHash || source.purpose !== "paper") throw new WorkspaceError(400, "The upload does not match this original paper.");
  let fileId = typeof job.checkpoint.fileId === "string" ? job.checkpoint.fileId : null;
  if (!fileId) {
    requireProcessingTime(deadline, job.leaseUntil, 60_000);
    await db.update(s.ptJobs).set({ stage: "converting", stageStartedAt: new Date() }).where(and(eq(s.ptJobs.id, job.id), eq(s.ptJobs.leaseToken, job.leaseToken!)));
    const bytes = await readBlobBytes(source);
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new WorkspaceError(400, "The original upload failed its integrity check.");
    const converted = source.mime === "application/pdf" ? bytes : await convertDocx(bytes);
    await validateSource(converted, "application/pdf");
    await guard();
    fileId = (await storeGenerated(job.ownerKey, paper.title + " - original.pdf", converted, db)).id;
    await db.update(s.ptJobs).set({ checkpoint: { ...job.checkpoint, fileId } }).where(and(eq(s.ptJobs.id, job.id), eq(s.ptJobs.leaseToken, job.leaseToken!)));
  }
  const file = await fileForScope(await guard(), fileId, db);
  if (file.ownerKey !== job.ownerKey || file.status !== "ready" || file.mime !== "application/pdf" || !file.sha256) throw new WorkspaceError(400, "Converted PDF is unavailable.");
  await withDatabaseTransaction(db, async tx => {
    const [lease] = await tx.select().from(s.ptJobs).where(and(eq(s.ptJobs.id, job.id), eq(s.ptJobs.leaseToken, job.leaseToken!), eq(s.ptJobs.status, "running"), sql`${s.ptJobs.leaseUntil} > clock_timestamp()`)).for("update");
    if (!lease) throw new WorkspaceError(503, "The conversion lease expired before saving.");
    await tx.insert(s.ptPaperArtifacts).values({ versionId: version.id, kind: "paper", fileId: file.id, rendererVersion: "original-docx-v1" }).onConflictDoNothing();
    await tx.update(s.ptJobs).set({ stage: "ready" }).where(eq(s.ptJobs.id, job.id));
  });
  return { versionId: version.id, fileId: file.id };
}

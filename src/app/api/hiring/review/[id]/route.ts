import { PassThrough, Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import JSZip from "jszip";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hiringBookings as b, hiringPaperResults as p } from "@/lib/db/schema";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { headRecommendation } from "@/lib/hiring/decisions";
import { draftReviewPacket, finalReviewAccess, latestReviewPacket, reviewPacketValid, signOffReview, submitReview } from "@/lib/hiring/final-review";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { OFFER_TYPES } from "@/lib/hiring/offer-letters";
import { markedFile } from "@/lib/hiring/marked-file";
import { HiringError } from "@/lib/hiring/model";
import { resumeAttachment } from "@/lib/hiring/resume-files";
import { reviewDocument } from "@/lib/hiring/review-document";
import { candidateById, hadCall, settings } from "@/lib/hiring/service";
import { deliverOutbox } from "@/lib/hiring/worker";

export const maxDuration = 120;
type Context = { params: Promise<{ id: string }> };
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};
const draft = { behavioral: z.string().trim().min(10).max(10000), offerType: z.enum(OFFER_TYPES) };
const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit"), ...draft }).strict(),
  z.object({ action: z.literal("preview"), ...draft }).strict(),
  z.object({ action: z.literal("sign"), packetId: z.uuid(), decision: z.enum(["hire", "reject"]), reason: z.string().trim().max(2000) }).strict(),
]);

export async function GET(request: Request, { params }: Context) {
  try {
    const actor = await requireHiringAdmin();
    const access = finalReviewAccess(actor);
    if (!access.hr && !access.gift) throw new HiringError(403, "This review is for HR and Gift.");
    const id = z.uuid().parse((await params).id);
    const db = getDb();
    const candidate = await candidateById(db, id);
    const saved = await latestReviewPacket(db, id);
    const file = new URL(request.url).searchParams.get("file");
    if (!file) {
      const [appointment] = candidate.stage === "hired"
        ? await db.select({ start: b.startTime }).from(b).where(and(eq(b.candidateId, id), eq(b.kind, "contract"), eq(b.status, "confirmed")))
        : [];
      // With no HR call, the head's behavioural assessment from the mock lesson is the starting text (Kevin, 24 Nov 2026).
      const called = hadCall(candidate.callReview);
      const fromHead = called ? "" : String((await headRecommendation(db, id))?.detail.behavioral ?? "");
      return NextResponse.json({
        access, stage: candidate.stage, callNotes: access.hr ? candidate.callReview?.notes?.text || fromHead : "", behavioralFrom: called ? "call" : "head", appointment: appointment?.start ?? null,
        packet: saved && { id: saved.id, behavioral: saved.behavioral, offer: saved.offer, offerType: saved.offerType ?? null },
        packetValid: await reviewPacketValid(db, id, saved),
      }, { headers });
    }
    // The file links in HR's preview: the current evidence, not the last sent packet.
    const draft = new URL(request.url).searchParams.has("draft");
    if (draft && file !== "resume" && file !== "paper") throw new HiringError(404, "File unavailable.");
    const packet = draft ? await draftReviewPacket(db, id, actor) : saved;
    if (!packet) throw new HiringError(404, "HR has not submitted this review.");
    const [paper] = await db.select().from(p).where(and(eq(p.id, packet.evidence.paper.id), eq(p.candidateId, id)));
    if (!paper || paper.updatedAt.toISOString() !== packet.evidence.paper.updatedAt ||
      candidate.resumeSha256 !== packet.evidence.resumeSha256)
      throw new HiringError(409, "A source file changed. Ask HR to submit a new review packet.");
    if (file === "html") return new Response(await reviewDocument(packet, `/api/hiring/review/${id}?file=resume`, `/api/hiring/review/${id}?file=paper`), {
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": csp },
    });
    if (file === "paper") return await markedFile(paper, db);
    if (file !== "resume" && file !== "zip") throw new HiringError(404, "File unavailable.");
    const resume = await resumeAttachment(id, db);
    if (!resume) throw new HiringError(404, "The original résumé could not be opened.");
    const resumeName = resume.type === "application/pdf" ? "resume.pdf" : "resume.docx";
    if (file === "resume") return new Response(new Uint8Array(resume.content), {
      headers: { ...headers, "Content-Type": resume.type, "Content-Disposition": `attachment; filename="${resumeName}"` },
    });
    const zip = new JSZip();
    zip.file(resumeName, resume.content);
    zip.file("marked-exam.pdf", await (await markedFile(paper, db)).arrayBuffer());
    zip.file("hiring-review.html", await reviewDocument(packet, resumeName, "marked-exam.pdf"));
    const stream = new PassThrough();
    const archive = zip.generateNodeStream({ streamFiles: true });
    archive.on("error", (error: Error) => stream.destroy(error)).pipe(stream);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: { ...headers, "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="BeGifted-hiring-review.zip"' },
    });
  } catch (error) {
    return hiringError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const actor = await requireHiringAdmin();
    requireSameOrigin(request);
    const id = z.uuid().parse((await params).id);
    const value = input.parse(await request.json());
    const db = getDb();
    if (value.action === "preview") {
      const file = `/api/hiring/review/${id}?draft=1&file=`;
      return new Response(await reviewDocument(await draftReviewPacket(db, id, actor, value), `${file}resume`, `${file}paper`), {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp },
      });
    }
    const key = value.action === "submit"
      ? await submitReview(db, id, actor, { behavioral: value.behavioral, offerType: value.offerType })
      : await signOffReview(db, id, value.packetId, actor, value.decision, value.reason);
    after(async () => {
      const { config } = await settings(db);
      await deliverOutbox(db, config, 1, false, key);
    });
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    return hiringError(error);
  }
}

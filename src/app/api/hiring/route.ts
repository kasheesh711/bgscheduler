import { z } from "zod";
import { after, NextResponse } from "next/server";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { configSchema, localDate, subjectSchema } from "@/lib/hiring/model";
import { headWeek } from "@/lib/hiring/head-schedule";
import { candidateById, changePreScreenScore, dashboard, reviewCandidate, saveHeadDays, saveSettings, settings } from "@/lib/hiring/service";
import { moveInQueue, resetQueueOrder } from "@/lib/hiring/queue";
import { deliverBookingMessages } from "@/lib/hiring/worker";
import { getDb } from "@/lib/db";
import { googleConnectionStatus } from "@/lib/hiring/google";

// A dashboard or head-schedule load can trigger a cold Wise index build.
export const maxDuration = 120;
const headQuery = z.object({
  head: z.string().trim().min(1).max(200),
  weekStart: z.iso.date().optional(),
});
const command = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("settings"),
      revision: z.number().int().nonnegative(),
      config: configSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("head_days"),
      key: z.string().trim().min(1).max(200),
      // Monday to Friday.
      days: z.array(z.boolean()).length(5),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("queue_move"),
      id: z.uuid(),
      // Far above any real queue. The job has hundreds of applications.
      ahead: z.array(z.uuid()).max(20000),
    })
    .strict(),
  z.object({ action: z.literal("queue_reset") }).strict(),
  z
    .object({
      action: z.literal("pre_screen_score"),
      id: z.uuid(),
      revision: z.number().int().nonnegative(),
      score: z.number().min(0).max(100),
      reason: z.string().trim().min(5).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.enum(["advance", "paper_pass", "stop", "invite_onsite", "send_new_link", "cancel_visit", "mark_no_show"]),
      id: z.uuid(),
      revision: z.number().int().nonnegative(),
      subjects: z.array(subjectSchema).max(18),
      reason: z.string().trim().min(5).max(2000),
    })
    .strict(),
]);
export async function GET(request: Request) {
  try {
    await requireHiringAdmin();
    const params = new URL(request.url).searchParams;
    if (params.has("head")) {
      const query = headQuery.parse({
        head: params.get("head"),
        weekStart: params.get("weekStart") ?? undefined,
      });
      const db = getDb();
      const { config } = await settings(db);
      return NextResponse.json(
        await headWeek(db, config, query.head, query.weekStart ?? localDate(new Date())),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const id = params.get("candidateId");
    if (id !== null) {
      const candidate = await candidateById(getDb(), z.uuid().parse(id));
      return NextResponse.json(
        { id: candidate.id, profileText: candidate.profileText },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const data = await dashboard();
    return NextResponse.json(
      {
        ...data,
        google: await googleConnectionStatus(data.config.connectedEmail),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return hiringError(error);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await requireHiringAdmin();
    requireSameOrigin(request);
    const input = command.parse(await request.json());
    if (input.action === "settings") {
      await saveSettings(input.config, input.revision, actor);
      return NextResponse.json({ ok: true });
    }
    if (input.action === "head_days") {
      const saved = await saveHeadDays(input.key, input.days, input.revision, actor);
      return NextResponse.json({ ok: true, ...saved });
    }
    if (input.action === "queue_move") {
      await moveInQueue(input.id, input.ahead, actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "queue_reset") {
      await resetQueueOrder(actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "pre_screen_score") {
      await changePreScreenScore(input.id, input, actor);
      return NextResponse.json({ ok: true });
    }
    await reviewCandidate(input.id, input, actor);
    after(() => deliverBookingMessages());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return hiringError(error);
  }
}

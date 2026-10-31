import { z } from "zod";
import { NextResponse } from "next/server";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { configSchema, subjectSchema } from "@/lib/hiring/model";
import { candidateById, dashboard, reviewCandidate, saveSettings } from "@/lib/hiring/service";
import { getDb } from "@/lib/db";
import { googleConnectionStatus } from "@/lib/hiring/google";

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
      action: z.enum(["advance", "paper_pass", "stop"]),
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
    const id = new URL(request.url).searchParams.get("candidateId");
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
    if (input.action === "settings")
      await saveSettings(input.config, input.revision, actor);
    else await reviewCandidate(input.id, input, actor);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return hiringError(error);
  }
}

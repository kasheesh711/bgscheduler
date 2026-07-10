import { NextResponse } from "next/server";
import { z } from "zod";

import {
  admissionsErrorResponse,
  requireCounselorOrAdmin,
  requireAdmissionsSession,
} from "@/lib/admissions/access";
import {
  createEssayPrompt,
  listEssayPromptCatalog,
  updateEssayPrompt,
} from "@/lib/admissions/essay-prompt-catalog";
import { roleAtLeast } from "@/lib/admissions/config";
import { admissionsHttpUrlSchema } from "@/lib/admissions/shared/urls";

const ROUTE = "/api/admissions/prompt-catalog";
const fields = {
  unitId: z.number().int().positive().nullish(),
  institution: z.string().trim().min(1).max(500),
  program: z.string().max(500),
  cycle: z.string().trim().min(1).max(30),
  promptKey: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  wordLimit: z.number().int().positive().max(10_000).nullish(),
  required: z.boolean(),
  sourceUrl: admissionsHttpUrlSchema.nullish(),
  verified: z.boolean(),
};
const createSchema = z.object({
  action: z.literal("create"),
  unitId: fields.unitId,
  institution: fields.institution,
  program: fields.program.optional(),
  cycle: fields.cycle,
  promptKey: fields.promptKey,
  prompt: fields.prompt,
  wordLimit: fields.wordLimit,
  required: fields.required.optional(),
  sourceUrl: fields.sourceUrl,
  verified: fields.verified.optional(),
});
const updateSchema = z.object({
  action: z.literal("update"),
  promptId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(),
  unitId: fields.unitId,
  institution: fields.institution.optional(),
  program: fields.program.optional(),
  cycle: fields.cycle.optional(),
  promptKey: fields.promptKey.optional(),
  prompt: fields.prompt.optional(),
  wordLimit: fields.wordLimit,
  required: fields.required.optional(),
  sourceUrl: fields.sourceUrl,
  active: z.boolean().optional(),
  verified: fields.verified.optional(),
});
const mutationSchema = z.discriminatedUnion("action", [createSchema, updateSchema]);

export async function GET(request: Request) {
  try {
    const user = await requireAdmissionsSession();
    const params = new URL(request.url).searchParams;
    const unitRaw = params.get("unitId");
    const parsed = z.object({
      institution: z.string().max(500).optional(),
      cycle: z.string().max(30).optional(),
      unitId: z.coerce.number().int().positive().optional(),
      activeOnly: z.enum(["true", "false"]).optional(),
    }).safeParse({
      institution: params.get("institution") || undefined,
      cycle: params.get("cycle") || undefined,
      unitId: unitRaw || undefined,
      activeOnly: params.get("activeOnly") || undefined,
    });
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    const isStaff = roleAtLeast(user.role, "counselor");
    if (isStaff) {
      // Re-resolve staff authority on every request. A stale counselor JWT must
      // not expose unpublished catalog entries after registry deactivation.
      await requireCounselorOrAdmin(user.email);
    }
    const prompts = await listEssayPromptCatalog({
      institution: parsed.data.institution,
      cycle: parsed.data.cycle,
      unitId: parsed.data.unitId,
      activeOnly: isStaff ? parsed.data.activeOnly !== "false" : true,
    });
    return NextResponse.json({
      prompts: isStaff
        ? prompts
        : prompts.map((prompt) => ({
          id: prompt.id,
          unitId: prompt.unitId,
          institution: prompt.institution,
          program: prompt.program,
          cycle: prompt.cycle,
          promptKey: prompt.promptKey,
          prompt: prompt.prompt,
          wordLimit: prompt.wordLimit,
          required: prompt.required,
          sourceUrl: prompt.sourceUrl,
          verifiedAt: prompt.verifiedAt,
          active: prompt.active,
        })),
    });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Prompt catalog load failed");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAdmissionsSession();
    const staff = await requireCounselorOrAdmin(user.email);
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = mutationSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
    let prompt;
    if (parsed.data.action === "create") {
      const input = { ...parsed.data };
      Reflect.deleteProperty(input, "action");
      prompt = await createEssayPrompt({ actorEmail: staff.email, actorRole: staff.role, ...input });
    } else {
      const input = { ...parsed.data };
      Reflect.deleteProperty(input, "action");
      prompt = await updateEssayPrompt({ actorEmail: staff.email, actorRole: staff.role, ...input });
    }
    return NextResponse.json({ prompt });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Prompt catalog mutation failed");
  }
}

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireCompetitorIntelligenceSession } from "@/lib/competitor-intelligence/access";
import { runCompetitorIntelligenceSync } from "@/lib/competitor-intelligence/sync";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";

export const maxDuration = 800;

type CronSecretStatus = "valid" | "invalid" | "missing-secret";

function hasValidCronSecret(request: NextRequest): CronSecretStatus {
  const authHeader = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return "missing-secret";
  const received = Buffer.from(authHeader);
  const known = Buffer.from(`Bearer ${cronSecret}`);
  return received.length === known.length && timingSafeEqual(received, known) ? "valid" : "invalid";
}

async function handleSync(request: NextRequest, options: { allowSessionAuth: boolean }) {
  const cronSecretStatus = hasValidCronSecret(request);
  let actorEmail = "cron@begifted.local";

  if (cronSecretStatus !== "valid") {
    if (!options.allowSessionAuth) {
      return NextResponse.json(
        { error: cronSecretStatus === "missing-secret" ? "Server misconfigured" : "Unauthorized" },
        { status: cronSecretStatus === "missing-secret" ? 500 : 401 },
      );
    }
    try {
      const user = await requireCompetitorIntelligenceSession();
      actorEmail = user.email;
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return withCronInvocationAudit(
    {
      jobKey: "competitor_intelligence",
      triggerSource: cronSecretStatus === "valid" ? "cron" : "admin",
      actorEmail,
      requestMethod: request.method,
    },
    async () => {
      try {
        const result = await runCompetitorIntelligenceSync({
          triggerType: cronSecretStatus === "valid" ? "cron" : "manual",
          actorEmail,
        });
        return NextResponse.json({ ok: result.status === "success", result }, {
          status: result.status === "success" ? 200 : 500,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Competitor intelligence sync failed";
        return NextResponse.json(
          { error: message },
          { status: message.includes("already running") ? 409 : 500 },
        );
      }
    },
  );
}

export async function GET(request: NextRequest) {
  return handleSync(request, { allowSessionAuth: false });
}

export async function POST(request: NextRequest) {
  return handleSync(request, { allowSessionAuth: true });
}

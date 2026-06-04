import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import {
  importActiveSalesDashboardProjectionSource,
  importRefreshableSalesSources,
} from "@/lib/sales-dashboard/data";
import { MissingGoogleSheetsTokenError } from "@/lib/sales-dashboard/google-oauth";

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
    if (options.allowSessionAuth) {
      const session = await auth();
      if (session?.user?.email) actorEmail = session.user.email;
      else if (cronSecretStatus === "missing-secret") {
        return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
      } else {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    } else if (cronSecretStatus === "missing-secret") {
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    } else {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return withCronInvocationAudit(
    {
      jobKey: "sales_dashboard",
      triggerSource: cronSecretStatus === "valid" ? "cron" : "admin",
      actorEmail,
      requestMethod: request.method,
    },
    async () => {
      try {
        const results = await importRefreshableSalesSources({
          triggerType: "cron",
          actorEmail,
        });
        const projectionResult = await importActiveSalesDashboardProjectionSource({
          triggerType: "cron",
          actorEmail,
        });
        return NextResponse.json({ ok: true, results, projectionResult });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sales dashboard sync failed";
        const status = error instanceof MissingGoogleSheetsTokenError ? 409 : 500;
        return NextResponse.json({ error: message }, { status });
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

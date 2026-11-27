import { NextResponse } from "next/server";
import type { HandleUploadBody } from "@vercel/blob/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { readSignedContract, signedContractInfo, signedContractUploadHandler } from "@/lib/hiring/contract-templates";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" };

/** `?candidateId=` says if the signed contract is uploaded. With `&file=1` it is the PDF. */
export async function GET(request: Request) {
  try {
    await requireHiringAdmin();
    const query = new URL(request.url).searchParams;
    const candidateId = z.uuid().parse(query.get("candidateId"));
    if (!query.has("file")) return NextResponse.json(await signedContractInfo(candidateId, getDb()), { headers });
    const file = await readSignedContract(candidateId, getDb());
    return new Response(file.stream, {
      headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${file.name}"` },
    });
  } catch (error) {
    return hiringError(error);
  }
}

/** The token step of a browser upload to private storage. */
export async function POST(request: Request) {
  try {
    const actor = await requireHiringAdmin();
    requireSameOrigin(request);
    return NextResponse.json(await signedContractUploadHandler(request, (await request.json()) as HandleUploadBody, actor, getDb()));
  } catch (error) {
    return hiringError(error);
  }
}

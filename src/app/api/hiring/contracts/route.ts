import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { CONTRACT_FORMATS, listContractTemplates, MAX_CONTRACT_BYTES, readContractTemplate, saveContractTemplate } from "@/lib/hiring/contract-templates";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { HiringError } from "@/lib/hiring/model";
import { OFFER_TYPES } from "@/lib/hiring/offer-letters";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" };
const type = z.enum(OFFER_TYPES);

/** The list of uploaded templates, or one template file with `?type=&format=`. */
export async function GET(request: Request) {
  try {
    await requireHiringAdmin();
    const query = new URL(request.url).searchParams;
    if (!query.has("type")) return NextResponse.json({ templates: await listContractTemplates() }, { headers });
    const file = await readContractTemplate(type.parse(query.get("type")), z.enum(CONTRACT_FORMATS).parse(query.get("format")));
    return new Response(file.stream, {
      headers: { ...headers, "Content-Type": file.contentType, "Content-Disposition": `attachment; filename="${file.name}"` },
    });
  } catch (error) {
    return hiringError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireHiringAdmin();
    requireSameOrigin(request);
    if (Number(request.headers.get("content-length")) > MAX_CONTRACT_BYTES + 4096) throw new HiringError(400, "Choose a file smaller than 4 MB.");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HiringError(400, "Choose a file.");
    const format = await saveContractTemplate(type.parse(form.get("type")), Buffer.from(await file.arrayBuffer()), actor, getDb());
    return NextResponse.json({ ok: true, format }, { headers });
  } catch (error) {
    return hiringError(error);
  }
}

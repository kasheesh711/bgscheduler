import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getInstitutionProfile } from "@/lib/us-universities/data";

const ParamsSchema = z.object({ unitId: z.coerce.number().int().positive() });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ unitId: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const profile = await getInstitutionProfile(parsed.data.unitId);
    if (!profile) {
      return NextResponse.json({ error: "Institution not found" }, { status: 404 });
    }
    return NextResponse.json(profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load institution";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

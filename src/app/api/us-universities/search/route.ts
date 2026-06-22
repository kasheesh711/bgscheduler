import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { searchInstitutions } from "@/lib/us-universities/data";
import {
  FilterQuerySchema,
  searchParamsToObject,
  toFilterParams,
} from "@/lib/us-universities/request";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const parsed = FilterQuerySchema.safeParse(searchParamsToObject(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await searchInstitutions(toFilterParams(parsed.data));
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to search institutions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

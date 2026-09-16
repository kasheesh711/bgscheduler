import { z } from "zod";
import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  assertSameOrigin,
  sitInError,
  sitInJson,
} from "@/lib/tutor-sit-ins/http";
import { quarterSchema } from "@/lib/tutor-sit-ins/model";
import { refreshQuarter } from "@/lib/tutor-sit-ins/service";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    const access = await requireSitInAccess();
    assertSameOrigin(request);
    const input = z
      .object({ quarter: quarterSchema })
      .strict()
      .parse(await request.json());
    return sitInJson(await refreshQuarter(access, input.quarter));
  } catch (e) {
    return sitInError(e);
  }
}

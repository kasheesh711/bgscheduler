import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  assertSameOrigin,
  sitInError,
  sitInJson,
} from "@/lib/tutor-sit-ins/http";
import { bookingSchema } from "@/lib/tutor-sit-ins/model";
import { bookObservation } from "@/lib/tutor-sit-ins/service";
import { detail } from "@/lib/tutor-sit-ins/repository";
import { processJobs } from "@/lib/tutor-sit-ins/worker";
export const maxDuration = 300;
export async function POST(
  request: Request,
  context: { params: Promise<{ assignmentId: string }> },
) {
  try {
    const access = await requireSitInAccess();
    assertSameOrigin(request);
    const id = z.uuid().parse((await context.params).assignmentId);
    const result = await bookObservation(
      access,
      id,
      bookingSchema.parse(await request.json()),
    );
    const observation = result.observations.find((o) => o.current);
    if (observation)
      await processJobs(getDb(), {
        observationId: observation.id,
        limit: 1,
        deadlineAt: Date.now() + 110_000,
      });
    return sitInJson(await detail(access, id, getDb()));
  } catch (e) {
    return sitInError(e);
  }
}

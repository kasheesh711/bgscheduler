import { z } from "zod";
import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  assertSameOrigin,
  sitInError,
  sitInJson,
} from "@/lib/tutor-sit-ins/http";
import {
  communicationSchema,
  acknowledgeCommunication,
} from "@/lib/tutor-sit-ins/service";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ communicationId: string }> },
) {
  try {
    const access = await requireSitInAccess();
    assertSameOrigin(request);
    return sitInJson(
      await acknowledgeCommunication(
        access,
        z.uuid().parse((await context.params).communicationId),
        communicationSchema.parse(await request.json()),
      ),
    );
  } catch (e) {
    return sitInError(e);
  }
}

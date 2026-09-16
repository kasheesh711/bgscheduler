import { z } from "zod";
import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  assertSameOrigin,
  sitInError,
  sitInJson,
} from "@/lib/tutor-sit-ins/http";
import { reportCommandSchema } from "@/lib/tutor-sit-ins/rubric";
import { saveReport } from "@/lib/tutor-sit-ins/service";
export async function PUT(
  request: Request,
  context: { params: Promise<{ reportId: string }> },
) {
  try {
    const access = await requireSitInAccess();
    assertSameOrigin(request);
    return sitInJson(
      await saveReport(
        access,
        z.uuid().parse((await context.params).reportId),
        reportCommandSchema.parse(await request.json()),
      ),
    );
  } catch (e) {
    return sitInError(e);
  }
}

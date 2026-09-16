import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  assertSameOrigin,
  sitInError,
  sitInJson,
} from "@/lib/tutor-sit-ins/http";
import { assignmentCommandSchema } from "@/lib/tutor-sit-ins/model";
import { detail } from "@/lib/tutor-sit-ins/repository";
import { assignmentCommand } from "@/lib/tutor-sit-ins/service";
type Context = { params: Promise<{ assignmentId: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const access = await requireSitInAccess();
    return sitInJson({
      ...(await detail(
        access,
        z.uuid().parse((await context.params).assignmentId),
        getDb(),
      )),
      access,
    });
  } catch (e) {
    return sitInError(e);
  }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const access = await requireSitInAccess();
    assertSameOrigin(request);
    return sitInJson(
      await assignmentCommand(
        access,
        z.uuid().parse((await context.params).assignmentId),
        assignmentCommandSchema.parse(await request.json()),
      ),
    );
  } catch (e) {
    return sitInError(e);
  }
}

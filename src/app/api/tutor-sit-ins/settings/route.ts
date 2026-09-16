import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  assertSameOrigin,
  sitInError,
  sitInJson,
} from "@/lib/tutor-sit-ins/http";
import {
  defaultQuarter,
  quarterSchema,
  settingsSchema,
} from "@/lib/tutor-sit-ins/model";
import { settings, updateSettings } from "@/lib/tutor-sit-ins/service";
export async function GET(request: Request) {
  try {
    return sitInJson(
      await settings(
        await requireSitInAccess(),
        quarterSchema.parse(
          new URL(request.url).searchParams.get("quarter") || defaultQuarter(),
        ),
      ),
    );
  } catch (e) {
    return sitInError(e);
  }
}
export async function POST(request: Request) {
  try {
    const access = await requireSitInAccess();
    assertSameOrigin(request);
    await updateSettings(access, settingsSchema.parse(await request.json()));
    return sitInJson({ ok: true });
  } catch (e) {
    return sitInError(e);
  }
}

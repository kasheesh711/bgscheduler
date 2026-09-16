import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  assertSameOrigin,
  sitInError,
  sitInJson,
} from "@/lib/tutor-sit-ins/http";
import {
  calendarSettings,
  calendarSelectionSchema,
  saveCalendarSelection,
  disconnectCalendar,
} from "@/lib/tutor-sit-ins/calendar";
export async function GET() {
  try {
    return sitInJson(
      await calendarSettings((await requireSitInAccess()).email),
    );
  } catch (e) {
    return sitInError(e);
  }
}
export async function PATCH(request: Request) {
  try {
    const access = await requireSitInAccess();
    assertSameOrigin(request);
    await saveCalendarSelection(
      access.email,
      calendarSelectionSchema.parse(await request.json()),
    );
    return sitInJson(await calendarSettings(access.email));
  } catch (e) {
    return sitInError(e);
  }
}
export async function DELETE(request: Request) {
  try {
    const access = await requireSitInAccess();
    assertSameOrigin(request);
    await disconnectCalendar(access.email);
    return sitInJson({ ok: true });
  } catch (e) {
    return sitInError(e);
  }
}

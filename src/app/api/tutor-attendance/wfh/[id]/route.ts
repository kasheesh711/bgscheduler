import { z } from "zod";
import { requireAttendanceAccess } from "@/lib/tutor-attendance/access";
import {
  attendanceError,
  attendanceJson,
  attendanceRequest,
} from "@/lib/tutor-attendance/http";
import { decideAttendanceWfh } from "@/lib/tutor-attendance/service";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return attendanceJson(
      await decideAttendanceWfh(
        await requireAttendanceAccess(),
        z.uuid().parse((await context.params).id),
        await attendanceRequest(request),
      ),
    );
  } catch (error) {
    return attendanceError(error);
  }
}

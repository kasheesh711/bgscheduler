import { requireAttendanceAccess } from "@/lib/tutor-attendance/access";
import {
  attendanceError,
  attendanceJson,
  attendanceRequest,
} from "@/lib/tutor-attendance/http";
import { requestAttendanceWfh } from "@/lib/tutor-attendance/service";

export async function POST(request: Request) {
  try {
    return attendanceJson(
      await requestAttendanceWfh(
        await requireAttendanceAccess(),
        await attendanceRequest(request),
      ),
    );
  } catch (error) {
    return attendanceError(error);
  }
}

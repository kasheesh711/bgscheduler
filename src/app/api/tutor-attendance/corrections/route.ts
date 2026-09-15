import { requireAttendanceAccess } from "@/lib/tutor-attendance/access";
import {
  attendanceError,
  attendanceJson,
  attendanceRequest,
} from "@/lib/tutor-attendance/http";
import { requestAttendanceCorrection } from "@/lib/tutor-attendance/service";
export async function POST(request: Request) {
  try {
    return attendanceJson(
      await requestAttendanceCorrection(
        await requireAttendanceAccess(),
        await attendanceRequest(request),
      ),
      201,
    );
  } catch (error) {
    return attendanceError(error);
  }
}

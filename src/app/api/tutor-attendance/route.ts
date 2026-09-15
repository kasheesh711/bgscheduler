import { requireAttendanceAccess } from "@/lib/tutor-attendance/access";
import { attendanceOverview } from "@/lib/tutor-attendance/data";
import {
  attendanceError,
  attendanceJson,
  attendanceQuery,
} from "@/lib/tutor-attendance/http";
import { clientAddress } from "@/lib/tutor-attendance/network";
export async function GET(request: Request) {
  try {
    return attendanceJson(
      await attendanceOverview(
        await requireAttendanceAccess(),
        attendanceQuery(request),
        clientAddress(request.headers),
      ),
    );
  } catch (error) {
    return attendanceError(error);
  }
}

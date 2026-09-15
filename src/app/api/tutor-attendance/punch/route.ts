import { requireAttendanceAccess } from "@/lib/tutor-attendance/access";
import {
  attendanceError,
  attendanceJson,
  attendanceRequest,
} from "@/lib/tutor-attendance/http";
import { clientAddress } from "@/lib/tutor-attendance/network";
import { recordAttendancePunch } from "@/lib/tutor-attendance/service";
export async function POST(request: Request) {
  try {
    return attendanceJson(
      await recordAttendancePunch(
        await requireAttendanceAccess(),
        await attendanceRequest(request),
        clientAddress(request.headers),
      ),
    );
  } catch (error) {
    return attendanceError(error);
  }
}

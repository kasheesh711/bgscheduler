import { requireAttendanceAccess } from "@/lib/tutor-attendance/access";
import { attendanceSettings } from "@/lib/tutor-attendance/data";
import {
  attendanceError,
  attendanceJson,
  attendanceRequest,
} from "@/lib/tutor-attendance/http";
import { clientAddress } from "@/lib/tutor-attendance/network";
import { saveAttendanceSettings } from "@/lib/tutor-attendance/service";
export async function GET(request: Request) {
  try {
    return attendanceJson({
      ...(await attendanceSettings(await requireAttendanceAccess())),
      detectedAddress: clientAddress(request.headers),
    });
  } catch (error) {
    return attendanceError(error);
  }
}
export async function PUT(request: Request) {
  try {
    return attendanceJson(
      await saveAttendanceSettings(
        await requireAttendanceAccess(),
        await attendanceRequest(request),
      ),
    );
  } catch (error) {
    return attendanceError(error);
  }
}

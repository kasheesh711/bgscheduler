import {
  requireAttendanceAccess,
  requireAttendanceAdmin,
} from "@/lib/tutor-attendance/access";
import { attendanceCsv, attendanceOverview } from "@/lib/tutor-attendance/data";
import {
  attendanceError,
  attendanceQuery,
  privateHeaders,
} from "@/lib/tutor-attendance/http";
import { clientAddress } from "@/lib/tutor-attendance/network";
export async function GET(request: Request) {
  try {
    const access = await requireAttendanceAccess();
    requireAttendanceAdmin(access);
    const overview = await attendanceOverview(
      access,
      attendanceQuery(request),
      clientAddress(request.headers),
    );
    return new Response(attendanceCsv(overview), {
      headers: {
        ...privateHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="office-attendance-${overview.start}-${overview.end}.csv"`,
      },
    });
  } catch (error) {
    return attendanceError(error);
  }
}

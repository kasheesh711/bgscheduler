import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireAttendanceAccess } from "@/lib/tutor-attendance/access";
import { AttendanceError } from "@/lib/tutor-attendance/model";
import { AttendanceWorkspace } from "@/components/tutor-attendance/workspace";

export const metadata = { title: "Office Attendance | BeGifted Ops" };

async function AttendanceBody() {
  try {
    await requireAttendanceAccess();
  } catch (error) {
    if (error instanceof AttendanceError && error.status === 401)
      redirect("/login?callbackUrl=%2Ftutor-attendance");
    if (error instanceof AttendanceError)
      return (
        <section className="mx-auto max-w-lg rounded-xl border bg-card p-6">
          <h1 className="text-xl font-semibold">Office Attendance</h1>
          <p className="mt-3 text-muted-foreground">{error.message}</p>
        </section>
      );
    throw error;
  }
  return <AttendanceWorkspace />;
}
export default function AttendancePage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-muted-foreground">
          Loading office attendance…
        </p>
      }
    >
      <AttendanceBody />
    </Suspense>
  );
}

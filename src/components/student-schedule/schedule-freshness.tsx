import type { StudentSchedulePayload } from "@/lib/student-schedule/types";
import { formatBangkokDateTime } from "@/lib/bangkok-time";

export function ScheduleFreshness({ payload, thai = false }: { payload: StudentSchedulePayload; thai?: boolean }) {
  return <p role={payload.stale ? "status" : undefined} className={payload.stale ? "my-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" : "my-2 text-xs text-muted-foreground"}>
    {payload.stale && (thai ? "ยังอัปเดตข้อมูลล่าสุดไม่ได้ กำลังแสดงข้อมูลที่บันทึกไว้ · " : "Live refresh unavailable. Showing saved data · ")}
    {thai ? "ข้อมูล ณ " : "Data as of "}{formatBangkokDateTime(payload.sourceAt ?? payload.generatedAt)}
  </p>;
}

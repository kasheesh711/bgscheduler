import { z } from "zod";
import { AttendanceError } from "./model";
export const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};
export const attendanceJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: privateHeaders });
export function attendanceError(error: unknown) {
  if (error instanceof AttendanceError)
    return attendanceJson(
      { error: error.message, code: error.code },
      error.status,
    );
  if (error instanceof z.ZodError)
    return attendanceJson(
      { error: error.issues[0]?.message ?? "Invalid request." },
      400,
    );
  console.error(
    "Office attendance request failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  return attendanceJson(
    {
      error:
        "Attendance is temporarily unavailable. Please retry; no time is recorded until confirmed.",
    },
    500,
  );
}
export async function attendanceRequest(request: Request): Promise<unknown> {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    throw new AttendanceError(403, "Invalid request origin.");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new AttendanceError(415, "Send a JSON request.");
  const body = await request.text();
  if (new TextEncoder().encode(body).length > 16000)
    throw new AttendanceError(413, "This request is too large.");
  try {
    return JSON.parse(body);
  } catch {
    throw new AttendanceError(400, "Invalid JSON.");
  }
}
export function attendanceQuery(request: Request) {
  const p = new URL(request.url).searchParams;
  return {
    start: p.get("start") || undefined,
    end: p.get("end") || undefined,
    canonicalKey: p.get("tutor") || undefined,
  };
}

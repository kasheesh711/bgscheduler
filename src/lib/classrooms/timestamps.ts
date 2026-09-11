/** Convert a stored Bangkok wall-clock timestamp (UTC Date fields) to a Wise instant. */
export function classroomTimestampToWiseIso(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const utcMillis = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours() - 7,
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
  return new Date(utcMillis).toISOString();
}

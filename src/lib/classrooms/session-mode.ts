const ONLINE_SESSION_TYPES = new Set(["online", "scheduled", "virtual"]);
const ONSITE_SESSION_TYPES = new Set(["offline", "onsite", "in-person"]);

export type ClassroomSessionMode = "online" | "onsite" | "unknown";

export function normalizeSessionType(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function getClassroomSessionMode(value: string | null | undefined): ClassroomSessionMode {
  const normalized = normalizeSessionType(value);
  if (ONLINE_SESSION_TYPES.has(normalized)) return "online";
  if (ONSITE_SESSION_TYPES.has(normalized)) return "onsite";
  return "unknown";
}

export function isOnlineSessionType(value: string | null | undefined): boolean {
  return getClassroomSessionMode(value) === "online";
}

export function isOnsiteSessionType(value: string | null | undefined): boolean {
  return getClassroomSessionMode(value) === "onsite";
}

export function sessionModeLabel(value: string | null | undefined): string {
  const mode = getClassroomSessionMode(value);
  if (mode === "online") return "Online";
  if (mode === "onsite") return "Onsite";
  return value?.trim() || "Unknown";
}

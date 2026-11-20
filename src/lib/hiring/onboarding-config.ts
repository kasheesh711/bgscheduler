import { HiringError } from "./model";

export const lineUserIdPattern = /^U[0-9a-f]{32}$/;
export const lineGroupIdPattern = /^C[0-9a-f]{32}$/;

export function onboardingEnabled() {
  return process.env.HIRING_ONBOARDING_ENABLED === "true"
    && Boolean(process.env.HIRING_LINE_LOGIN_ID && process.env.HIRING_LINE_LOGIN_SECRET);
}

export function hiringOrigin() {
  return new URL(process.env.APP_BASE_URL || "https://bgscheduler.vercel.app").origin;
}

export function expertsGroup() {
  const id = process.env.EXPERTS_LINE_GROUP_ID?.trim();
  const name = process.env.EXPERTS_LINE_GROUP_NAME?.trim();
  const bot = process.env.EXPERTS_LINE_BOT;
  return id && lineGroupIdPattern.test(id) && name && (bot === "tutors" || bot === "parent")
    ? { id, name, tutorBot: bot === "tutors" }
    : null;
}

export function requireExpertsGroup() {
  const group = expertsGroup();
  if (!group) throw new HiringError(503, "Configure the Experts LINE group first.");
  return group;
}

export function tutorGroupTemplate() {
  const name = process.env.HIRING_TUTOR_GROUP_TEMPLATE?.trim();
  const admins = [...new Set((process.env.HIRING_TUTOR_GROUP_ADMINS ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
  return name && admins.length ? { name, admins } : null;
}

export function tutorGroupName(preferredName: string) {
  return `Kru ${preferredName} x BeGifted`;
}

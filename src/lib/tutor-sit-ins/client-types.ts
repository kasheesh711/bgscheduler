import type { overview, settings } from "./service";
import type { detail } from "./repository";
import type { calendarSettings } from "./calendar";
import type { SitInAccess } from "./access";
type Wire<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Array<Wire<U>>
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;
export type DashboardData = Wire<Awaited<ReturnType<typeof overview>>>;
export type DetailData = Wire<Awaited<ReturnType<typeof detail>>> & {
  access: SitInAccess;
};
export type SettingsData = Wire<Awaited<ReturnType<typeof settings>>>;
export type CalendarData = Wire<Awaited<ReturnType<typeof calendarSettings>>>;
export type Report = DetailData["reports"][number];
export type Communication = DetailData["communications"][number];

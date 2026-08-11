// ----------------------------------------------------------------------------
// View preference for the public parent schedule page.
//
// Pure helpers only, split from the client shell so the zero-flash contract —
// which view the SSR HTML selects at each screen size — is pinned by exact
// string tests instead of DOM-event tests (component tests here are
// renderToStaticMarkup only). Storage access mirrors the admissions parent
// locale pattern: try/catch everything, fail closed to "auto" on any garbage
// or a throwing storage (private browsing).
// ----------------------------------------------------------------------------

export type ScheduleView = "agenda" | "calendar";

/** localStorage key persisting the parent's explicit toggle choice. */
export const SCHEDULE_VIEW_STORAGE_KEY = "bgscheduler.schedule.view";

/**
 * Exact "agenda"/"calendar" pass through; anything else (null, casing,
 * garbage) resolves to null = auto, the screen-size default.
 */
export function resolveScheduleView(raw: string | null): ScheduleView | null {
  return raw === "agenda" || raw === "calendar" ? raw : null;
}

/** Reads the stored choice; missing or throwing storage → null = auto. */
export function readStoredScheduleView(
  storage: Pick<Storage, "getItem"> | null | undefined,
): ScheduleView | null {
  if (!storage) return null;
  try {
    return resolveScheduleView(storage.getItem(SCHEDULE_VIEW_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Fire-and-forget persist; a throwing storage is silently ignored. */
export function writeStoredScheduleView(
  storage: Pick<Storage, "setItem"> | null | undefined,
  view: ScheduleView,
): void {
  if (!storage) return;
  try {
    storage.setItem(SCHEDULE_VIEW_STORAGE_KEY, view);
  } catch {
    // Private browsing / storage quota — the toggle still works per-visit.
  }
}

export interface ViewContainerClasses {
  /** Wrapper of the agenda slot. */
  agenda: string;
  /** Wrapper of the calendar slot (dot grid below lg, month grid at lg+). */
  calendar: string;
  /** Inner width wrapper of the sticky header. */
  header: string;
}

/**
 * The zero-flash contract. null = auto: the responsive class pairs let the
 * SSR HTML alone select agenda below lg and the calendar at lg and up — no
 * JS, no hydration flash, and window resizes keep working via CSS. A forced
 * view drops the responsive variants entirely. Widths are view-aware: the
 * agenda reads best in a narrow column, the month grid needs the max-w-5xl
 * the desktop page had before the agenda redesign.
 */
export function resolveViewContainerClasses(
  view: ScheduleView | null,
): ViewContainerClasses {
  switch (view) {
    case "agenda":
      return {
        agenda: "mx-auto w-full max-w-screen-sm",
        calendar: "hidden",
        header: "mx-auto max-w-screen-sm",
      };
    case "calendar":
      return {
        agenda: "hidden",
        calendar: "mx-auto w-full max-w-screen-sm lg:max-w-5xl",
        header: "mx-auto max-w-screen-sm lg:max-w-5xl",
      };
    default:
      return {
        agenda: "mx-auto w-full max-w-screen-sm lg:hidden",
        calendar: "mx-auto hidden w-full max-w-screen-sm lg:block lg:max-w-5xl",
        header: "mx-auto max-w-screen-sm lg:max-w-5xl",
      };
  }
}

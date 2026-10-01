const DAY_MS = 24 * 60 * 60 * 1_000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1_000;

/** Bangkok has no daylight-saving transition. This is only a refresh clock; the server chooses the actual day. */
export function bangkokDay(now = Date.now()): string {
  return new Date(now + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Watches the list only. Capture, media, consent and draft state remain owned by the caller. */
export function watchTodaySessions<T>(options: {
  request: () => Promise<T>;
  onRefresh: (day: string) => void;
  onResult: (value: T, day: string) => void;
  onError: (error: unknown) => void;
  focus: EventTarget;
  visibility: EventTarget & { readonly visibilityState: string };
  now?: () => number;
}): { refresh: () => void; stop: () => void } {
  const now = options.now ?? (() => Date.now());
  let generation = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function refresh() {
    if (stopped) return;
    const requestGeneration = ++generation;
    const day = bangkokDay(now());
    if (timer) clearTimeout(timer);
    const nextMidnight = Date.parse(`${day}T00:00:00+07:00`) + DAY_MS;
    timer = setTimeout(refresh, Math.max(1, nextMidnight - now()));
    options.onRefresh(day);
    void (async () => {
      try {
        const value = await options.request();
        if (stopped || requestGeneration !== generation) return;
        // Suspended timers must not let a response from yesterday restore yesterday's choices.
        if (bangkokDay(now()) !== day) { refresh(); return; }
        options.onResult(value, day);
      } catch (error) {
        if (stopped || requestGeneration !== generation) return;
        if (bangkokDay(now()) !== day) { refresh(); return; }
        options.onError(error);
      }
    })();
  }

  const visible = () => { if (options.visibility.visibilityState === "visible") refresh(); };
  options.focus.addEventListener("focus", visible);
  options.visibility.addEventListener("visibilitychange", visible);
  refresh();
  return {
    refresh,
    stop: () => {
      stopped = true;
      ++generation;
      if (timer) clearTimeout(timer);
      options.focus.removeEventListener("focus", visible);
      options.visibility.removeEventListener("visibilitychange", visible);
    },
  };
}

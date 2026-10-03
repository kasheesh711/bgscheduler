export type ScreenAwakeState = "requesting" | "active" | "unavailable";
type Lock = Pick<WakeLockSentinel, "released" | "release" | "addEventListener">;

/** One recording owns one lock. Late permission results cannot leak past stop. */
export function keepScreenAwake(onChange: (state: ScreenAwakeState) => void,
  request: (() => Promise<Lock>) | undefined = globalThis.navigator?.wakeLock
    ? () => navigator.wakeLock.request("screen") : undefined): () => void {
  let stopped = false;
  let lock: Lock | undefined;
  onChange(request ? "requesting" : "unavailable");
  if (request) void request().then(async value => {
    if (stopped) { await value.release().catch(() => undefined); return; }
    lock = value;
    onChange(value.released ? "unavailable" : "active");
    value.addEventListener("release", () => { if (!stopped) onChange("unavailable"); }, { once: true });
  }).catch(() => { if (!stopped) onChange("unavailable"); });
  return () => { stopped = true; void lock?.release().catch(() => undefined); };
}

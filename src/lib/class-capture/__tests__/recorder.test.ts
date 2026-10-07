import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassRecorder, type RecorderEnvironment } from "../recorder";

class FakeRecorder extends EventTarget {
  state: RecordingState = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["last"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  });
  chunk(content: string) {
    this.ondataavailable?.({ data: new Blob([content], { type: this.mimeType }) } as BlobEvent);
  }
}

function setup(getUserMedia?: RecorderEnvironment["getUserMedia"]) {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const media = new FakeRecorder();
  const env: RecorderEnvironment = {
    getUserMedia: getUserMedia ?? vi.fn(async () => stream),
    createRecorder: () => media as unknown as MediaRecorder,
    isTypeSupported: () => true,
    now: () => Date.now(),
  };
  return { env, media, stream, track };
}

afterEach(() => vi.useRealTimers());

describe("ClassRecorder", () => {
  it("requires fresh consent before requesting the microphone", async () => {
    const { env } = setup();
    const recorder = new ClassRecorder({ kind: "recording" }, env);
    await recorder.start(false);
    expect(env.getUserMedia).not.toHaveBeenCalled();
    expect(recorder.snapshot.error).toMatch(/consent/i);
  });

  it("coalesces duplicate starts and retains the final chunk on stop", async () => {
    const { env, media, track } = setup();
    const recorder = new ClassRecorder({ kind: "recording" }, env);
    await Promise.all([recorder.start(true), recorder.start(true)]);
    expect(env.getUserMedia).toHaveBeenCalledTimes(1);
    media.chunk("first");
    recorder.stop("user");
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot.status).toBe("stopped");
    expect(await recorder.snapshot.blob?.text()).toBe("firstlast");
    recorder.stop("user");
    expect(media.stop).toHaveBeenCalledTimes(1);
  });

  it("waits for Safari's delayed final chunk instead of truncating after 1.5 seconds", async () => {
    vi.useFakeTimers();
    const { env, media, track } = setup();
    media.stop = vi.fn(() => { media.state = "inactive"; });
    const recorder = new ClassRecorder({ kind: "recording" }, env);
    await recorder.start(true);
    expect(media.start).toHaveBeenCalledWith(1000);
    media.chunk("first");
    recorder.stop("background");
    expect(track.stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(recorder.snapshot.status).toBe("stopping");
    media.chunk("delayed-tail");
    media.onstop?.();
    expect(await recorder.snapshot.blob?.text()).toBe("firstdelayed-tail");
  });

  it("retains final data when the browser marks the recorder inactive before the track ends", async () => {
    const { env, media, track } = setup();
    const recorder = new ClassRecorder({ kind: "recording" }, env);
    await recorder.start(true);
    media.state = "inactive";
    track.dispatchEvent(new Event("ended"));
    expect(recorder.snapshot.status).toBe("stopping");
    media.chunk("final browser data");
    media.onstop?.();
    expect(await recorder.snapshot.blob?.text()).toBe("final browser data");
  });

  it("stops a microphone permission response that arrives after cancellation", async () => {
    let resolve!: (value: MediaStream) => void;
    const request = new Promise<MediaStream>((done) => { resolve = done; });
    const { env, stream, track, media } = setup(vi.fn(() => request));
    const recorder = new ClassRecorder({ kind: "recording" }, env);
    const started = recorder.start(true);
    recorder.stop("cancelled");
    resolve(stream);
    await started;
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(media.start).not.toHaveBeenCalled();
  });

  it("explains denied permission and leaves no active recorder", async () => {
    const { env } = setup(async () => { throw new DOMException("Denied", "NotAllowedError"); });
    const recorder = new ClassRecorder({ kind: "recording" }, env);
    await recorder.start(true);
    expect(recorder.snapshot.status).toBe("error");
    expect(recorder.snapshot.error).toMatch(/microphone.*settings/i);
  });

  it("preserves completed chunks when a track ends unexpectedly", async () => {
    const { env, media, track } = setup();
    const recorder = new ClassRecorder({ kind: "recording" }, env);
    await recorder.start(true);
    media.chunk("synthetic lesson");
    track.dispatchEvent(new Event("ended"));
    expect(recorder.snapshot.reason).toBe("interrupted");
    expect(recorder.snapshot.blob?.size).toBeGreaterThan(0);
    expect(track.stop).toHaveBeenCalled();
  });

  it("stops at the tutor debrief time limit", async () => {
    vi.useFakeTimers();
    const { env, track } = setup();
    const recorder = new ClassRecorder({ kind: "debrief" }, env);
    await recorder.start(true);
    vi.advanceTimersByTime(180_000);
    expect(recorder.snapshot.reason).toBe("time-limit");
    expect(track.stop).toHaveBeenCalled();
  });

  it("does not retain a chunk that exceeds the bounded recording size", async () => {
    const { env, media } = setup();
    const recorder = new ClassRecorder({ kind: "debrief", maxBytes: 10 }, env);
    await recorder.start(true);
    media.chunk("12345");
    media.chunk("12345678901");
    expect(recorder.snapshot.reason).toBe("size-limit");
    expect(recorder.snapshot.bytes).toBeLessThanOrEqual(10);
  });

  it("releases tracks if MediaRecorder construction fails", async () => {
    const { env, track } = setup();
    env.createRecorder = () => { throw new Error("unsupported"); };
    const recorder = new ClassRecorder({ kind: "recording" }, env);
    await recorder.start(true);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot.status).toBe("error");
  });
});

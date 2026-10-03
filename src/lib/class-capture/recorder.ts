export type RecordingKind = "recording" | "debrief";
export type StopReason = "user" | "background" | "navigation" | "interrupted" | "time-limit" | "size-limit" | "cancelled";
export type RecorderSnapshot = {
  status: "idle" | "requesting" | "recording" | "stopping" | "stopped" | "error";
  elapsedSeconds: number;
  bytes: number;
  mime: string;
  blob: Blob | null;
  reason: StopReason | null;
  error: string | null;
};

export const RECORDING_LIMITS = {
  recording: { seconds: 2 * 60 * 60, bytes: 100 * 1024 * 1024 },
  debrief: { seconds: 3 * 60, bytes: 10 * 1024 * 1024 },
} as const;

export interface RecorderEnvironment {
  getUserMedia: () => Promise<MediaStream>;
  createRecorder: (stream: MediaStream, mime: string) => MediaRecorder;
  isTypeSupported: (mime: string) => boolean;
  now: () => number;
}

function browserEnvironment(): RecorderEnvironment {
  return {
    getUserMedia: () => {
      if (!globalThis.navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("This browser cannot record audio here. Use a supported browser over HTTPS, or choose an existing audio file.");
      }
      return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
    },
    createRecorder: (stream, mime) => new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 64_000 }),
    isTypeSupported: (mime) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime),
    now: () => Date.now(),
  };
}

function microphoneError(error: unknown): string {
  if (error instanceof Error && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "Microphone access was denied. Allow the microphone in your browser settings, or choose an existing audio file.";
  }
  if (error instanceof Error && error.name === "NotFoundError") return "No microphone was found. Connect one, or choose an existing audio file.";
  if (error instanceof Error && error.name === "NotReadableError") return "The microphone is busy or unavailable. Close other recording apps and try again, or choose an audio file.";
  return "Audio recording is unavailable in this browser. Try a supported browser over HTTPS, or choose an existing audio file.";
}

/** One explicit recording attempt. Never starts or resumes without a user action. */
export class ClassRecorder {
  snapshot: RecorderSnapshot = { status: "idle", elapsedSeconds: 0, bytes: 0, mime: "", blob: null, reason: null, error: null };
  private media: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private startedAt = 0;
  private readonly env: RecorderEnvironment;

  constructor(private readonly options: {
    kind: RecordingKind;
    onChange?: (snapshot: RecorderSnapshot) => void;
    onChunk?: (chunk: Blob) => void;
    maxBytes?: number;
  }, env?: RecorderEnvironment) {
    this.env = env ?? browserEnvironment();
  }

  private publish(patch: Partial<RecorderSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.options.onChange?.(this.snapshot);
  }

  async start(consentConfirmed: boolean): Promise<void> {
    if (this.snapshot.status !== "idle" && this.snapshot.status !== "error") return;
    if (!consentConfirmed) {
      this.publish({ status: "error", error: "Confirm participant and guardian consent before recording." });
      return;
    }
    const generation = ++this.generation;
    this.publish({ status: "requesting", error: null });
    try {
      const stream = await this.env.getUserMedia();
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => this.env.isTypeSupported(type)) ?? "";
      this.media = this.env.createRecorder(stream, mime);
      this.media.ondataavailable = (event) => {
        if (!event.data.size || this.snapshot.status === "stopped") return;
        const limit = this.options.maxBytes ?? RECORDING_LIMITS[this.options.kind].bytes;
        if (this.snapshot.bytes + event.data.size > limit) {
          this.stop("size-limit");
          return;
        }
        this.chunks.push(event.data);
        this.publish({ bytes: this.snapshot.bytes + event.data.size, mime: event.data.type || this.snapshot.mime });
        this.options.onChunk?.(event.data);
      };
      this.media.onstop = () => this.finish();
      this.media.onerror = () => this.stop("interrupted");
      stream.getTracks().forEach((track) => track.addEventListener("ended", () => this.stop("interrupted"), { once: true }));
      this.startedAt = this.env.now();
      this.media.start(1_000);
      this.publish({ status: "recording", mime: this.media.mimeType || mime });
      this.timer = setInterval(() => {
        const seconds = Math.floor((this.env.now() - this.startedAt) / 1_000);
        this.publish({ elapsedSeconds: seconds });
        if (seconds >= RECORDING_LIMITS[this.options.kind].seconds) this.stop("time-limit");
      }, 250);
    } catch (error) {
      if (generation !== this.generation) return;
      this.releaseTracks();
      this.publish({ status: "error", error: microphoneError(error) });
    }
  }

  stop(reason: StopReason = "user"): void {
    if (["idle", "stopping", "stopped", "error"].includes(this.snapshot.status)) return;
    ++this.generation;
    this.publish({ status: "stopping", reason });
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Stop tracks immediately, including navigation/unmount; waiting for onstop must never keep the mic live.
    if (this.media?.state !== "inactive" && this.media) {
      // Safari can delay its final dataavailable event while suspended. Wait for
      // onstop rather than finalizing a partial Blob after an arbitrary timeout.
      try { this.media.stop(); } catch { this.finish(); }
    } else if (!this.media) this.finish();
    this.releaseTracks();
  }

  private releaseTracks() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private finish() {
    if (this.snapshot.status === "stopped") return;
    if (this.timer) clearInterval(this.timer);
    this.releaseTracks();
    this.publish({ status: "stopped", blob: this.chunks.length ? new Blob(this.chunks, { type: this.snapshot.mime }) : null });
  }
}

export function stopReasonMessage(reason: StopReason | null): string | null {
  if (reason === "background" || reason === "navigation") return "Recording stopped when this page left the foreground. Review the saved audio before continuing; it may be incomplete.";
  if (reason === "interrupted") return "The microphone was interrupted. Review the saved audio; the end may be missing.";
  if (reason === "time-limit") return "The recording time limit was reached. Your audio is ready to review.";
  if (reason === "size-limit") return "The file size limit was reached. The last section may be missing; review your audio.";
  return null;
}

import { describe, expect, it } from "vitest";
import { consentSchema, assetInputSchema, availability, assertMediaBytes } from "../model";

describe("class capture boundaries", () => {
  it("requires participant, guardian decision and processing consent", () => {
    expect(consentSchema.safeParse({ participants: false, guardian: "confirmed", processing: true }).success).toBe(false);
    expect(consentSchema.safeParse({ participants: true, processing: true }).success).toBe(false);
    expect(consentSchema.safeParse({ participants: true, guardian: "not_required", processing: true }).success).toBe(true);
  });
  it("bounds media by purpose and rejects executable types", () => {
    const base = { id: "11111111-1111-4111-8111-111111111111", kind: "worksheet", mime: "image/jpeg", size: 1024, worksheetPermission: true };
    expect(assetInputSchema.safeParse(base).success).toBe(true);
    expect(assetInputSchema.safeParse({ ...base, worksheetPermission: undefined }).success).toBe(false);
    expect(assetInputSchema.safeParse({ ...base, size: 8 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(assetInputSchema.safeParse({ ...base, mime: "image/svg+xml" }).success).toBe(false);
    expect(assetInputSchema.safeParse({ ...base, kind: "debrief", mime: "audio/webm", size: 10 * 1024 * 1024 + 1 }).success).toBe(false);
  });
  it("does not mistake a file extension or declared MIME for audio", () => {
    expect(() => assertMediaBytes(Buffer.from("<script>bad</script>"), "audio/webm")).toThrow();
    expect(() => assertMediaBytes(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]), "audio/webm")).not.toThrow();
    expect(() => assertMediaBytes(Buffer.from("RIFF0000WAVEdata"), "audio/wav")).not.toThrow();
  });
  it("fails closed without the independent processing approval and credentials", () => {
    expect(availability({})).toEqual({ enabled: false, storage: false, transcription: false, drafting: false });
    expect(availability({ ENABLE_CLASS_CAPTURE: "true", SONIOX_API_KEY: "synthetic", OPENROUTER_API_KEY: "synthetic" }).transcription).toBe(false);
    expect(availability({ ENABLE_CLASS_CAPTURE: "true", CLASS_CAPTURE_PROCESSING_APPROVED: "true", SONIOX_API_KEY: "synthetic", BLOB_READ_WRITE_TOKEN: "synthetic" }).transcription).toBe(true);
  });
});

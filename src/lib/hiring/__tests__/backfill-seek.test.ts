import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { BackfillFatal } from "../backfill";
import { backfillSeek } from "../../../../scripts/hiring-seek";

vi.mock("playwright-core", () => ({ chromium: { launchPersistentContext: vi.fn() } }));

const JOB = "https://th.employer.seek.com/candidates/?jobid=1";
function browser(page: Record<string, unknown>) {
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(chromium.launchPersistentContext).mockResolvedValue({ pages: () => [page], newPage: vi.fn(), close } as never);
  return close;
}
const step = vi.fn();

beforeEach(() => vi.clearAllMocks());

describe("backfillSeek", () => {
  it("does not hand Ctrl-C to Playwright, so the script can print its summary", async () => {
    browser({ goto: vi.fn().mockRejectedValue(new Error("x")), url: () => JOB });
    await expect(backfillSeek("/profile", "1", step)).rejects.toThrow();
    expect(chromium.launchPersistentContext).toHaveBeenCalledWith(
      "/profile",
      expect.objectContaining({ handleSIGINT: false, handleSIGTERM: false }),
    );
  });

  it("replaces a Playwright error with fixed text and its name, so no page text is printed", async () => {
    const strict = new Error("strict mode violation: getByText('Invented Person') resolved to 2 elements");
    const close = browser({ goto: vi.fn().mockRejectedValue(strict), url: () => JOB });
    const failure = await backfillSeek("/profile", "1", step).catch((error) => error);
    expect(failure.message).toBe("SEEK page step failed: Error");
    expect(failure.message).not.toContain("Invented");
    const timeout = Object.assign(new Error("Timeout waiting for 'Invented Person'"), { name: "TimeoutError" });
    browser({ goto: vi.fn().mockRejectedValue(timeout), url: () => JOB });
    expect((await backfillSeek("/profile", "1", step).catch((error) => error)).message).toBe("SEEK page step failed: TimeoutError");
    expect(close).toHaveBeenCalled();
  });

  it("stops with the sign-in message when SEEK sent the browser to a sign-in page", async () => {
    browser({ goto: vi.fn().mockResolvedValue(undefined), url: () => "https://login.seek.com/u/login" });
    const failure = await backfillSeek("/profile", "1", step).catch((error) => error);
    expect(failure).toBeInstanceOf(BackfillFatal);
    expect(failure.message).toMatch(/SEEK is signed out/);
    // A failure with the page still on the candidates list, after a navigation error, is not a sign-in loss.
    browser({ goto: vi.fn().mockRejectedValue(new Error("net::ERR")), url: () => "https://login.seek.com/" });
    expect((await backfillSeek("/profile", "1", step).catch((error) => error)).message).toMatch(/SEEK is signed out/);
  });
});

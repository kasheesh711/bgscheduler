import { describe, expect, it } from "vitest";
import { plainChromeArgs, SEEK_CHROME, seekSignedIn, SEEK_PAUSE_MS } from "../../../../scripts/hiring-seek";

describe("seekSignedIn", () => {
  it("accepts the employer candidates page", () => {
    expect(seekSignedIn("https://th.employer.seek.com/candidates/?jobid=1")).toBe(true);
  });
  it.each([
    "https://login.seek.com/u/login?state=x",
    "https://th.employer.seek.com/oauth/login",
    "https://example.com/candidates/",
    "about:blank",
    "not a url",
  ])("treats %s as signed out", (url) => {
    expect(seekSignedIn(url)).toBe(false);
  });
  it("pauses 10 seconds between profiles", () => {
    expect(SEEK_PAUSE_MS).toBe(10000);
  });
});

describe("SEEK Chrome launch", () => {
  it("uses the real keychain so a normal Chrome sign-in can be read", () => {
    expect(SEEK_CHROME.ignoreDefaultArgs).toContain("--use-mock-keychain");
  });
  it("opens plain Chrome on the worker profile and waits for it to quit", () => {
    expect(plainChromeArgs("/p", "42")).toEqual([
      "-naW",
      "Google Chrome",
      "--args",
      "--user-data-dir=/p",
      "https://th.employer.seek.com/candidates/?jobid=42",
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { serverlessChromiumArgs } from "../pdf";

describe("onsite foot-traffic PDF launch arguments", () => {
  it("removes user-data-dir because Playwright launch owns its temporary profile", () => {
    const source = ["--no-sandbox", "--user-data-dir=/tmp/report-profile", "--disable-dev-shm-usage"];

    expect(serverlessChromiumArgs(source)).toEqual(["--no-sandbox", "--disable-dev-shm-usage"]);
    expect(source).toHaveLength(3);
  });
});

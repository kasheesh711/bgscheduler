import { describe, expect, it, vi } from "vitest";

vi.mock("@neondatabase/serverless", () => ({ neon: vi.fn(() => vi.fn()) }));

import {
  RETIRED_WISE_BUDGET_MS,
  RETIRED_WISE_REQUESTS_PER_SECOND,
} from "@/lib/credit-control/run-sync-request";

// Production runs needed 1,486–1,519 Wise calls per run from 2026-10-10 to
// 2026-10-24. At 2 req/s the 760 s budget allowed ~1,520, so every run hit
// the abort and no snapshot was promoted after 2026-10-10.
const OBSERVED_PEAK_WISE_CALLS = 1_519;

describe("retired-mode credit sync pacing", () => {
  it("leaves at least 40% headroom over the observed peak Wise call count", () => {
    const capacity = RETIRED_WISE_REQUESTS_PER_SECOND * (RETIRED_WISE_BUDGET_MS / 1000);
    expect(capacity).toBeGreaterThanOrEqual(OBSERVED_PEAK_WISE_CALLS * 1.4);
  });

  it("stays well under an unpaced client", () => {
    expect(RETIRED_WISE_REQUESTS_PER_SECOND).toBeLessThanOrEqual(3);
  });
});

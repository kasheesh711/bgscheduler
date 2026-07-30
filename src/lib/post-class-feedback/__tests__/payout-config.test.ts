import { describe, expect, it } from "vitest";

import {
  payoutEnvironmentTarget,
  payoutWritesEnabled,
  requirePayoutGoogleTarget,
} from "../payout-config";

const COMPLETE = {
  POST_CLASS_PAYOUT_TARGET: "scratch",
  POST_CLASS_PAYOUT_CONNECTED_EMAIL: "Finance@Example.com ",
  POST_CLASS_PAYOUT_DRIVE_FOLDER_ID: "folder-1",
  POST_CLASS_PAYOUT_WORKBOOKS_FOLDER_ID: "workbooks-1",
  POST_CLASS_PAYOUT_MASTER_SPREADSHEET_ID: "sheet-1",
  POST_CLASS_PAYOUT_SOURCE_SHEET_NAME: "Raw",
  POST_CLASS_PAYOUT_DEDUCTIONS_SHEET_NAME: "Deductions",
  POST_CLASS_PAYOUT_COMPOSITE_SHEET_NAME: "Composite",
};

describe("payout target configuration", () => {
  it("has no implicit target and enables writes only for exact true", () => {
    expect(payoutEnvironmentTarget({})).toBeNull();
    expect(payoutWritesEnabled({})).toBe(false);
    expect(payoutWritesEnabled({ POST_CLASS_PAYOUT_WRITES_ENABLED: "TRUE" })).toBe(false);
    expect(payoutWritesEnabled({ POST_CLASS_PAYOUT_WRITES_ENABLED: "true" })).toBe(true);
    expect(payoutWritesEnabled({ POST_CLASS_PAYOUT_WRITES_ENABLED: " true " })).toBe(false);
    expect(payoutWritesEnabled({ POST_CLASS_PAYOUT_WRITES_ENABLED: "1" })).toBe(false);
  });

  it("requires every explicit Google target", () => {
    expect(() => requirePayoutGoogleTarget({ env: {} })).toThrow(
      /POST_CLASS_PAYOUT_CONNECTED_EMAIL/u,
    );
    expect(requirePayoutGoogleTarget({ env: COMPLETE })).toMatchObject({
      environmentTarget: "scratch",
      connectedEmail: "finance@example.com",
      writesEnabled: false,
    });
  });

  it("blocks writes behind the kill switch", () => {
    expect(() => requirePayoutGoogleTarget({
      env: COMPLETE,
      forWrite: true,
    })).toThrow(/writes are disabled/u);
    expect(requirePayoutGoogleTarget({
      env: { ...COMPLETE, POST_CLASS_PAYOUT_WRITES_ENABLED: "true" },
      forWrite: true,
    }).writesEnabled).toBe(true);
  });

  it("keeps preview deployments off production targets", () => {
    expect(() => requirePayoutGoogleTarget({
      env: {
        ...COMPLETE,
        POST_CLASS_PAYOUT_TARGET: "production",
      },
      vercelEnvironment: "preview",
    })).toThrow(/preview deployment.*scratch/u);
    expect(() => requirePayoutGoogleTarget({
      env: COMPLETE,
      vercelEnvironment: "production",
    })).toThrow(/production deployment.*production/u);
  });
});

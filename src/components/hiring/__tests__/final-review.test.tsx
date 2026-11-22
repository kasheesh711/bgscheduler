import { expect, it } from "vitest";
import { reviewBlocks } from "../final-review";

it.each([
  [false, true, "Ask Kevin to enable Automation."],
  [true, false, "Ask Kevin to enable Messages."],
  [false, false, "Ask Kevin to enable Automation and Messages."],
] as const)("explains why sign-off is paused with automation %s and messages %s", (enabled, deliveryEnabled, message) => {
  expect(reviewBlocks(true, { enabled, deliveryEnabled, bookingTestCandidateId: null }, "candidate"))
    .toEqual({ approveBlock: message, rejectBlock: message, signOffPaused: true });
});

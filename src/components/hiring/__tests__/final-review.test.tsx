import { expect, it } from "vitest";
import { reviewBlocks } from "../final-review";

it.each([
  [false, true, "Automation off", "Ask Kevin to enable it."],
  [true, false, "Messages off", "Ask Kevin to enable it."],
  [false, false, "Automation and Messages off", "Ask Kevin to enable both."],
] as const)("explains why sign-off is paused with automation %s and messages %s", (enabled, deliveryEnabled, pausedStatus, message) => {
  expect(reviewBlocks(true, { enabled, deliveryEnabled, bookingTestCandidateId: null }, "candidate"))
    .toEqual({ approveBlock: message, rejectBlock: message, pausedStatus });
});

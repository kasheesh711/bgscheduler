import { expect, it } from "vitest";
import { reviewBlocks } from "../final-review";

it.each([
  [false, true, "Automation is off. Ask Kevin to turn it on."],
  [true, false, "Messages are off. Ask Kevin to turn them on."],
  [false, false, "Automation and Messages are off. Ask Kevin to turn them on."],
] as const)("explains why sign-off is paused with automation %s and messages %s", (enabled, deliveryEnabled, message) => {
  expect(reviewBlocks(true, { enabled, deliveryEnabled, bookingTestCandidateId: null }, "candidate"))
    .toEqual({ approveBlock: message, rejectBlock: message, signOffPaused: true });
});

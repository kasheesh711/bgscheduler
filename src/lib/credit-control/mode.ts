/** Only an explicit active setting re-enables the retired workspace. */
export function creditControlActive(): boolean {
  return process.env.CREDIT_CONTROL_MODE === "active";
}

export const CREDIT_CONTROL_RETIRED = "CREDIT_CONTROL_RETIRED";
export const CREDIT_CONTROL_RETIRED_MESSAGE = "Credit Control is temporarily retired. Shared student data continues to refresh daily.";

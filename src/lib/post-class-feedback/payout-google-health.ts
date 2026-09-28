import { hasDriveFileScope, hasSheetsWriteScope } from "@/lib/sales-dashboard/google-oauth";

/** Token expiry alone is normal: a usable refresh token renews access automatically. */
export function payoutGoogleHealth(token: {
  scope: string | null;
  accessTokenCiphertext: string | null;
  refreshTokenCiphertext: string | null;
  lastError: string | null;
} | undefined) {
  const sheetsWriteReady = hasSheetsWriteScope(token?.scope);
  const driveReady = hasDriveFileScope(token?.scope);
  const credentialsMissing = !token?.accessTokenCiphertext || !token?.refreshTokenCiphertext;
  const revoked = /invalid_grant|expired|revoked|unauthoriz|invalid.*token/i.test(token?.lastError ?? "");
  return {
    sheetsWriteReady, driveReady,
    reconnectRequired: credentialsMissing || revoked || !sheetsWriteReady || !driveReady,
    connectionError: token?.lastError ?? (credentialsMissing ? "Reconnect Google to store renewable credentials." : null),
  };
}

/** Owner-operated only. This command can remove one explicitly labelled dummy teacher. */
import { parseArgs } from "node:util";
import { fetchAllInstituteSessions } from "../src/lib/wise/fetchers";
import { createRemovalWiseClient, readRemovalRoster, removeWiseParticipantOnce } from "../src/lib/tutor-offboarding/removal-wise";
import { RemovalProbeGuardError, runRemovalProbe, validateRemovalProbeInput } from "../src/lib/tutor-offboarding/removal-probe";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "teacher-id": { type: "string" }, confirm: { type: "string" }, help: { type: "boolean" } }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log("Owner use only: node --env-file=<production-env-file> --import tsx scripts/probe-wise-teacher-removal.ts --teacher-id <24-character-teacher-id> --confirm remove-probe-teacher");
    console.log("The target must be named ZZ BGS Removal Probe, be a TEACHER, and have no courses or sessions. One request is sent, without retries. Re-invite the dummy and document the outcome before enabling live removal.");
    return;
  }
  const input = { teacherId: values["teacher-id"] ?? "", confirmation: values.confirm ?? "" };
  validateRemovalProbeInput(input);
  for (const key of ["WISE_USER_ID", "WISE_API_KEY", "WISE_NAMESPACE", "WISE_INSTITUTE_ID"] as const) {
    if (!process.env[key]?.trim()) throw new RemovalProbeGuardError(`missing_${key.toLowerCase()}`);
  }
  const result = await runRemovalProbe(input, {
    async readBefore() {
      const roster = await readRemovalRoster();
      // A dummy must have no past or future sessions; the normal removal flow checks future sessions.
      const sessions = await fetchAllInstituteSessions(createRemovalWiseClient(AbortSignal.timeout(180_000)), process.env.WISE_INSTITUTE_ID!, {}, { strict: true, deadlineAt: Date.now() + 180_000 });
      return { roster, sessions };
    },
    async removeOnce(userId) {
      const outcome = await removeWiseParticipantOnce(userId);
      const status = outcome.responsePayload?.httpStatus ?? outcome.responsePayload?.status;
      return { status: outcome.status, httpStatus: typeof status === "number" ? status : null };
    },
    readAfter: readRemovalRoster,
  });
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2));
  if (!result.endpointVerified) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    errorName: error instanceof Error ? error.name : "UnknownError",
    ...(error instanceof RemovalProbeGuardError ? { reason: error.code } : {}),
  }));
  process.exitCode = 1;
});

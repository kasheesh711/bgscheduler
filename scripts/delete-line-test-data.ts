import { loadEnvConfig } from "@next/env";
import { getDb } from "@/lib/db";
import {
  deleteLineTestData,
  LINE_TEST_DATA_DELETE_CONFIRMATION,
} from "@/lib/line/test-data-cleanup";

loadEnvConfig(process.cwd());

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function summarize(result: Awaited<ReturnType<typeof deleteLineTestData>>) {
  return {
    dryRun: result.dryRun,
    targetCounts: {
      contacts: result.targets.contactIds.length,
      threads: result.targets.threadIds.length,
      lineMessages: result.targets.lineMessageIds.length,
      reviews: result.targets.reviewIds.length,
      schedulerConversations: result.targets.conversationIds.length,
      schedulerMessages: result.targets.schedulerMessageIds.length,
      schedulerRuns: result.targets.schedulerRunIds.length,
    },
    before: result.before,
    deleted: result.deleted,
    after: result.after,
  };
}

async function main() {
  const dryRun = flag("--dry-run");
  const confirm = process.env.CONFIRM_DELETE_LINE_TEST_DATA;

  if (!dryRun && confirm !== LINE_TEST_DATA_DELETE_CONFIRMATION) {
    throw new Error(`Set CONFIRM_DELETE_LINE_TEST_DATA=${LINE_TEST_DATA_DELETE_CONFIRMATION} to delete current LINE test data.`);
  }

  const result = await deleteLineTestData(getDb(), { dryRun, confirm });
  console.log(JSON.stringify(summarize(result), null, 2));

  if (!dryRun) {
    const failed = Object.entries(result.after).filter(([, count]) => count !== 0);
    if (failed.length > 0) {
      throw new Error(`Cleanup verification failed: ${failed.map(([key, count]) => `${key}=${count}`).join(", ")}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

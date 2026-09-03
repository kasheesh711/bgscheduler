import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  WISE_USER_ID: z.string().min(1),
  WISE_API_KEY: z.string().min(1),
  WISE_NAMESPACE: z.string().default("begifted-education"),
  WISE_INSTITUTE_ID: z.string().default("696e1f4d90102225641cc413"),
  CRON_SECRET: z.string().min(1),
  LINE_CHANNEL_SECRET: z.string().min(1).optional(),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1).optional(),
  ENABLE_LINE_SCHEDULER: z.string().optional(),
  // Comma-separated LINE user IDs allowed to drive the schedule bot. Unset or
  // empty disables the bot entirely — it is fail-closed by construction, so a
  // parent messaging the OA can never reach it.
  LINE_SCHEDULE_BOT_ADMIN_IDS: z.string().optional(),
  // Opt-out kill switch for the live Wise overlay on /schedule. Exactly
  // "false" disables it; unset or any other value leaves it enabled. The LINE
  // schedule-bot paths sweep only in "rescue" mode (empty snapshot month).
  ENABLE_STUDENT_SCHEDULE_LIVE: z.string().optional(),
  // Days a parent schedule link stays live. Defaults to 30.
  STUDENT_SCHEDULE_LINK_TTL_DAYS: z.coerce.number().int().positive().optional(),
  // Absolute origin used to build parent links; previews link to themselves.
  APP_BASE_URL: z.string().url().optional(),
  // Takes the staff UI offline while the crons keep running (MAINT-01). Exactly
  // "true" engages it; unset or any other value leaves the site up. Declared
  // here for inventory parity only — src/middleware.ts runs on the edge and
  // reads process.env directly, because this module throws on a partial env.
  MAINTENANCE_MODE: z.string().optional(),
  // Comma-separated emails allowed through the maintenance gate. Unset or empty
  // means nobody bypasses — fail-closed, like LINE_SCHEDULE_BOT_ADMIN_IDS.
  MAINTENANCE_BYPASS_EMAILS: z.string().optional(),
  // Minutes a quiet credit-control pair's balance may be carried forward
  // instead of refetched from Wise (CRED-01). Defaults to 180; "0" is the
  // off-switch that refetches every pair. Declared here for inventory parity —
  // src/lib/credit-control/refresh-policy.ts reads process.env at call time so
  // the value can be changed without a module reload.
  CREDIT_REFRESH_MAX_AGE_MINUTES: z.coerce.number().min(0).optional(),
});

export type Env = z.infer<typeof envSchema>;

function getEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables");
  }
  return parsed.data;
}

export const env = getEnv();

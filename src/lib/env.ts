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

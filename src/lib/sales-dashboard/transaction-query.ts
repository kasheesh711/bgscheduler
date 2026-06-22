import { z } from "zod";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const SALES_TRANSACTION_MAX_LIMIT = 1000;
export const SALES_TRANSACTION_DEFAULT_LIMIT = 200;

export const salesTransactionFilterKeys = ["rep", "program", "band", "student", "from", "to"] as const;
export const salesTransactionPageKeys = [...salesTransactionFilterKeys, "limit", "offset"] as const;

export const salesTransactionFilterSchema = z.object({
  rep: z.string().min(1).optional(),
  program: z.string().min(1).optional(),
  band: z.string().min(1).optional(),
  student: z.string().min(1).optional(),
  from: z.string().regex(ISO_DATE, "Expected YYYY-MM-DD").optional(),
  to: z.string().regex(ISO_DATE, "Expected YYYY-MM-DD").optional(),
});

export const salesTransactionPageQuerySchema = salesTransactionFilterSchema.extend({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .transform((value) => Math.min(value, SALES_TRANSACTION_MAX_LIMIT))
    .default(SALES_TRANSACTION_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export type SalesTransactionFilterQuery = z.infer<typeof salesTransactionFilterSchema>;
export type SalesTransactionPageQuery = z.infer<typeof salesTransactionPageQuerySchema>;

export function readSearchParams(
  searchParams: URLSearchParams,
  keys: readonly string[],
): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of keys) {
    const value = searchParams.get(key);
    if (value !== null) raw[key] = value;
  }
  return raw;
}

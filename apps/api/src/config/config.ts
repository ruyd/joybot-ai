import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_DATABASE_URL: z.string().url(),
    READER_DATABASE_URL: z.string().url(),
    /** 'dev' trusts the x-dev-principal header — local development and tests only. */
    AUTH_MODE: z.enum(['dev', 'cognito']).default('cognito'),
    CUSTOMERS_USER_POOL_ID: z.string().optional(),
    CUSTOMERS_CLIENT_ID: z.string().optional(),
    EMPLOYEES_USER_POOL_ID: z.string().optional(),
    EMPLOYEES_CLIENT_ID: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.AUTH_MODE === 'dev' && cfg.NODE_ENV === 'production') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AUTH_MODE=dev is not allowed in production' });
    }
    if (cfg.AUTH_MODE === 'cognito') {
      for (const key of ['CUSTOMERS_USER_POOL_ID', 'CUSTOMERS_CLIENT_ID', 'EMPLOYEES_USER_POOL_ID', 'EMPLOYEES_CLIENT_ID'] as const) {
        if (!cfg[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${key} is required when AUTH_MODE=cognito` });
      }
    }
  });

export type AppConfig = z.infer<typeof schema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data;
}

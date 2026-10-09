import type { PoolConfig } from 'pg';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    /** Local: full URLs. AWS: host/port + per-role credentials injected from Secrets Manager. */
    APP_DATABASE_URL: z.string().url().optional(),
    READER_DATABASE_URL: z.string().url().optional(),
    DB_HOST: z.string().optional(),
    DB_READER_HOST: z.string().optional(),
    DB_PORT: z.coerce.number().int().positive().default(5432),
    DB_NAME: z.string().default('joybot'),
    APP_DB_USER: z.string().default('joybot_app'),
    APP_DB_PASSWORD: z.string().optional(),
    READER_DB_USER: z.string().default('joybot_reader'),
    READER_DB_PASSWORD: z.string().optional(),
    /** Verify TLS to Aurora (CA bundle via NODE_EXTRA_CA_CERTS in the container image). */
    DB_SSL: z.enum(['true', 'false']).default('false'),
    /** OpenAI-compatible model endpoint (vLLM), e.g. http://model.joybot-dev.internal:8000/v1 */
    MODEL_ENDPOINT: z.string().url().optional(),
    /** Served model name (vLLM: gemma; Ollama: the local tag, e.g. gemma4:e2b). */
    MODEL_NAME: z.string().default('gemma'),
    /** 'dev' trusts the x-dev-principal header — local development and tests only. */
    AUTH_MODE: z.enum(['dev', 'cognito']).default('cognito'),
    CUSTOMERS_USER_POOL_ID: z.string().optional(),
    CUSTOMERS_CLIENT_ID: z.string().optional(),
    EMPLOYEES_USER_POOL_ID: z.string().optional(),
    EMPLOYEES_CLIENT_ID: z.string().optional(),
    /** Stripe: secret with { restrictedKey, webhookSigningSecret } (AWS) or the signing secret directly (local). */
    STRIPE_SECRET_ARN: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    /** Freshdesk: secret with { apiKey } (AWS) or the key directly (local). BASE_URL overrides the domain (tests). */
    FRESHDESK_SECRET_ARN: z.string().optional(),
    FRESHDESK_API_KEY: z.string().optional(),
    FRESHDESK_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    /** SSM parameter read by the WhatsApp sender Lambda (messaging stack). Unset locally. */
    WHATSAPP_SETTINGS_PARAMETER: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.APP_DATABASE_URL && !(cfg.DB_HOST && cfg.APP_DB_PASSWORD)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'APP_DATABASE_URL or DB_HOST + APP_DB_PASSWORD is required' });
    }
    if (!cfg.READER_DATABASE_URL && !(cfg.DB_HOST && cfg.READER_DB_PASSWORD)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'READER_DATABASE_URL or DB_HOST + READER_DB_PASSWORD is required' });
    }
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

/** pg pool settings for one database role. */
export function poolConfig(cfg: AppConfig, role: 'app' | 'reader'): PoolConfig {
  const url = role === 'app' ? cfg.APP_DATABASE_URL : cfg.READER_DATABASE_URL;
  const ssl = cfg.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined;
  if (url) return { connectionString: url, ssl, max: 10 };
  return {
    host: role === 'reader' ? (cfg.DB_READER_HOST ?? cfg.DB_HOST) : cfg.DB_HOST,
    port: cfg.DB_PORT,
    database: cfg.DB_NAME,
    user: role === 'app' ? cfg.APP_DB_USER : cfg.READER_DB_USER,
    password: role === 'app' ? cfg.APP_DB_PASSWORD : cfg.READER_DB_PASSWORD,
    ssl,
    max: 10,
  };
}

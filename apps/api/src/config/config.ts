import { sslFromEnv } from '@joybot/db';
import type { PoolConfig } from 'pg';
import { z } from 'zod';

/** CloudFormation passes unset optional values as empty strings: treat them as unset. */
const optional = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === '' ? undefined : v), t.optional());

const schema = z
  .object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    /**
     * Web app origins allowed to call the API from another origin (comma-separated, e.g.
     * https://appjoy.dev,https://www.appjoy.dev). Unset: no CORS (same origin, as in AWS).
     */
    CORS_ORIGINS: optional(
      z
        .string()
        .transform((v) => v.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean))
        .pipe(z.array(z.string().url().refine((o) => new URL(o).origin === o, 'CORS_ORIGINS takes origins only (scheme://host[:port])')).min(1)),
    ),
    /** Local: full URLs. AWS: host/port + per-role credentials injected from Secrets Manager. */
    APP_DATABASE_URL: z.string().url().optional(),
    READER_DATABASE_URL: z.string().url().optional(),
    DB_HOST: z.string().optional(),
    DB_READER_HOST: optional(z.string()),
    DB_PORT: z.coerce.number().int().positive().default(5432),
    DB_NAME: z.string().default('joybot'),
    APP_DB_USER: z.string().default('joybot_app'),
    APP_DB_PASSWORD: z.string().optional(),
    READER_DB_USER: z.string().default('joybot_reader'),
    READER_DB_PASSWORD: z.string().optional(),
    /** Verify TLS to Aurora (CA bundle via NODE_EXTRA_CA_CERTS in the container image). */
    DB_SSL: z.enum(['true', 'false']).default('false'),
    /** CA for DB_SSL when the host is not RDS (e.g. Supabase): PEM text, or a file path in DB_SSL_CA_FILE. */
    DB_SSL_CA: optional(z.string()),
    DB_SSL_CA_FILE: optional(z.string()),
    /** OpenAI-compatible model endpoint (vLLM), e.g. http://model.joybot-dev.internal:8000/v1 */
    MODEL_ENDPOINT: optional(z.string().url()),
    /** Served model name (vLLM: gemma; Ollama: the local tag, e.g. gemma4:e2b). */
    MODEL_NAME: z.string().default('gemma'),
    /** Logs every model request (prompt, evidence, history) and response (tool calls, reasoning, answer). Dev only: prompts hold customer data. */
    MODEL_DEBUG: z.enum(['true', 'false']).default('false'),
    /**
     * Gemma 4's thinking step. 'plan' (default): only when picking tools, which runs only when the
     * intent rules miss; answers skip it (about 6x faster, 0.5 s instead of 3 s). 'all' or 'off'.
     */
    MODEL_THINKING: z.enum(['off', 'plan', 'all']).default('plan'),
    /** 'dev' trusts the x-dev-principal header — local development and tests only. */
    AUTH_MODE: z.enum(['dev', 'cognito', 'supabase']).default('cognito'),
    /**
     * Supabase Auth (AUTH_MODE=supabase, docs/deploy-free.md): the project URL; the service-role key for
     * managing logins (server-side only); SUPABASE_JWT_SECRET only for projects still on the legacy
     * shared-secret tokens (otherwise tokens are checked against the project's public keys).
     */
    SUPABASE_URL: optional(z.string().url()),
    SUPABASE_SERVICE_ROLE_KEY: optional(z.string().min(20)),
    SUPABASE_JWT_SECRET: optional(z.string().min(32)),
    /** AUTH_MODE=supabase links new logins as joybot_worker (the API's role may not), through this URL. */
    WORKER_DATABASE_URL: optional(z.string().url()),
    CUSTOMERS_USER_POOL_ID: z.string().optional(),
    CUSTOMERS_CLIENT_ID: z.string().optional(),
    EMPLOYEES_USER_POOL_ID: z.string().optional(),
    EMPLOYEES_CLIENT_ID: z.string().optional(),
    /** Stripe: secret with { restrictedKey, webhookSigningSecret } (AWS) or the signing secret directly (local). */
    STRIPE_SECRET_ARN: optional(z.string()),
    STRIPE_WEBHOOK_SECRET: optional(z.string()),
    /**
     * Invoices paid by card: a restricted Stripe key allowed to create Checkout Sessions. Locally set
     * directly; in AWS the Stripe secret's `checkoutKey`. Without it the portal offers bank transfer only.
     */
    STRIPE_CHECKOUT_KEY: optional(z.string()),
    STRIPE_API_BASE: optional(z.string().url()),
    /** MCP endpoint: requests per minute per access token. */
    MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
    /** Public app URL for links in invites: APP_URL locally, or an SSM parameter written by the frontend stack. */
    APP_URL: optional(z.string().url()),
    APP_URL_PARAMETER: optional(z.string()),
    /**
     * 'log' only logs outgoing email/WhatsApp (local); 'live' sends (SES, AWS WhatsApp); 'resend' sends
     * every email, verification codes included, through Resend (Admin › Email) and has no WhatsApp
     * (hosts without AWS). Defaults to 'log' with AUTH_MODE=dev, else 'live'.
     */
    MESSAGING_MODE: optional(z.enum(['log', 'live', 'resend'])),
    SES_FROM_ADDRESS: optional(z.string().email()),
    SES_CONFIGURATION_SET: optional(z.string()),
    /**
     * Encrypts secrets kept in the database (the Resend API key): any long random string. In AWS a
     * generated secret; locally, AUTH_MODE=dev falls back to a fixed development key.
     */
    SETTINGS_ENCRYPTION_KEY: optional(z.string().min(32)),
    /** The API's public origin, for OAuth redirects (e.g. https://app.example.com). Unset: the request's own origin. */
    API_PUBLIC_URL: optional(z.string().url()),
    /** Resend's API (tests point it elsewhere). */
    RESEND_API_BASE: optional(z.string().url()),
    /** SSM parameter read by the WhatsApp sender Lambda (messaging stack). Unset locally. */
    WHATSAPP_SETTINGS_PARAMETER: optional(z.string()),
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
    if (cfg.MODEL_DEBUG === 'true' && cfg.AUTH_MODE !== 'dev') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_DEBUG=true is only allowed with AUTH_MODE=dev' });
    }
    if (cfg.AUTH_MODE === 'supabase') {
      for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WORKER_DATABASE_URL'] as const) {
        if (!cfg[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${key} is required when AUTH_MODE=supabase` });
      }
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
  const ssl = sslFromEnv({ DB_SSL: cfg.DB_SSL, DB_SSL_CA: cfg.DB_SSL_CA, DB_SSL_CA_FILE: cfg.DB_SSL_CA_FILE });
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

import { BadGatewayException, BadRequestException, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';

/** HTTP for Resend's API; tests override it. */
export type ResendHttp = (url: string, init: RequestInit) => Promise<Response>;
export const RESEND_HTTP = Symbol('RESEND_HTTP');

/** GET /usage (https://resend.com/docs/api-reference/usage/retrieve-usage). */
export interface ResendUsage {
  object: 'usage';
  emails: {
    daily: { used: number; limit: number | null; sent: number; received: number; resets_at: string | null } | null;
    monthly: { used: number; limit: number | null; sent: number; received: number; resets_at: string | null } | null;
  };
  domains?: { used: number; limit: number | null };
  contacts?: { used: number; limit: number | null };
  rate_limit?: { limit: number; duration: string };
  [k: string]: unknown;
}

/** GET /domains. */
export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  created_at: string;
  region: string;
  capabilities?: { sending?: string; receiving?: string };
}

export interface ResendEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  tags?: { name: string; value: string }[];
}

/** A Resend error with what the admin page should say. */
export class ResendError extends HttpException {}

/** Calls Resend's REST API with an API key (never logged). */
@Injectable()
export class ResendClient {
  private readonly logger = new Logger('Resend');
  private readonly base: string;

  constructor(
    @Inject(RESEND_HTTP) private readonly http: ResendHttp,
    @Inject(APP_CONFIG) cfg: AppConfig,
  ) {
    this.base = (cfg.RESEND_API_BASE ?? 'https://api.resend.com').replace(/\/$/, '');
  }

  usage(key: string): Promise<ResendUsage> {
    return this.call<ResendUsage>(key, 'GET', '/usage');
  }

  async domains(key: string): Promise<ResendDomain[]> {
    return (await this.call<{ data: ResendDomain[] }>(key, 'GET', '/domains')).data ?? [];
  }

  async send(key: string, email: ResendEmail, idempotencyKey?: string): Promise<{ id: string }> {
    return this.call<{ id: string }>(key, 'POST', '/emails', email, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {});
  }

  private async call<T>(key: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.http(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          // Resend rejects requests without a User-Agent.
          'User-Agent': 'JoyBot',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.warn(`${method} ${path} failed: ${(err as Error).message}`);
      throw new BadGatewayException('Could not reach Resend; try again in a moment');
    }
    const data = (await res.json().catch(() => ({}))) as { name?: string; message?: string } & T;
    if (res.ok) return data;
    throw new ResendError({ statusCode: res.status, code: data.name ?? 'resend_error', message: explain(res.status, data) }, res.status === 401 || res.status === 403 ? 400 : res.status === 429 ? 429 : 502);
  }
}

/** Resend's error in words for the admin page. */
function explain(status: number, data: { name?: string; message?: string }): string {
  if (data.name === 'restricted_api_key') return 'This key can only send email. Create a key with full access to see usage and domains here.';
  if (status === 401 || data.name === 'invalid_api_key' || data.name === 'missing_api_key') return 'Resend did not accept this API key. Check it, or create a new one.';
  if (status === 429) return data.message ?? 'Resend rate limit reached; try again shortly.';
  return data.message ? `Resend: ${data.message}` : `Resend answered ${status}`;
}

export const isResendKey = (key: string) => /^re_[A-Za-z0-9_]{8,200}$/.test(key);

export function assertResendKey(key: string) {
  if (!isResendKey(key)) throw new BadRequestException('A Resend API key starts with re_');
}

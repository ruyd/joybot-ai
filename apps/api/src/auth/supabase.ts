import { ConflictException, Logger, type OnModuleDestroy } from '@nestjs/common';
import { sslFromEnv } from '@joybot/db';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { Pool } from 'pg';
import type { EmployeeLogins, EmployeeRole } from '../admin/employee-logins';
import type { AppConfig } from '../config/config';
import type { CustomerLogins } from '../profile/customer-logins';

/**
 * Supabase Auth (AUTH_MODE=supabase; docs/deploy-free.md). One user pool for staff and customers:
 * the web app says which area a request is for, and the API links the login to an employee or a
 * customer the first time (the same linking rules as Cognito's triggers). The login id (`sub`) is
 * stored where Cognito's is (`cognito_sub`). Roles stay in the database.
 */

/** A verified Supabase access token: who, and which contacts Supabase has confirmed. */
export interface SupabaseIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  /** E.164 (Supabase stores digits only). */
  phone: string | null;
  phoneVerified: boolean;
}

export interface SupabaseTokenVerifier {
  verify(token: string): Promise<SupabaseIdentity>;
}
/** Overridable in tests. */
export const SUPABASE_TOKENS = Symbol('SUPABASE_TOKENS');

/**
 * Links a login seen for the first time (Cognito's trigger Lambdas do this in AWS). Runs as
 * joybot_worker, like those Lambdas: the API's own role may not call the linking functions, so a bug in
 * the API cannot attach a login to someone else's account. Only what the verified token says is passed.
 */
export class SupabaseLoginLinker implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(cfg: Pick<AppConfig, 'WORKER_DATABASE_URL' | 'DB_SSL' | 'DB_SSL_CA' | 'DB_SSL_CA_FILE'>) {
    this.pool = new Pool({ connectionString: cfg.WORKER_DATABASE_URL, ssl: sslFromEnv(cfg), max: 2 });
  }

  /** The employee id, or null when no active, unlinked employee has this email. */
  linkEmployee(sub: string, email: string): Promise<string | null> {
    return this.run<{ id: string | null }>('SELECT authz.link_employee_login($1, $2) AS id', [sub, email]).then((r) => r?.id ?? null);
  }

  /** 'existing' | 'linked' | 'created' | 'review'. */
  linkCustomer(sub: string, email: string | null, phone: string | null): Promise<string | undefined> {
    return this.run<{ outcome: string }>('SELECT outcome FROM authz.link_customer_signup($1, $2, $3, $4, $5)', [sub, email, Boolean(email), phone, Boolean(phone)]).then(
      (r) => r?.outcome,
    );
  }

  private async run<T>(sql: string, args: unknown[]): Promise<T | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.via', 'supabase', true)`);
      const row = (await client.query(sql, args)).rows[0] as T | undefined;
      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
export const LOGIN_LINKER = Symbol('LOGIN_LINKER');

/** HTTP for Supabase's Auth admin API; tests override it. */
export type SupabaseHttp = (url: string, init: RequestInit) => Promise<Response>;
export const SUPABASE_HTTP = Symbol('SUPABASE_HTTP');

type Claims = JWTPayload & { email?: string; phone?: string; user_metadata?: { email_verified?: boolean; phone_verified?: boolean } };

/** Checks tokens against the project's public keys (or, for legacy projects, its shared secret). */
export class SupabaseJwtVerifier implements SupabaseTokenVerifier {
  private readonly issuer: string;
  private readonly key: ReturnType<typeof createRemoteJWKSet> | Uint8Array;

  constructor(cfg: Pick<AppConfig, 'SUPABASE_URL' | 'SUPABASE_JWT_SECRET'>) {
    const base = cfg.SUPABASE_URL!.replace(/\/$/, '');
    this.issuer = `${base}/auth/v1`;
    this.key = cfg.SUPABASE_JWT_SECRET
      ? new TextEncoder().encode(cfg.SUPABASE_JWT_SECRET)
      : createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async verify(token: string): Promise<SupabaseIdentity> {
    const options = { issuer: this.issuer, audience: 'authenticated' };
    const { payload } =
      this.key instanceof Uint8Array ? await jwtVerify<Claims>(token, this.key, { ...options, algorithms: ['HS256'] }) : await jwtVerify<Claims>(token, this.key, options);
    return identityFromClaims(payload);
  }
}

export function identityFromClaims(c: Claims): SupabaseIdentity {
  if (!c.sub || c.role !== 'authenticated') throw new Error('not a signed-in user');
  const phone = c.phone ? (c.phone.startsWith('+') ? c.phone : `+${c.phone}`) : null;
  return {
    sub: c.sub,
    email: c.email ? c.email.toLowerCase() : null,
    emailVerified: Boolean(c.email) && c.user_metadata?.email_verified === true,
    phone,
    phoneVerified: Boolean(phone) && c.user_metadata?.phone_verified === true,
  };
}

/** Supabase's Auth admin API with the service-role key (never sent to browsers). */
class SupabaseAdmin {
  private readonly base: string;
  private readonly key: string;

  constructor(
    cfg: Pick<AppConfig, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>,
    private readonly http: SupabaseHttp,
  ) {
    this.base = `${cfg.SUPABASE_URL!.replace(/\/$/, '')}/auth/v1`;
    this.key = cfg.SUPABASE_SERVICE_ROLE_KEY!;
  }

  async call<T>(method: string, path: string, body?: unknown, ok: number[] = []): Promise<{ status: number; data: T }> {
    const res = await this.http(`${this.base}${path}`, {
      method,
      // A secret key (sb_secret_…) goes only in `apikey`; a legacy service_role key (a JWT) also as the bearer.
      headers: {
        apikey: this.key,
        ...(this.key.startsWith('sb_') ? {} : { Authorization: `Bearer ${this.key}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { msg?: string; message?: string; error_code?: string };
    if (!res.ok && !ok.includes(res.status)) {
      throw new Error(`Supabase Auth ${method} ${path.split('?')[0]}: ${res.status} ${data.error_code ?? ''} ${data.msg ?? data.message ?? ''}`.trim());
    }
    return { status: res.status, data };
  }

  /** The login with this email (the admin API has no lookup by email, so pages through users). */
  async userIdByEmail(email: string): Promise<string | null> {
    const wanted = email.toLowerCase();
    for (let page = 1; page <= 50; page++) {
      const { data } = await this.call<{ users?: { id: string; email?: string }[] }>('GET', `/admin/users?page=${page}&per_page=1000`);
      const users = data.users ?? [];
      const hit = users.find((u) => u.email?.toLowerCase() === wanted);
      if (hit) return hit.id;
      if (users.length < 1000) return null;
    }
    return null;
  }
}

/**
 * Staff logins in Supabase. JoyBot's database decides who is an employee and their role; a login only
 * gets in once linked to an active employee with that verified email, so this is mostly the invite email.
 */
export class SupabaseEmployeeLogins implements EmployeeLogins {
  private readonly admin: SupabaseAdmin;
  private readonly logger = new Logger('EmployeeLogins');

  constructor(
    cfg: Pick<AppConfig, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>,
    http: SupabaseHttp,
    /** Emails the employee where to sign in (with Google, using this address). */
    private readonly notify: (email: string) => Promise<void>,
  ) {
    this.admin = new SupabaseAdmin(cfg, http);
  }

  /**
   * Staff sign in with Google, so there is no login to create: the first sign-in with this email links
   * it. A former employee's login is let back in. The email is best effort, so adding an employee
   * works before Admin › Email is set up.
   */
  async invite(email: string): Promise<void> {
    await this.enable(email);
    await this.resendInvite(email);
  }

  async resendInvite(email: string): Promise<void> {
    await this.notify(email).catch((err: unknown) => this.logger.warn(`invite email not sent: ${(err as Error).message}`));
  }

  /** Roles live in the database only. */
  async changeRole(_email: string, _from: EmployeeRole, _to: EmployeeRole): Promise<void> {}

  /** Bans the login (JoyBot already refuses it: the employee is inactive). */
  async disable(email: string): Promise<void> {
    const id = await this.admin.userIdByEmail(email);
    if (id) await this.admin.call('PUT', `/admin/users/${id}`, { ban_duration: '876000h' });
  }

  async enable(email: string): Promise<void> {
    const id = await this.admin.userIdByEmail(email);
    if (id) await this.admin.call('PUT', `/admin/users/${id}`, { ban_duration: 'none' });
  }
}

/** Keeps the customer's Supabase login in step with contacts verified in JoyBot (sign in with either). */
export class SupabaseCustomerLogins implements CustomerLogins {
  private readonly admin: SupabaseAdmin;
  private readonly logger = new Logger('CustomerLogins');

  constructor(cfg: Pick<AppConfig, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>, http: SupabaseHttp) {
    this.admin = new SupabaseAdmin(cfg, http);
  }

  async setVerifiedContact(sub: string, type: 'email' | 'phone', value: string): Promise<void> {
    const body = type === 'email' ? { email: value, email_confirm: true } : { phone: value.replace(/^\+/, ''), phone_confirm: true };
    const { status, data } = await this.admin.call<{ error_code?: string }>('PUT', `/admin/users/${sub}`, body, [422]);
    if (status === 422) {
      this.logger.warn(`contact not set on login: ${data.error_code ?? 'rejected'}`);
      throw new ConflictException('This contact is already used by another account');
    }
  }
}

import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { buildAccess, type Action, type Resource, type Role } from '@joybot/access';
import type { PrincipalType } from '@joybot/db';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Request } from 'express';
import { DatabaseError, type Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { APP_POOL } from '../db/db.module';
import { PermissionsService } from './permissions.service';
import { AUDIENCE, IS_PUBLIC, REQUIRES, type Principal } from './principal';
import { LOGIN_LINKER, SUPABASE_TOKENS, type SupabaseIdentity, type SupabaseLoginLinker, type SupabaseTokenVerifier } from './supabase';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type JwtVerifier = { verify(token: string): Promise<{ sub: string }> };
export interface AudienceVerifier {
  audience: PrincipalType;
  verifier: JwtVerifier;
}

/** One verifier per user pool (employees, customers). Overridable in tests. */
export const JWT_VERIFIERS = Symbol('JWT_VERIFIERS');

export function cognitoVerifiers(cfg: AppConfig): AudienceVerifier[] {
  if (cfg.AUTH_MODE !== 'cognito') return [];
  return [
    {
      audience: 'employee',
      verifier: CognitoJwtVerifier.create({
        userPoolId: cfg.EMPLOYEES_USER_POOL_ID!,
        clientId: cfg.EMPLOYEES_CLIENT_ID!,
        tokenUse: 'access',
      }),
    },
    {
      audience: 'customer',
      verifier: CognitoJwtVerifier.create({
        userPoolId: cfg.CUSTOMERS_USER_POOL_ID!,
        clientId: cfg.CUSTOMERS_CLIENT_ID!,
        tokenUse: 'access',
      }),
    },
  ];
}

/**
 * Authenticates every request (unless @Public), resolves the principal and its role from the
 * database, builds its ability, and enforces @Can / audience metadata.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(JWT_VERIFIERS) private readonly verifiers: AudienceVerifier[],
    @Inject(SUPABASE_TOKENS) private readonly supabase: SupabaseTokenVerifier | null,
    @Inject(LOGIN_LINKER) private readonly linker: SupabaseLoginLinker | null,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const identity =
      this.cfg.AUTH_MODE === 'dev' ? await this.devIdentity(req) : this.cfg.AUTH_MODE === 'supabase' ? await this.supabaseIdentity(req) : await this.cognitoIdentity(req);
    if (!identity.role) throw new UnauthorizedException('Unknown or inactive account');

    const principal: Principal = {
      type: identity.type,
      id: identity.id,
      role: identity.role,
      access: buildAccess(identity.role, await this.permissions.rows()),
    };
    req.principal = principal;

    const audience = this.reflector.getAllAndOverride<PrincipalType | undefined>(AUDIENCE, targets);
    if (audience && audience !== principal.type) throw new ForbiddenException();

    const requires = this.reflector.getAllAndOverride<{ action: Action; resource: Resource } | undefined>(
      REQUIRES,
      targets,
    );
    if (requires && !principal.access.can(requires.action, requires.resource)) {
      throw new ForbiddenException(`Not allowed to ${requires.action} ${requires.resource}`);
    }
    return true;
  }

  /** Local only: `x-dev-principal: employee:<uuid>` or `customer:<uuid>`. */
  private devIdentity(req: Request): Promise<{ type: PrincipalType; id: string; role: Role | null }> {
    const header = req.header('x-dev-principal') ?? '';
    const [type, id] = header.split(':');
    if ((type !== 'employee' && type !== 'customer') || !UUID.test(id ?? '')) {
      throw new UnauthorizedException('Missing or invalid x-dev-principal header');
    }
    return this.pool
      .query<{ role: Role | null }>('SELECT authz.role_of($1, $2) AS role', [type, id])
      .then((r) => ({ type, id, role: r.rows[0]?.role ?? null }));
  }

  /**
   * Supabase: one pool for staff and customers, so the web app says which area the request is for
   * (`x-joybot-audience: employee`, else customer). A login seen for the first time in an area is linked
   * with the same rules as Cognito's triggers, using only the contacts Supabase confirmed.
   */
  private async supabaseIdentity(req: Request): Promise<{ type: PrincipalType; id: string; role: Role | null }> {
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token || !this.supabase || !this.linker) throw new UnauthorizedException();
    let who: SupabaseIdentity;
    try {
      who = await this.supabase.verify(token);
    } catch {
      throw new UnauthorizedException();
    }
    const audience: PrincipalType = req.header('x-joybot-audience') === 'employee' ? 'employee' : 'customer';
    const resolve = async () =>
      (
        await this.pool.query<{ principal_type: PrincipalType; principal_id: string; role: Role }>(
          'SELECT principal_type, principal_id, role FROM authz.resolve_principal($1, $2)',
          [audience, who.sub],
        )
      ).rows[0];
    let row = await resolve();
    if (!row) {
      try {
        await this.link(audience, who);
      } catch (err) {
        // The web app's first requests arrive together: another one may have just linked this login.
        if (!(err instanceof DatabaseError && err.code === '23505')) throw err;
      }
      row = await resolve();
    }
    if (!row) throw new UnauthorizedException(audience === 'employee' ? 'No staff account uses this email' : 'Account is not linked');
    return { type: row.principal_type, id: row.principal_id, role: row.role };
  }

  /** First sign-in in an area: link the login (rules in SQL), using only contacts Supabase confirmed. */
  private async link(audience: PrincipalType, who: SupabaseIdentity): Promise<void> {
    if (audience === 'employee') {
      // Employees are created in JoyBot first; the first sign-in links them by verified email.
      if (!who.email || !who.emailVerified) throw new UnauthorizedException('Sign in with your work email');
      await this.linker!.linkEmployee(who.sub, who.email);
      return;
    }
    // Waiting for staff to review a contact clash: don't queue it again.
    if ((await this.pool.query<{ pending: boolean }>('SELECT authz.link_review_pending($1) AS pending', [who.sub])).rows[0]?.pending) throw this.inReview();
    const email = who.emailVerified ? who.email : null;
    const phone = who.phoneVerified ? who.phone : null;
    if (!email && !phone) throw new UnauthorizedException('Your email or phone is not confirmed yet');
    if ((await this.linker!.linkCustomer(who.sub, email, phone)) === 'review') throw this.inReview();
  }

  /** 403, not 401: the token is fine, so the web app should not sign the customer out. */
  private inReview() {
    return new ForbiddenException({
      statusCode: 403,
      code: 'account_in_review',
      message: 'Your account is being checked by our team. We will contact you shortly.',
    });
  }

  private async cognitoIdentity(req: Request): Promise<{ type: PrincipalType; id: string; role: Role | null }> {
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException();
    for (const { audience, verifier } of this.verifiers) {
      let sub: string;
      try {
        sub = (await verifier.verify(token)).sub;
      } catch {
        continue;
      }
      const res = await this.pool.query<{ principal_type: PrincipalType; principal_id: string; role: Role }>(
        'SELECT principal_type, principal_id, role FROM authz.resolve_principal($1, $2)',
        [audience, sub],
      );
      const row = res.rows[0];
      if (!row) {
        if (audience === 'customer') {
          const pending = (await this.pool.query<{ pending: boolean }>('SELECT authz.link_review_pending($1) AS pending', [sub])).rows[0];
          if (pending?.pending) throw this.inReview();
        }
        throw new UnauthorizedException('Account is not linked');
      }
      return { type: row.principal_type, id: row.principal_id, role: row.role };
    }
    throw new UnauthorizedException();
  }
}

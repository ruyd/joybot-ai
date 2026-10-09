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
import type { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { APP_POOL } from '../db/db.module';
import { PermissionsService } from './permissions.service';
import { AUDIENCE, IS_PUBLIC, REQUIRES, type Principal } from './principal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Verifier = { verify(token: string): Promise<{ sub: string }> };

/**
 * Authenticates every request (unless @Public), resolves the principal and its role from the
 * database, builds its ability, and enforces @Can / audience metadata.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly verifiers: { audience: PrincipalType; verifier: Verifier }[] = [];

  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_POOL) private readonly pool: Pool,
  ) {
    if (cfg.AUTH_MODE === 'cognito') {
      this.verifiers.push(
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
      );
    }
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const identity = this.cfg.AUTH_MODE === 'dev' ? await this.devIdentity(req) : await this.cognitoIdentity(req);
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
      if (!row) throw new UnauthorizedException('Account is not linked');
      return { type: row.principal_type, id: row.principal_id, role: row.role };
    }
    throw new UnauthorizedException();
  }
}

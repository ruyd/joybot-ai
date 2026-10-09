import { Inject, Injectable } from '@nestjs/common';
import type { PermissionRow } from '@joybot/access';
import type { Pool } from 'pg';
import { APP_POOL } from '../db/db.module';

const TTL_MS = 60_000;

/** Caches core.role_permissions (admins can change staff permissions; picked up within a minute). */
@Injectable()
export class PermissionsService {
  private cache?: { rows: PermissionRow[]; at: number };

  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  async rows(): Promise<PermissionRow[]> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.rows;
    const res = await this.pool.query<PermissionRow>('SELECT role, resource, action, scope FROM authz.permission_rows()');
    this.cache = { rows: res.rows, at: Date.now() };
    return res.rows;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

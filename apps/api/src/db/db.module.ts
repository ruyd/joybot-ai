import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { withPrincipal, type ChangeVia } from '@joybot/db';
import { Pool, type PoolClient } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Principal } from '../auth/principal';

export const APP_POOL = Symbol('APP_POOL');
export const READER_POOL = Symbol('READER_POOL');

@Injectable()
export class DbService implements OnModuleDestroy {
  constructor(
    @Inject(APP_POOL) readonly appPool: Pool,
    @Inject(READER_POOL) readonly readerPool: Pool,
  ) {}

  /** Back-office reads and writes as the principal (joybot_app role, RLS applies). */
  as<T>(principal: Principal, fn: (db: PoolClient) => Promise<T>, via: ChangeVia = 'api'): Promise<T> {
    return withPrincipal(this.appPool, principal, fn, via);
  }

  /** Read-only chat retrieval as the principal (joybot_reader role, RLS applies). */
  read<T>(principal: Principal, fn: (db: PoolClient) => Promise<T>): Promise<T> {
    return withPrincipal(this.readerPool, principal, fn, 'chat');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.appPool.end(), this.readerPool.end()]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: APP_POOL,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => new Pool({ connectionString: cfg.APP_DATABASE_URL, max: 10 }),
    },
    {
      provide: READER_POOL,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => new Pool({ connectionString: cfg.READER_DATABASE_URL, max: 10 }),
    },
    DbService,
  ],
  exports: [DbService, APP_POOL, READER_POOL],
})
export class DbModule {}

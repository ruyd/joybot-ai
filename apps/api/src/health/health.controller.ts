import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/principal';
import { DbService } from '../db/db.module';

@Controller()
@Public()
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.db.appPool.query('SELECT 1');
      return { status: 'ready', checks: { database: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({ status: 'not_ready', checks: { database: 'error' } });
    }
  }
}

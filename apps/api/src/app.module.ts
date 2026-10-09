import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { PermissionsService } from './auth/permissions.service';
import { AppExceptionFilter } from './common/pg-exception.filter';
import { APP_CONFIG, type AppConfig } from './config/config';
import { CustomersController } from './customers/customers.controller';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { MeController } from './me/me.controller';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { SettingsController } from './settings/settings.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        {
          module: class ConfigModule {},
          global: true,
          providers: [{ provide: APP_CONFIG, useValue: config }],
          exports: [APP_CONFIG],
        },
        DbModule,
      ],
      controllers: [HealthController, MeController, SettingsController, CustomersController, PaymentsController],
      providers: [
        PermissionsService,
        PaymentsService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ],
    };
  }
}

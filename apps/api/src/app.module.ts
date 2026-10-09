import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AccessController } from './admin/access.controller';
import { CognitoEmployeeLogins, EMPLOYEE_LOGINS, LocalEmployeeLogins } from './admin/employee-logins';
import { UsersController } from './admin/users.controller';
import { AppointmentsController } from './appointments/appointments.controller';
import { AppointmentsService } from './appointments/appointments.service';
import { AuthGuard, cognitoVerifiers, JWT_VERIFIERS } from './auth/auth.guard';
import { LocationsController } from './catalog/locations.controller';
import { ServicesController } from './catalog/services.controller';
import { PermissionsService } from './auth/permissions.service';
import { AppExceptionFilter } from './common/pg-exception.filter';
import { APP_CONFIG, type AppConfig } from './config/config';
import { ChatService } from './chat/chat.service';
import { ConversationsController } from './chat/conversations.controller';
import { EvidenceOnlyProvider, LLM_PROVIDER, OpenAiCompatibleProvider } from './chat/llm/llm.provider';
import { ChatToolsService } from './chat/tools';
import { CustomersController } from './customers/customers.controller';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { MeController } from './me/me.controller';
import { OrganizationsController } from './organizations/organizations.controller';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { SettingsController } from './settings/settings.controller';
import { StripeController } from './stripe/stripe.controller';
import { StripeSecrets } from './stripe/stripe-secrets';
import { WhatsAppSettingsPublisher } from './settings/whatsapp-publisher';

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
      controllers: [
        HealthController,
        MeController,
        SettingsController,
        LocationsController,
        ServicesController,
        OrganizationsController,
        CustomersController,
        AppointmentsController,
        PaymentsController,
        UsersController,
        AccessController,
        ConversationsController,
        StripeController,
      ],
      providers: [
        PermissionsService,
        { provide: JWT_VERIFIERS, useFactory: () => cognitoVerifiers(config) },
        AppointmentsService,
        PaymentsService,
        WhatsAppSettingsPublisher,
        ChatToolsService,
        StripeSecrets,
        ChatService,
        {
          provide: LLM_PROVIDER,
          useFactory: () =>
            config.MODEL_ENDPOINT ? new OpenAiCompatibleProvider(config.MODEL_ENDPOINT, config.MODEL_NAME) : new EvidenceOnlyProvider(),
        },
        {
          provide: EMPLOYEE_LOGINS,
          useFactory: () =>
            config.AUTH_MODE === 'cognito' && config.EMPLOYEES_USER_POOL_ID
              ? new CognitoEmployeeLogins(config.EMPLOYEES_USER_POOL_ID)
              : new LocalEmployeeLogins(),
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ],
    };
  }
}

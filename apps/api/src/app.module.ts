import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AccessController } from './admin/access.controller';
import { CognitoEmployeeLogins, EMPLOYEE_LOGINS, LocalEmployeeLogins } from './admin/employee-logins';
import { UsersController } from './admin/users.controller';
import { AppointmentTypesController } from './appointment-types/appointment-types.controller';
import { AppointmentsController } from './appointments/appointments.controller';
import { AppointmentsService } from './appointments/appointments.service';
import { AuthGuard, cognitoVerifiers, JWT_VERIFIERS } from './auth/auth.guard';
import {
  LOGIN_LINKER,
  SUPABASE_HTTP,
  SUPABASE_TOKENS,
  SupabaseCustomerLogins,
  SupabaseEmployeeLogins,
  SupabaseJwtVerifier,
  SupabaseLoginLinker,
  type SupabaseHttp,
} from './auth/supabase';
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
import { MergeController } from './customers/merge.controller';
import { DbModule } from './db/db.module';
import { TicketsController } from './tickets/tickets.controller';
import { TicketsService } from './tickets/tickets.service';
import { HealthController } from './health/health.controller';
import { MeController } from './me/me.controller';
import { SchedulesController } from './schedules/schedules.controller';
import { SchedulesService } from './schedules/schedules.service';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { TeamController } from './team/team.controller';
import { KnowledgeController } from './knowledge/knowledge.controller';
import { AiController } from './ai/ai.controller';
import { S3SiteAssetStore, SITE_ASSET_STORE } from './website/asset-store';
import { AiService, ConfiguredLlmProvider } from './ai/ai.service';
import { EmailController } from './email/email.controller';
import { GOOGLE_HTTP, GoogleClient } from './video/google';
import { VideoController } from './video/video.controller';
import { VideoService } from './video/video.service';
import { EmailService } from './email/email.service';
import { RESEND_HTTP, ResendClient } from './email/resend';
import { SecretBox } from './email/secret-box';
import { AwsMessageSender, LogMessageSender, MESSAGE_SENDER, MessagingService, ResendOnlySender } from './messaging/messaging.service';
import { CognitoCustomerLogins, CUSTOMER_LOGINS, LocalCustomerLogins } from './profile/customer-logins';
import { InvitesController } from './profile/invites.controller';
import { ProfileController } from './profile/profile.controller';
import { OrgController } from './org/org.controller';
import { OrganizationsController } from './organizations/organizations.controller';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { SettingsController } from './settings/settings.controller';
import { StripeController } from './stripe/stripe.controller';
import { StripeSecrets } from './stripe/stripe-secrets';
import { INVOICE_CHECKOUT, StripeInvoiceCheckout } from './invoices/checkout';
import { InvoicesController } from './invoices/invoices.controller';
import { InvoicesService } from './invoices/invoices.service';
import { AuditController } from './audit/audit.controller';
import { SiteController } from './website/site.controller';
import { WebsiteController } from './website/website.controller';
import { SalesCallsService } from './website/sales-calls.service';
import { WebsiteService } from './website/website.service';
import { McpController } from './mcp/mcp.controller';
import { TokensController } from './mcp/tokens.controller';
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
        EmailController,
        AiController,
        VideoController,
        LocationsController,
        ServicesController,
        OrganizationsController,
        CustomersController,
        MergeController,
        AppointmentsController,
        AppointmentTypesController,
        TasksController,
        SchedulesController,
        TeamController,
        InvoicesController,
        TokensController,
        McpController,
        AuditController,
        WebsiteController,
        SiteController,
        KnowledgeController,
        PaymentsController,
        UsersController,
        AccessController,
        ConversationsController,
        StripeController,
        TicketsController,
        OrgController,
        ProfileController,
        InvitesController,
      ],
      providers: [
        PermissionsService,
        { provide: JWT_VERIFIERS, useFactory: () => cognitoVerifiers(config) },
        { provide: SUPABASE_TOKENS, useFactory: () => (config.AUTH_MODE === 'supabase' ? new SupabaseJwtVerifier(config) : null) },
        { provide: SUPABASE_HTTP, useValue: (url: string, init: RequestInit) => fetch(url, init) },
        { provide: LOGIN_LINKER, useFactory: () => (config.AUTH_MODE === 'supabase' ? new SupabaseLoginLinker(config) : null) },
        AppointmentsService,
        PaymentsService,
        TasksService,
        InvoicesService,
        SchedulesService,
        WebsiteService,
        { provide: SITE_ASSET_STORE, useFactory: () => (config.SITE_ASSET_STORE === 's3' ? new S3SiteAssetStore(config) : null) },
        SalesCallsService,
        WhatsAppSettingsPublisher,
        ChatToolsService,
        StripeSecrets,
        {
          provide: INVOICE_CHECKOUT,
          inject: [StripeSecrets],
          useFactory: (secrets: StripeSecrets) => new StripeInvoiceCheckout(secrets, config.STRIPE_API_BASE),
        },
        TicketsService,
        MessagingService,
        EmailService,
        AiService,
        SecretBox,
        ResendClient,
        { provide: RESEND_HTTP, useValue: (url: string, init: RequestInit) => fetch(url, init) },
        VideoService,
        GoogleClient,
        { provide: GOOGLE_HTTP, useValue: (url: string, init: RequestInit) => fetch(url, init) },
        {
          provide: MESSAGE_SENDER,
          useFactory: () => {
            const mode = config.MESSAGING_MODE ?? (config.AUTH_MODE === 'dev' ? 'log' : 'live');
            return mode === 'log' ? new LogMessageSender() : mode === 'resend' ? new ResendOnlySender() : new AwsMessageSender(config);
          },
        },
        {
          provide: CUSTOMER_LOGINS,
          inject: [SUPABASE_HTTP],
          useFactory: (http: SupabaseHttp) =>
            config.AUTH_MODE === 'supabase'
              ? new SupabaseCustomerLogins(config, http)
              : config.AUTH_MODE === 'cognito' && config.CUSTOMERS_USER_POOL_ID
                ? new CognitoCustomerLogins(config.CUSTOMERS_USER_POOL_ID)
                : new LocalCustomerLogins(),
        },
        ChatService,
        {
          provide: LLM_PROVIDER,
          inject: [AiService],
          // Admin › AI's provider when one is saved, else MODEL_ENDPOINT, else evidence-only answers.
          useFactory: (ai: AiService) =>
            new ConfiguredLlmProvider(
              ai,
              config.MODEL_ENDPOINT
                ? new OpenAiCompatibleProvider(config.MODEL_ENDPOINT, config.MODEL_NAME, undefined, config.MODEL_DEBUG === 'true', config.MODEL_THINKING)
                : new EvidenceOnlyProvider(),
            ),
        },
        {
          provide: EMPLOYEE_LOGINS,
          inject: [SUPABASE_HTTP, MessagingService],
          useFactory: (http: SupabaseHttp, messaging: MessagingService) =>
            config.AUTH_MODE === 'supabase'
              ? new SupabaseEmployeeLogins(config, http, async (email) => {
                  const url = `${await messaging.appUrl()}/staff`;
                  await messaging.send({
                    channel: 'email',
                    to: email,
                    template: 'invite',
                    subject: 'You have a staff account',
                    text: `Hi,\n\nYou have been added to the staff console. Sign in with Google using this email address (${email}):\n\n${url}\n`,
                  });
                })
              : config.AUTH_MODE === 'cognito' && config.EMPLOYEES_USER_POOL_ID
                ? new CognitoEmployeeLogins(config.EMPLOYEES_USER_POOL_ID)
                : new LocalEmployeeLogins(),
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ],
    };
  }
}

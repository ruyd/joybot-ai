import { Inject, Injectable, Logger } from '@nestjs/common';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { APP_CONFIG, type AppConfig } from '../config/config';

export interface WhatsAppSettingsRow {
  whatsapp_enabled: boolean;
  whatsapp_phone_number_id: string | null;
  whatsapp_otp_template: string | null;
  whatsapp_template_language: string;
}

/**
 * Publishes WhatsApp settings from core.settings to the SSM parameter the Cognito WhatsApp sender
 * Lambda reads (plan.md §4.3), so changing the number or templates needs no redeploy.
 */
@Injectable()
export class WhatsAppSettingsPublisher {
  private readonly logger = new Logger(WhatsAppSettingsPublisher.name);
  private readonly ssm = new SSMClient({});

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  static payload(row: WhatsAppSettingsRow): string {
    return JSON.stringify({
      enabled: row.whatsapp_enabled,
      phoneNumberId: row.whatsapp_phone_number_id ?? undefined,
      otpTemplate: row.whatsapp_otp_template ?? undefined,
      language: row.whatsapp_template_language,
    });
  }

  async publish(row: WhatsAppSettingsRow): Promise<void> {
    const name = this.cfg.WHATSAPP_SETTINGS_PARAMETER;
    if (!name) {
      this.logger.debug('WHATSAPP_SETTINGS_PARAMETER not set; skipping publish (local development)');
      return;
    }
    await this.ssm.send(
      new PutParameterCommand({ Name: name, Value: WhatsAppSettingsPublisher.payload(row), Type: 'String', Overwrite: true }),
    );
  }
}

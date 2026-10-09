import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { SendWhatsAppMessageCommand, SocialMessagingClient } from '@aws-sdk/client-socialmessaging';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { APP_POOL } from '../db/db.module';

export interface OutgoingMessage {
  channel: 'email' | 'whatsapp';
  /** Email address or E.164 phone. */
  to: string;
  template: 'contact_code' | 'invite';
  subject: string;
  text: string;
  whatsapp?: { phoneNumberId: string; template: string; language: string; bodyParams: string[]; buttonParam?: string };
}

/** Delivery backend. Overridden in tests to capture messages. */
export interface MessageSender {
  send(message: OutgoingMessage): Promise<{ providerMessageId?: string }>;
}
export const MESSAGE_SENDER = Symbol('MESSAGE_SENDER');

const hash = (v: string) => createHash('sha256').update(v.toLowerCase()).digest('hex');

/** Sends email (SES v2) and WhatsApp (AWS End User Messaging Social) messages. */
export class AwsMessageSender implements MessageSender {
  private readonly ses = new SESv2Client({});
  private readonly social = new SocialMessagingClient({});

  constructor(private readonly cfg: AppConfig) {}

  async send(m: OutgoingMessage): Promise<{ providerMessageId?: string }> {
    if (m.channel === 'email') {
      if (!this.cfg.SES_FROM_ADDRESS) throw new ServiceUnavailableException('Email is not configured');
      const res = await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.cfg.SES_FROM_ADDRESS,
          Destination: { ToAddresses: [m.to] },
          ConfigurationSetName: this.cfg.SES_CONFIGURATION_SET,
          Content: { Simple: { Subject: { Data: m.subject }, Body: { Text: { Data: m.text } } } },
        }),
      );
      return { providerMessageId: res.MessageId };
    }
    if (!m.whatsapp) throw new ServiceUnavailableException('WhatsApp is not configured');
    const w = m.whatsapp;
    const components: object[] = [{ type: 'body', parameters: w.bodyParams.map((text) => ({ type: 'text', text })) }];
    if (w.buttonParam) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: w.buttonParam }] });
    const payload = { messaging_product: 'whatsapp', to: m.to.replace(/^\+/, ''), type: 'template', template: { name: w.template, language: { code: w.language }, components } };
    const res = await this.social.send(
      new SendWhatsAppMessageCommand({
        originationPhoneNumberId: w.phoneNumberId,
        message: new TextEncoder().encode(JSON.stringify(payload)),
        metaApiVersion: 'v20.0',
      }),
    );
    return { providerMessageId: res.messageId };
  }
}

/** Local development: log instead of sending (codes and links appear in the API log). */
export class LogMessageSender implements MessageSender {
  private readonly logger = new Logger('Messaging');
  async send(m: OutgoingMessage): Promise<{ providerMessageId?: string }> {
    this.logger.log(`(not sent) ${m.channel} to ${m.to}: ${m.subject}\n${m.text}`);
    return {};
  }
}

@Injectable()
export class MessagingService {
  private readonly ssm = new SSMClient({});
  private appUrlCache?: { value: string; at: number };

  constructor(
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Public URL of the web app, used in invite links. */
  async appUrl(): Promise<string> {
    if (this.cfg.APP_URL) return this.cfg.APP_URL.replace(/\/$/, '');
    if (this.appUrlCache && Date.now() - this.appUrlCache.at < 10 * 60_000) return this.appUrlCache.value;
    if (!this.cfg.APP_URL_PARAMETER) return 'http://localhost:5173';
    const res = await this.ssm.send(new GetParameterCommand({ Name: this.cfg.APP_URL_PARAMETER }));
    const value = (res.Parameter?.Value ?? 'http://localhost:5173').replace(/\/$/, '');
    this.appUrlCache = { value, at: Date.now() };
    return value;
  }

  async send(message: OutgoingMessage): Promise<void> {
    try {
      const res = await this.sender.send(message);
      await this.record(message, 'sent', res.providerMessageId);
    } catch (err) {
      await this.record(message, 'failed', undefined, err instanceof Error ? err.message : String(err));
      throw err instanceof ServiceUnavailableException
        ? err
        : new ServiceUnavailableException(`Could not send the ${message.channel === 'email' ? 'email' : 'WhatsApp message'}`);
    }
  }

  private async record(m: OutgoingMessage, status: string, providerMessageId?: string, error?: string) {
    await this.pool
      .query(
        `INSERT INTO app.message_deliveries (channel, template, to_hash, status, provider_message_id, error) VALUES ($1, $2, $3, $4, $5, $6)`,
        [m.channel, m.template, hash(m.to), status, providerMessageId ?? null, error?.slice(0, 500) ?? null],
      )
      .catch(() => undefined);
  }
}

/** "m•••a@example.com" / "+1 •••• 0106" for showing where a code or invite went. */
export function maskContact(value: string): string {
  if (value.includes('@')) {
    const [user, domain] = value.split('@');
    return `${user[0]}•••${user.length > 1 ? user[user.length - 1] : ''}@${domain}`;
  }
  return `${value.slice(0, 2)} •••• ${value.slice(-4)}`;
}

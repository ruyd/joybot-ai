import { createHash } from 'node:crypto';
import { buildClient, CommitmentPolicy, KmsKeyringNode } from '@aws-crypto/client-node';
import { SendWhatsAppMessageCommand, SocialMessagingClient } from '@aws-sdk/client-socialmessaging';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { CustomSMSSenderTriggerEvent } from 'aws-lambda';
import { required } from '../shared/db';
import { otpMessage, parseSettings, type WhatsAppSettings } from './message';

const { decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);
const ssm = new SSMClient({});
const social = new SocialMessagingClient({});
const META_API_VERSION = process.env.META_API_VERSION ?? 'v20.0';
const SETTINGS_TTL_MS = 5 * 60_000;

let settingsCache: { value: WhatsAppSettings; at: number } | undefined;

async function settings(): Promise<WhatsAppSettings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const res = await ssm.send(new GetParameterCommand({ Name: required('WHATSAPP_SETTINGS_PARAMETER') }));
  settingsCache = { value: parseSettings(res.Parameter?.Value), at: Date.now() };
  return settingsCache.value;
}

/**
 * Customers user pool, Custom SMS sender: Cognito hands us the verification / sign-in code
 * (encrypted with our KMS key) instead of sending an SMS; we deliver it over WhatsApp.
 * The code is never logged. Without WhatsApp configured the send fails and the portal offers email.
 */
export async function handler(event: CustomSMSSenderTriggerEvent): Promise<void> {
  const s = await settings();
  if (!s.enabled || !s.phoneNumberId || !s.otpTemplate) throw new Error('WhatsApp delivery is not configured');

  const phone = event.request.userAttributes.phone_number;
  if (!phone || !event.request.code) throw new Error('Missing phone number or code');

  const keyring = new KmsKeyringNode({ keyIds: [required('KEY_ARN')] });
  const { plaintext } = await decrypt(keyring, Buffer.from(event.request.code, 'base64'));
  const code = plaintext.toString('utf8');

  const message = otpMessage(phone, s.otpTemplate, s.language ?? 'en_US', code);
  const res = await social.send(
    new SendWhatsAppMessageCommand({
      originationPhoneNumberId: s.phoneNumberId,
      message: new TextEncoder().encode(JSON.stringify(message)),
      metaApiVersion: META_API_VERSION,
    }),
  );
  console.log(
    JSON.stringify({
      trigger: event.triggerSource,
      to: createHash('sha256').update(phone).digest('hex').slice(0, 16),
      messageId: res.messageId,
    }),
  );
}

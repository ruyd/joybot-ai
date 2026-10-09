/** WhatsApp settings published by the API to SSM from core.settings (plan.md §4.3). */
export interface WhatsAppSettings {
  enabled: boolean;
  phoneNumberId?: string;
  otpTemplate?: string;
  language?: string;
}

export function parseSettings(raw: string | undefined): WhatsAppSettings {
  try {
    const v = JSON.parse(raw ?? '{}');
    return {
      enabled: v.enabled === true,
      phoneNumberId: typeof v.phoneNumberId === 'string' ? v.phoneNumberId : undefined,
      otpTemplate: typeof v.otpTemplate === 'string' ? v.otpTemplate : undefined,
      language: typeof v.language === 'string' ? v.language : 'en_US',
    };
  } catch {
    return { enabled: false };
  }
}

/** WhatsApp Cloud API payload for an authentication template with a copy-code button. */
export function otpMessage(toE164: string, template: string, language: string, code: string): object {
  if (!/^\+[1-9][0-9]{6,14}$/.test(toE164)) throw new Error('Recipient must be an E.164 phone number');
  if (!/^[0-9A-Za-z]{4,12}$/.test(code)) throw new Error('Unexpected verification code format');
  return {
    messaging_product: 'whatsapp',
    to: toE164.slice(1),
    type: 'template',
    template: {
      name: template,
      language: { code: language },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    },
  };
}

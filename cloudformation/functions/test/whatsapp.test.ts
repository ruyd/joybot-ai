import { describe, expect, it } from 'vitest';
import { otpMessage, parseSettings } from '../src/whatsapp-sender/message';

describe('WhatsApp OTP message', () => {
  it('builds an authentication template with body and copy-code button parameters', () => {
    expect(otpMessage('+13105550106', 'joybot_otp', 'en_US', '123456')).toEqual({
      messaging_product: 'whatsapp',
      to: '13105550106',
      type: 'template',
      template: {
        name: 'joybot_otp',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] },
        ],
      },
    });
  });

  it('rejects malformed phones and codes', () => {
    expect(() => otpMessage('3105550106', 't', 'en_US', '123456')).toThrow(/E.164/);
    expect(() => otpMessage('+13105550106', 't', 'en_US', '12 34')).toThrow(/code format/);
  });
});

describe('WhatsApp settings', () => {
  it('defaults to disabled on missing or invalid JSON', () => {
    expect(parseSettings(undefined)).toMatchObject({ enabled: false });
    expect(parseSettings('not json')).toEqual({ enabled: false });
  });

  it('only enables on an explicit true', () => {
    expect(parseSettings('{"enabled":"yes"}').enabled).toBe(false);
    expect(parseSettings('{"enabled":true,"phoneNumberId":"phone-number-id-1","otpTemplate":"joybot_otp"}')).toEqual({
      enabled: true,
      phoneNumberId: 'phone-number-id-1',
      otpTemplate: 'joybot_otp',
      language: 'en_US',
    });
  });
});

import { openSecret, sealSecret, settingsSecret } from '@joybot/db';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';

/**
 * Encrypts secrets kept in the database (AES-256-GCM, key from SETTINGS_ENCRYPTION_KEY) as
 * "v1.<iv>.<tag>.<ciphertext>" in base64url (`@joybot/db` secret-box, shared with the worker). The
 * database alone cannot reveal them.
 */
@Injectable()
export class SecretBox {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** Whether secrets can be stored here (a key is configured, or local development). */
  get available(): boolean {
    return Boolean(settingsSecret(this.cfg));
  }

  encrypt(plain: string): string {
    return sealSecret(plain, this.secret());
  }

  decrypt(sealed: string): string {
    return openSecret(sealed, this.secret());
  }

  private secret(): string {
    const secret = settingsSecret(this.cfg);
    if (!secret) throw new ServiceUnavailableException('SETTINGS_ENCRYPTION_KEY is not set, so secrets cannot be stored');
    return secret;
  }
}

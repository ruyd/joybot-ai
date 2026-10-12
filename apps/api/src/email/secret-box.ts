import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';

/** Local development only (AUTH_MODE=dev): never used where a real key is configured. */
const DEV_KEY = 'joybot-local-development-settings-key-not-secret';

/**
 * Encrypts secrets kept in the database (AES-256-GCM, key from SETTINGS_ENCRYPTION_KEY) as
 * "v1.<iv>.<tag>.<ciphertext>" in base64url. The database alone cannot reveal them.
 */
@Injectable()
export class SecretBox {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** Whether secrets can be stored here (a key is configured, or local development). */
  get available(): boolean {
    return Boolean(this.secret());
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable secret');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  private secret(): string | undefined {
    return this.cfg.SETTINGS_ENCRYPTION_KEY ?? (this.cfg.AUTH_MODE === 'dev' ? DEV_KEY : undefined);
  }

  private key(): Buffer {
    const secret = this.secret();
    if (!secret) throw new ServiceUnavailableException('SETTINGS_ENCRYPTION_KEY is not set, so secrets cannot be stored');
    return createHash('sha256').update(secret).digest();
  }
}

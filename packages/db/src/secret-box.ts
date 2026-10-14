import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Local development only (AUTH_MODE=dev): never used where a real key is configured. */
export const DEV_SETTINGS_KEY = 'joybot-local-development-settings-key-not-secret';

/** SETTINGS_ENCRYPTION_KEY, or the development key in local development; undefined when secrets can't be kept. */
export function settingsSecret(env: { SETTINGS_ENCRYPTION_KEY?: string; AUTH_MODE?: string }): string | undefined {
  return env.SETTINGS_ENCRYPTION_KEY || (env.AUTH_MODE === 'dev' ? DEV_SETTINGS_KEY : undefined);
}

const keyOf = (secret: string) => createHash('sha256').update(secret).digest();

/**
 * Encrypts a secret kept in the database (AES-256-GCM) as "v1.<iv>.<tag>.<ciphertext>" in base64url.
 * Shared by the API (which stores keys) and the worker (which uses the Stripe key).
 */
export function sealSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function openSecret(sealed: string, secret: string): string {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable secret');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

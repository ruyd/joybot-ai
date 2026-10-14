import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '../config/config';

/**
 * Where website images live when they are not in Postgres: an S3-compatible bucket (Cloudflare R2 on
 * the free-tier deploy), served publicly from `publicUrl(id)`. Null (the token's value) keeps images
 * in the database.
 */
export interface SiteAssetStore {
  put(id: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Removes the object and, where possible, purges it from the CDN's cache. */
  delete(id: string): Promise<void>;
  publicUrl(id: string): string;
}

export const SITE_ASSET_STORE = Symbol('SITE_ASSET_STORE');

const key = (id: string) => `site/${id}`;

/** R2 or S3 through the AWS SDK; deleted images are purged from Cloudflare's cache when a token is set. */
export class S3SiteAssetStore implements SiteAssetStore {
  private readonly logger = new Logger('SiteAssets');
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly base: string;

  constructor(
    private readonly cfg: AppConfig,
    private readonly http: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {
    this.bucket = cfg.S3_BUCKET!;
    this.base = cfg.SITE_ASSET_BASE_URL!.replace(/\/$/, '');
    this.s3 = new S3Client({
      region: cfg.S3_REGION ?? (cfg.S3_ENDPOINT ? 'auto' : 'us-east-1'),
      endpoint: cfg.S3_ENDPOINT,
      credentials:
        cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY ? { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } : undefined,
    });
  }

  publicUrl(id: string): string {
    return `${this.base}/${key(id)}`;
  }

  async put(id: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key(id),
        Body: bytes,
        ContentType: contentType,
        // Ids are never reused and images never change.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async delete(id: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key(id) }));
    const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ZONE_ID: zone } = this.cfg;
    if (!token || !zone) return;
    try {
      const res = await this.http(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ files: [this.publicUrl(id)] }),
      });
      if (!res.ok) this.logger.warn(`cache purge for ${id} returned ${res.status}`);
    } catch (err) {
      this.logger.warn(`cache purge for ${id} failed: ${(err as Error).message}`);
    }
  }
}

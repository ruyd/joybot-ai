import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';
import { respond } from '../shared/custom-resource';
import { siteFiles } from './files';

const s3 = new S3Client({});
const cloudfront = new CloudFrontClient({});

interface Props {
  SourceBucket: string;
  SourceKey: string;
  SiteBucket: string;
  DistributionId: string;
  Config: string; // JSON for /config.json (Cognito ids, API path, …)
}

async function listKeys(bucket: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    keys.push(...(page.Contents ?? []).map((o) => o.Key!));
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

async function deleteKeys(bucket: string, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }),
    );
  }
}

/**
 * Custom resource (plan.md §8.4 "Frontend assets"): publishes the web build from the private
 * artifacts bucket to the site bucket, writes config.json, removes stale files and invalidates
 * CloudFront. On delete it empties the site bucket so the stack can be removed.
 */
export async function handler(event: CloudFormationCustomResourceEvent, context: Context): Promise<void> {
  const props = event.ResourceProperties as unknown as Props;
  const physicalId = `web-assets-${props.SiteBucket}`;
  const timer = setTimeout(
    () => void respond(event, 'FAILED', physicalId, {}, 'Timed out'),
    Math.max(context.getRemainingTimeInMillis() - 5_000, 1_000),
  );
  try {
    if (event.RequestType === 'Delete') {
      await deleteKeys(props.SiteBucket, await listKeys(props.SiteBucket));
    } else {
      const zip = await s3.send(new GetObjectCommand({ Bucket: props.SourceBucket, Key: props.SourceKey }));
      const files = siteFiles(await zip.Body!.transformToByteArray(), JSON.parse(props.Config));
      // Hashed assets first, index.html last, so a visitor never gets HTML pointing at missing files.
      files.sort((a, b) => Number(a.key === 'index.html') - Number(b.key === 'index.html'));
      for (const f of files) {
        await s3.send(
          new PutObjectCommand({
            Bucket: props.SiteBucket,
            Key: f.key,
            Body: f.body,
            ContentType: f.contentType,
            CacheControl: f.cacheControl,
          }),
        );
      }
      const keep = new Set(files.map((f) => f.key));
      await deleteKeys(props.SiteBucket, (await listKeys(props.SiteBucket)).filter((k) => !keep.has(k)));
      await cloudfront.send(
        new CreateInvalidationCommand({
          DistributionId: props.DistributionId,
          InvalidationBatch: { CallerReference: `${event.RequestId}`, Paths: { Quantity: 1, Items: ['/*'] } },
        }),
      );
      console.log(JSON.stringify({ uploaded: files.length }));
    }
    clearTimeout(timer);
    await respond(event, 'SUCCESS', physicalId);
  } catch (err) {
    clearTimeout(timer);
    console.error(err);
    await respond(event, 'FAILED', physicalId, {}, err instanceof Error ? err.message : String(err));
  }
}

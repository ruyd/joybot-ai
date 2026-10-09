import https from 'node:https';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

/** Sends the custom resource result to CloudFormation (the pre-signed ResponseURL). */
export async function respond(
  event: CloudFormationCustomResourceEvent,
  status: 'SUCCESS' | 'FAILED',
  physicalResourceId: string,
  data: Record<string, string> = {},
  reason?: string,
): Promise<void> {
  const body = JSON.stringify({
    Status: status,
    Reason: (reason ?? status).slice(0, 3000),
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });
  const url = new URL(event.ResponseURL);
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

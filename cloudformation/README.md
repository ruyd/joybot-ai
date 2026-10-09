# JoyBot CloudFormation

Plain CloudFormation, deployed to **us-east-1** from a **private** artifacts bucket shared with the
JoyBot AWS Organization (plan.md §8).

```
main.yaml                 root stack (Quick-Create links point here)
stacks/network.yaml       VPC, subnets (public/private/isolated), NAT + Elastic IPs, endpoints
stacks/data.yaml          Aurora PostgreSQL Serverless v2, role secrets, integration secrets,
                          Stripe events queue, DB bootstrap custom resource
stacks/messaging.yaml     WhatsApp sender (Cognito custom SMS sender), KMS key, settings parameter, SES
stacks/auth.yaml          customers + employees user pools, trigger Lambdas, SSO, first admin
stacks/compute.yaml       ECS cluster, cpu (Graviton) + gpu Auto Scaling group capacity providers
stacks/model.yaml         vLLM serving Gemma 4 (Cloud Map), S3 weights cache, scale-to-zero schedule
stacks/backend.yaml       internal ALB, API service (+ worker when enabled), autoscaling, task roles
stacks/frontend.yaml      private site bucket + CloudFront (VPC origin for /api), WAF, domain, web assets
stacks/observability.yaml alarms (email to the admin) and a CloudWatch dashboard
bootstrap/artifacts.yaml  one-time: private artifacts bucket + ECR repos (tooling account)
functions/                Lambda sources (@joybot/functions), built into dist/*.zip
web-placeholder/          shown until the web app exists (Phase 2)
scripts/                  publish.sh, quickcreate-link.mjs, check_nested.py
parameters/               parameter files for our own environments
```

## One-time setup (tooling account)

```bash
aws cloudformation deploy --region us-east-1 --stack-name joybot-artifacts \
  --template-file cloudformation/bootstrap/artifacts.yaml \
  --parameter-overrides OrganizationId=o-xxxxxxxxxx
```

## Publish a release

Requires `cfn-lint` (`pip install cfn-lint`), the AWS CLI, Docker with `buildx` (arm64 + amd64)
and credentials for the tooling account. It lints the templates, checks nested-stack parameters,
builds and pushes the API and model-server images, and uploads templates, Lambda zips and the web
bundle.

```bash
cloudformation/scripts/publish.sh v0.1.0
```

Versions are immutable; Lambda code only updates when `ArtifactsVersion` changes. The script prints
the dev and prod Quick-Create links, which open the CloudFormation console with the template and
parameters filled in. They only work for principals in the Organization.

## Deploy our own environment from the CLI

```bash
aws cloudformation create-stack --region us-east-1 --stack-name joybot-dev \
  --template-url https://joybot-artifacts-us-east-1.s3.us-east-1.amazonaws.com/v0.1.0-dev.1/main.yaml \
  --parameters file://cloudformation/parameters/dev.json \
               ParameterKey=HuggingFaceToken,ParameterValue="$HF_TOKEN" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND
```

## After deploy

| Step | Where |
|---|---|
| First admin: accept the emailed invite, set a password, enrol an authenticator app | Staff sign-in (`EmployeesLoginDomain` output) |
| Freshdesk: put `{"apiKey": "..."}` in the `FreshdeskSecretArn` secret | Secrets Manager |
| Stripe: put `{"restrictedKey": "rk_...", "webhookSigningSecret": "whsec_..."}` in `StripeSecretArn` | Secrets Manager |
| WhatsApp: Meta Business account → WhatsApp Business Account + number in **AWS End User Messaging Social** → approved OTP template → Admin → Settings → WhatsApp | Meta, AWS console, JoyBot admin |
| SES: confirm the verification email for `SesFromAddress` (and request SES production access) | Email / SES console |
| Without a custom domain: add `<AppUrl>/auth/callback` to the `AppCallbackUrls` parameter and update the stack (the CloudFront URL is only known after the first deploy) | CloudFormation |
| Confirm the alarm email subscription | Email |

## Things to verify on the first real deployment

These depend on AWS behavior that cannot be checked locally:

- Cognito accepts `SMS_OTP` as a first auth factor with only a **custom SMS sender** (no SNS SMS
  configuration). If not, drop `SMS_OTP` and use phone + password sign-in with WhatsApp verification.
- The custom-sender KMS key policy (Cognito `kms:Encrypt`/`kms:CreateGrant`) is sufficient.
- The DB bootstrap Lambda reaches Secrets Manager through the NAT (or enable interface endpoints).
- Aurora PostgreSQL engine version `16.6` is offered in us-east-1 (`DbEngineVersion` parameter).
- The AL2023 GPU AMI parameter `/aws/service/ecs/optimized-ami/amazon-linux-2023/gpu/recommended/image_id`
  resolves (otherwise set `GpuAmiId` in compute.yaml to the documented path).
- Hugging Face repository names for variants other than E2B (`google/gemma-4-E2B-it` is confirmed);
  use `ModelIdOverride` if they differ.
- CloudFront's `AllViewerExceptHostHeader` origin request policy forwards the `Authorization` header
  to the ALB through the VPC origin.
- New AMIs: launch template changes do not replace running instances; start an Auto Scaling
  instance refresh after a stack update (managed draining moves tasks safely).

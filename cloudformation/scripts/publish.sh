#!/usr/bin/env bash
# Publishes a JoyBot release to the private tooling account (plan.md §9 "Release"):
#   - container images → private ECR (joybot/api + joybot/worker arm64, joybot/model-server amd64)
#   - templates, Lambda zips and the web bundle → s3://<bucket>/<version>/
# Usage: cloudformation/scripts/publish.sh <version> [bucket]
# Versions are immutable: an existing version is never overwritten (use v0.1.1-dev.3 while iterating).
set -euo pipefail

VERSION="${1:?usage: publish.sh <version> [bucket]}"
BUCKET="${2:-joybot-artifacts-us-east-1}"
REGION=us-east-1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFN="$ROOT/cloudformation"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "invalid version: $VERSION" >&2; exit 1; }
if aws s3api head-object --bucket "$BUCKET" --key "$VERSION/main.yaml" >/dev/null 2>&1; then
  echo "$VERSION is already published to s3://$BUCKET (versions are immutable)" >&2
  exit 1
fi

echo "› checking templates"
cfn-lint "$CFN/main.yaml" "$CFN"/stacks/*.yaml "$CFN"/bootstrap/*.yaml
python3 "$CFN/scripts/check_nested.py"

echo "› building Lambda functions"
pnpm --dir "$ROOT" package:functions

echo "› building the web bundle"
pnpm --dir "$ROOT" --filter @joybot/web build
WEB_DIR="$ROOT/apps/web/dist"
[[ -f "$WEB_DIR/index.html" ]] || WEB_DIR="$CFN/web-placeholder"
rm -f "$CFN/functions/dist/site.zip"
(cd "$WEB_DIR" && zip -qr "$CFN/functions/dist/site.zip" .)

echo "› building and pushing images to $REGISTRY"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker buildx build --platform linux/arm64 -f "$ROOT/apps/api/Dockerfile" -t "$REGISTRY/joybot/api:$VERSION" --push "$ROOT"
docker buildx build --platform linux/arm64 -f "$ROOT/apps/worker/Dockerfile" -t "$REGISTRY/joybot/worker:$VERSION" --push "$ROOT"
docker buildx build --platform linux/amd64 -t "$REGISTRY/joybot/model-server:$VERSION" --push "$ROOT/services/model-server"

echo "› uploading to s3://$BUCKET/$VERSION/"
aws s3 cp "$CFN/main.yaml" "s3://$BUCKET/$VERSION/main.yaml"
aws s3 cp "$CFN/stacks/" "s3://$BUCKET/$VERSION/stacks/" --recursive --exclude "*" --include "*.yaml"
aws s3 cp "$CFN/functions/dist/" "s3://$BUCKET/$VERSION/functions/" --recursive --exclude "*" --include "*.zip" --exclude "site.zip"
aws s3 cp "$CFN/functions/dist/site.zip" "s3://$BUCKET/$VERSION/web/site.zip"

echo "› Quick-Create links"
node "$CFN/scripts/quickcreate-link.mjs" "$VERSION" dev "$ACCOUNT" "$BUCKET"
node "$CFN/scripts/quickcreate-link.mjs" "$VERSION" prod "$ACCOUNT" "$BUCKET"

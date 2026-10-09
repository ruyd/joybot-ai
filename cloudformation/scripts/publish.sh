#!/usr/bin/env bash
# Publishes a JoyBot release (templates + Lambda zips) to the private artifacts bucket.
#   cloudformation/scripts/publish.sh v0.1.0 [bucket]
# Versions are immutable: an existing version is never overwritten (use a new pre-release tag
# such as v0.1.1-dev.3 while iterating).
set -euo pipefail

VERSION="${1:?usage: publish.sh <version> [bucket]}"
BUCKET="${2:-joybot-artifacts-us-east-1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFN="$ROOT/cloudformation"

[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "invalid version: $VERSION" >&2; exit 1; }
if aws s3api head-object --bucket "$BUCKET" --key "$VERSION/main.yaml" >/dev/null 2>&1; then
  echo "$VERSION is already published to s3://$BUCKET (versions are immutable)" >&2
  exit 1
fi

echo "› linting templates"
cfn-lint "$CFN/main.yaml" "$CFN"/stacks/*.yaml

echo "› building Lambda functions"
pnpm --dir "$ROOT" package:functions

echo "› uploading to s3://$BUCKET/$VERSION/"
aws s3 cp "$CFN/main.yaml" "s3://$BUCKET/$VERSION/main.yaml"
aws s3 cp "$CFN/stacks/" "s3://$BUCKET/$VERSION/stacks/" --recursive --exclude "*" --include "*.yaml"
aws s3 cp "$CFN/functions/dist/" "s3://$BUCKET/$VERSION/functions/" --recursive --exclude "*" --include "*.zip"

echo "› Quick-Create links"
node "$CFN/scripts/quickcreate-link.mjs" "$VERSION" dev "$BUCKET"
node "$CFN/scripts/quickcreate-link.mjs" "$VERSION" prod "$BUCKET"

// Prints a CloudFormation Quick-Create link for a published release (plan.md §8.1).
//   node cloudformation/scripts/quickcreate-link.mjs v0.1.0 dev [bucket]
// The link only works for principals in the JoyBot AWS Organization (private artifacts).
const [version, profile = 'dev', bucket = 'joybot-artifacts-us-east-1'] = process.argv.slice(2);
if (!version) {
  console.error('usage: quickcreate-link.mjs <version> [dev|prod] [bucket]');
  process.exit(1);
}

const region = 'us-east-1';
const profiles = {
  dev: { EnvironmentName: 'dev', SeedSampleData: 'true', NatGatewayMode: 'single', DbMinAcu: '0.5' },
  prod: { EnvironmentName: 'prod', SeedSampleData: 'false', NatGatewayMode: 'per-az', DbMinAcu: '1', CustomerPoolTier: 'PLUS' },
};
const params = profiles[profile];
if (!params) {
  console.error(`unknown profile ${profile}`);
  process.exit(1);
}

const query = new URLSearchParams({
  templateURL: `https://${bucket}.s3.${region}.amazonaws.com/${version}/main.yaml`,
  stackName: `joybot-${params.EnvironmentName}`,
  param_ArtifactsBucket: bucket,
  param_ArtifactsVersion: version,
  ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param_${k}`, v])),
});
console.log(`${profile}: https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${query}`);

// Prints a CloudFormation Quick-Create link for a published release (plan.md §8.1).
//   node cloudformation/scripts/quickcreate-link.mjs v0.1.0 dev 111122223333 [bucket]
// The link only works for principals in the JoyBot AWS Organization (private artifacts).
// Secrets (HuggingFaceToken) are never put in links; the console asks for them.
const [version, profile = 'dev', artifactsAccountId, bucket = 'joybot-artifacts-us-east-1'] = process.argv.slice(2);
if (!version || !/^\d{12}$/.test(artifactsAccountId ?? '')) {
  console.error('usage: quickcreate-link.mjs <version> [dev|prod] <artifacts-account-id> [bucket]');
  process.exit(1);
}

const region = 'us-east-1';
const profiles = {
  dev: {
    EnvironmentName: 'dev',
    SeedSampleData: 'true',
    NatGatewayMode: 'single',
    CpuInstanceType: 't4g.medium',
    CpuUseSpot: 'true',
    GpuMinTasks: '0',
    GpuScheduleScaleDown: 'true',
  },
  prod: {
    EnvironmentName: 'prod',
    SeedSampleData: 'false',
    NatGatewayMode: 'per-az',
    DbMinAcu: '1',
    CustomerPoolTier: 'PLUS',
    CpuInstanceType: 'm7g.large',
    CpuMinCapacity: '2',
    CpuMaxCapacity: '6',
    ApiMinTasks: '2',
    GpuMinTasks: '1',
    GpuScheduleScaleDown: 'false',
    EnableWaf: 'true',
  },
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
  param_ArtifactsAccountId: artifactsAccountId,
  param_ArtifactsVersion: version,
  ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param_${k}`, v])),
});
console.log(`${profile}: https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${query}`);

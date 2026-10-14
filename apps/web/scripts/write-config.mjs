// Writes dist/config.json for static hosts other than AWS (docs/deploy-free.md), from build variables.
// AWS writes its own config.json when deploying (cloudformation/functions/src/web-assets), so this
// only runs where the build command calls it, after `vite build`:
//   pnpm --filter @joybot/web build && node apps/web/scripts/write-config.mjs
//
//   WEB_API_BASE              the API's base URL, e.g. https://api.appjoy.dev/api   (required)
//   SUPABASE_URL              the Supabase project URL                              (required)
//   SUPABASE_PUBLISHABLE_KEY  its publishable (anon) key; public by design          (required)
//   APP_URL                   the web app's own URL, e.g. https://appjoy.dev        (optional)
//   WEB_ENVIRONMENT           label shown in the app, default "production"          (optional)
//   SITE_ASSET_BASE_URL       website images bucket, e.g. https://cdn.appjoy.dev    (optional; the API's
//                             SITE_ASSET_STORE=s3 with the same address)
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const missing = ['WEB_API_BASE', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'].filter((k) => !env[k]);
if (missing.length) {
  // Never ship the local development config (dev sign-in picker) by accident.
  console.error(`write-config: missing ${missing.join(', ')}`);
  process.exit(1);
}
const url = (name) => {
  try {
    return new URL(env[name]).toString().replace(/\/$/, '');
  } catch {
    console.error(`write-config: ${name} is not a URL`);
    process.exit(1);
  }
};

const config = {
  environment: env.WEB_ENVIRONMENT || 'production',
  apiBase: url('WEB_API_BASE'),
  authMode: 'supabase',
  supabase: { url: url('SUPABASE_URL'), anonKey: env.SUPABASE_PUBLISHABLE_KEY },
  ...(env.APP_URL ? { appUrl: url('APP_URL') } : {}),
  ...(env.SITE_ASSET_BASE_URL ? { assetBase: url('SITE_ASSET_BASE_URL') } : {}),
};
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/config.json');
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(`write-config: ${out} (api ${config.apiBase})`);

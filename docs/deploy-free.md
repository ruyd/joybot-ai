# Free-tier deploy: Supabase + Render + Cloudflare + OpenRouter

A second way to run JoyBot on free plans, **alongside** the AWS deploy (`cloudformation/`), never instead
of it. Every change is opt-in by environment variables whose defaults keep today's behaviour, so the
AWS stacks, Lambdas and defaults (`AUTH_MODE=cognito`, SES, Secrets Manager, images in Postgres) stay as
they are. Branch: `supabase`.

Status: items 1–5 and 8 are built on this branch (8 needs the Render, Cloudflare and GitHub
settings); 6 (Admin › AI) and 7 (images on R2) are still a plan. Free-plan limits quoted here change; check each
provider's current pricing page before relying on a number.

## The stack

| Piece | Where | Free plan | Replaces (AWS) |
|---|---|---|---|
| Database | **Supabase** Postgres | 500 MB, ~5 GB egress/month, no backups, paused after a week idle | RDS |
| Sign-in | **Supabase Auth** with Google | 50k MAU | Cognito (2 pools) + 2 Lambda triggers |
| API (NestJS) + worker | **Render** web service (`deploy/render/Dockerfile`: both processes in one container) | 512 MB, sleeps after 15 min idle (~1 min to wake), 750 h/month | ECS + worker service |
| Web app (site, booking, portal, staff) | **Cloudflare Pages** | Unlimited static bandwidth | S3 + CloudFront |
| Website images | **Cloudflare R2**, public bucket on `cdn.appjoy.dev` | 10 GB, no egress fees, 10M reads/month | `core.site_asset_data` (bytes in Postgres) |
| Chat model (Gemma 4) | **OpenRouter** or own deployment, chosen in Admin › AI | Pay per token (free models are rate-limited and may log prompts) | vLLM on a GPU |
| Email | **Resend** for everything | 3k emails/month, 100/day | SES |
| WhatsApp | Off at first (later: Meta Cloud API directly) | | AWS End User Messaging |

Domains: `appjoy.dev` → Pages, `api.appjoy.dev` → Render, `cdn.appjoy.dev` → R2. Move the domain's DNS
to Cloudflare (free) first: it is needed for the Pages apex domain, `cdn.` and caching in front of the
API. Check the imported records (Resend DKIM/SPF, Firebase verification) before switching nameservers.

## Decisions so far

- **The API is not on Supabase.** Edge Functions are short-lived Deno functions (CPU/time/bundle
  limits); the NestJS API with streamed chat does not fit. Render runs the existing container.
- **Supabase Auth over Firebase Auth:** linking logins to customers/employees stays in SQL we already
  have; one vendor with the database. **Google sign-in only**, which needs no auth email at all.
- **No Vercel:** Hobby is non-commercial. **Cloudflare Pages over Firebase Spark:** unlimited static
  bandwidth vs 360 MB/day. Same origin is not needed: the web app calls `api.appjoy.dev` with CORS.
- **Stripe webhooks stay in the API** (not an Edge Function): the API must run anyway; a second runtime
  would duplicate signature checks, secrets and tests.
- **No separate worker service:** the worker is Stripe only (apply events, reconcile, queued jobs,
  ~600 lines). Render's free plan has no background workers, so it runs as a second process in the
  API's container (`deploy/render/start.mjs`), unchanged and still as `joybot_worker`. OpenRouter
  replaces the *model server*, not the worker.
- **Website images in a public R2 bucket.** They are already public today (`GET /api/site/assets/:id`
  serves any image by UUID, cached for a year). Conditions: website images only, random UUID keys,
  served on `cdn.appjoy.dev` with `nosniff`, cache purged on delete, and an explicit exception to the
  owner rule "no public buckets" recorded in CLAUDE.md. Anything private later (ticket attachments,
  invoices) goes in a separate private bucket served through the API.

## Work items

Each is a small PR on its own; together they make the free deploy work. Defaults keep AWS unchanged.

### 1. Database on Supabase ✅
- Migrations run unchanged as Supabase's `postgres` user (not a superuser; ours only need CREATE ROLE,
  schemas and `pg_trgm`/`citext`). Run them through the **session pooler** (port 5432 on the pooler
  host, IPv4): the migrator holds a session advisory lock. The direct connection is IPv6-only on free.
- App roles get logins with the existing `bootstrapRoleLogins` (`APP_/READER_/WORKER_DB_PASSWORD`).
- The API connects through the **transaction pooler** (port 6543): RLS principals are set per
  transaction (`set_config(…, true)`) and no named prepared statements are used. Pooler usernames are
  `joybot_app.<project-ref>`, set through the existing `APP_DATABASE_URL`, `READER_DATABASE_URL`,
  `WORKER_DATABASE_URL`.
- **`public.schema_migrations` is locked down** by `migrate.ts` on every run (RLS on, grants revoked from
  `PUBLIC` and Supabase's `anon`/`authenticated`/`service_role`): Supabase grants new `public` tables to
  `anon`. Also turn off the Data API (Project settings); JoyBot never uses PostgREST.
- Supabase's CA is committed as `deploy/supabase/prod-ca-2021.crt` (public root, expires 2031).
- Each `migrate` run sets the role passwords again; the pooler caches credentials and refuses those
  roles for ~20 s afterwards. The deploy workflow should set passwords only when they change.
- Done 2026-10-13 on project `…bkot` (us-east-2, Ohio; Render's region is `ohio` to match): 43
  migrations, settings seeded (no sample data), role logins and RLS checked through the pooler.
- **TLS:** `DB_SSL=true` verifies the server. AWS images trust the RDS bundle (`NODE_EXTRA_CA_CERTS`);
  other hosts pass their CA as `DB_SSL_CA` (PEM text) or `DB_SSL_CA_FILE` — Supabase's from Database
  settings › SSL. Shared by the API, worker and migrations (`sslFromEnv` in `packages/db`). Database URLs
  must not carry `sslmode`, which would override it.
- **Backups** (none on free): a scheduled GitHub Action running `pg_dump` to a private place.
- Verify first: run every migration and the seed against a free project (or `supabase start`, which
  has the same non-superuser `postgres`).

### 2. CORS (`CORS_ORIGINS`) ✅
- `enableCors` in `apps/api/src/setup.ts` only when `CORS_ORIGINS` is set (e.g.
  `https://appjoy.dev,https://www.appjoy.dev`): those origins, no credentials (tokens are bearer
  headers), `maxAge` to cache preflights. Unset in AWS (same origin through CloudFront).

### 3. Supabase Auth with Google (`AUTH_MODE=supabase`) ✅
- **Sign-in is Google only** (email codes were dropped to keep it simple). Supabase's Google provider is
  on (client ID and secret entered in the dashboard; the app never needs them); email sign-in is off.
  Staff use the Google account of their work email; customers any Google account.
- **API** (`apps/api/src/auth/supabase.ts`, `auth.guard.ts`): checks Supabase access tokens with `jose`
  against the project's public keys (`/auth/v1/.well-known/jwks.json`, ES256 on this project;
  `SUPABASE_JWT_SECRET` only for legacy shared-secret projects). One user pool for both areas: the web
  app sends `x-joybot-audience: employee` from the staff console (customer otherwise). Roles still come
  from the database.
- **Linking on first use** (what Cognito's Lambdas do), with the same SQL and the same role: the API
  calls the linking functions **as `joybot_worker`** through a small separate pool
  (`SupabaseLoginLinker`, `WORKER_DATABASE_URL`), because the API's own role may not (a db test keeps it
  that way). Staff by Google's verified email matching an active employee
  (`authz.link_employee_login`); customers by verified email (`authz.link_customer_signup`: link to an
  existing customer, create one, or staff review → 403 `account_in_review`, queued once). Parallel first
  requests link once; changes are audited with `via = 'supabase'`. The login id is kept in `cognito_sub`.
- **Staff accounts:** adding an employee emails them (JoyBot's `invite` email, through Resend; best
  effort) to sign in with Google at `/staff` using that address; there is no login to create.
  Deactivating bans their login (JoyBot already refuses inactive employees); re-activating lifts the ban.
  Uses the admin API with `SUPABASE_SERVICE_ROLE_KEY` (server only): a secret key (`sb_secret_…`) is
  sent only as `apikey`, a legacy `service_role` JWT also as the bearer.
- **Web** (`lib/auth.tsx`, `components/SignIn.tsx`): `@supabase/supabase-js`, a client per area with
  its own stored session; "Continue with Google" returns to the same page, which picks the session up
  from the URL. Why the API refused a login is shown on the sign-in screen. `config.json`:
  `authMode: "supabase"` plus `supabase: { url, anonKey }` (a publishable key; public by design).
- **Dashboard settings:** Google provider ✅ (checked: only external provider enabled, ES256 signing
  keys, sign-ups allowed). Still to confirm: Authentication › URL Configuration › Site URL
  `https://appjoy.dev` and redirect URLs `https://appjoy.dev/**`, `http://localhost:5173/**`; the Google
  OAuth client's authorized redirect URI `https://tknchixzrnycvzufbkot.supabase.co/auth/v1/callback`.
- Customers without a Google account (phone-only) can't sign in yet; phone or email codes can come back
  later as a second option.

### 4. All email through Resend (`MESSAGING_MODE=resend`) ✅
- Every email goes through Resend (Admin › Email), including `contact_code` verification codes, which
  otherwise use the default sender (SES). Before Admin › Email is set up, sends fail with a message
  saying so; WhatsApp is refused ("not available on this server") until a non-AWS sender exists.

### 5. Worker next to the API ✅
- `deploy/render/Dockerfile` builds both apps; `start.mjs` runs them side by side, forwards signals, and
  stops both (exit code kept) when either exits, so Render restarts the service.
- When Render wakes the service (a visitor, or a Stripe webhook), the worker starts too: stored events
  are applied within seconds, and the reconcile runs on start when due. A daily `pg_cron` + `pg_net`
  request to `/api/health` (both on Supabase free) can wake it for the nightly reconcile.
- **Stripe keys from the environment** already work: `STRIPE_WEBHOOK_SECRET`, `STRIPE_CHECKOUT_KEY`
  (API) and `STRIPE_RESTRICTED_KEY` (worker).

### 6. Admin › AI (OpenRouter or own deployment)
- `core.ai_settings` (provider `openrouter` | `custom`, base URL, model) and `core.ai_secret` (API key,
  SecretBox, last four shown), like Admin › Email. `OpenAiCompatibleProvider` reads them (cached ~30 s);
  `MODEL_ENDPOINT`/`MODEL_NAME` stay the default when nothing is saved.
- OpenRouter: base `https://openrouter.ai/api/v1`, a Gemma model id from its catalogue (confirm Gemma 4
  E2B is listed), and its provider routing option to exclude providers that collect data. Chat sends
  customer record text: use a paid, no-logging provider for real data.
- A Test button (one short prompt), and run the chat eval (`eval:model`) against the chosen provider.

### 7. Website images on R2 (`SITE_ASSET_STORE=s3`)
- An S3-compatible store (`@aws-sdk/client-s3`; `S3_ENDPOINT`, `S3_BUCKET`, keys,
  `SITE_ASSET_BASE_URL=https://cdn.appjoy.dev`). Uploads still go through the API (signature check, no
  SVG), then `PutObject` with key `site/<uuid>`, the right `Content-Type` and
  `Cache-Control: public, max-age=31536000, immutable`. The same code can later target S3 in AWS.
- `core.site_assets.storage` (`db` | `s3`): `/api/site/assets/:id` streams `db` images as today and
  redirects `s3` ones to the CDN, so existing pages keep working.
- Delete removes the object and purges the CDN URL (Cloudflare API token, optional).
- A one-off script copies `core.site_asset_data` to the bucket; a cleanup job removes objects with no row.
- Cloudflare: custom domain on the bucket (never `r2.dev`), a rule adding `X-Content-Type-Options:
  nosniff`, optional hotlink protection. Back up the bucket separately (`pg_dump` no longer has images).
- Record the exception in CLAUDE.md › Product constraints.

### 8. Hosting and deploy ✅ (live 2026-10-13)
- **Migrations and role passwords:** `ROLE_PASSWORDS_ONCE=true` makes `migrate` set a role's password only
  while the role cannot log in yet (Supabase's pooler refuses a role for ~20 s after its password is set
  again, even to the same value). Rotate by running once without it. AWS's bootstrap is unchanged.
- **GitHub Action** `.github/workflows/deploy-free.yml` (separate from AWS's `release.yml`): on pushes to
  `main` that touch the API, worker, packages or deploy files, migrates Supabase (session pooler, CA from
  `deploy/supabase`, `ROLE_PASSWORDS_ONCE`), then calls Render's deploy hook. Off until the repository
  variable `FREE_DEPLOY` is `true`. Secrets: `SUPABASE_MIGRATOR_URL`, `APP_DB_PASSWORD`,
  `READER_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `RENDER_DEPLOY_HOOK_URL`.
- **Render** (`render.yaml`; service `joybot-api` was created through Render's API with the same settings): one free web service from `deploy/render/Dockerfile` (API +
  worker), Ohio, health check `/api/health`, custom domain `api.appjoy.dev`, `autoDeploy: false` (the
  Action deploys after migrating). Fixed values in the file; enter in the dashboard: `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, the three `*_DATABASE_URL`s (transaction pooler, 6543), `DB_SSL_CA` (the
  PEM text of `deploy/supabase/prod-ca-2021.crt`), Stripe keys, `MODEL_ENDPOINT`/`MODEL_NAME`. Copy the
  service's **Deploy Hook** URL into the GitHub secret. The first visit after 15 idle minutes waits for
  the service to wake (~1 min).
- **Cloudflare Pages** (Workers & Pages › Create › Pages › Connect to Git):
  - Production branch `main`; root directory empty (repo root); output `apps/web/dist`.
  - Build command: `pnpm --filter "@joybot/web..." build && node apps/web/scripts/write-config.mjs`. Pages
    installs pnpm (from `packageManager`) and runs `pnpm install` itself; `...` builds `@joybot/access` first.
  - Variables: `NODE_VERSION=22`, `WEB_API_BASE=https://api.appjoy.dev/api`, `SUPABASE_URL`,
    `SUPABASE_PUBLISHABLE_KEY` (public), `APP_URL=https://appjoy.dev`.
  - `write-config.mjs` writes `dist/config.json` and fails the build if a value is missing, so the local
    development config (dev sign-in) is never shipped. SPA routes work without extra config.
  - Project `joybot-web`, custom domain `appjoy.dev` (replaced Firebase Hosting).
- **Google sign-in** URLs: Supabase › URL Configuration has `https://appjoy.dev/**`; the Google OAuth
  client redirects to `https://tknchixzrnycvzufbkot.supabase.co/auth/v1/callback` (both checked).
- **Google Meet** (Setup meeting links): redirect URI becomes
  `https://api.appjoy.dev/api/website/video/google/callback`. **Stripe** webhook URL
  `https://api.appjoy.dev/api/webhooks/stripe`.

## Order

1 (prove the database) → 2 → 3 (biggest: sign-in) → 4 → 5 → 6 → 7 → 8. Items 2, 4, 6 and 7 are also
useful on AWS and can merge independently.

## Limits to accept on free plans

- Supabase free projects pause after a week without activity, have no backups, and 500 MB of data.
- Render's free service sleeps; the public site loads its content from the API, so the first visitor
  after a quiet spell waits. Upgrading only the API (Render Starter) removes this.
- Resend free: 100 emails/day.
- No SLA anywhere; fine to launch and learn, upgrade the piece that hurts first.

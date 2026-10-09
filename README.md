# JoyBot AI

Customer + employee chatbot backed by JoyBot's own PostgreSQL source of truth. See [plan.md](plan.md) for the full design.

## What's implemented (Phase 1 slice)

| Area | Where |
|---|---|
| Database schema: settings, locations, employees, organizations, customers, services, appointments, payments (Stripe + manual) | [packages/db/migrations](packages/db/migrations) |
| Access control for records and organizations: roles (admin, staff, org_admin, customer), scopes, assignments, restricted records, record grants — enforced by **Postgres RLS** | [0003_access_control.sql](packages/db/migrations/0003_access_control.sql), [0004_rls_policies.sql](packages/db/migrations/0004_rls_policies.sql) |
| Audit log of every change (who, via what) | [0005_audit.sql](packages/db/migrations/0005_audit.sql) |
| Shared ability builder (CASL) | [packages/access](packages/access) |
| NestJS API: auth (Cognito or local dev header), `@Can` permission guard, settings, customers, **manual payments** (validation, cross-source duplicate detection, same-day edit rule, admin void/refund, pending bank transfers) | [apps/api](apps/api) |
| Back-office API: locations, services (price list), organizations (members), appointments (service defaults, employee double-booking check, status transitions, local times) | [apps/api/src](apps/api/src) |
| Employee sign-in accounts: creating, deactivating, reactivating and re-roling employees keeps the Cognito employees pool in step (rolled back if Cognito fails) | [employee-logins.ts](apps/api/src/admin/employee-logins.ts) |
| Access administration API: employees + work locations, staff permission matrix (with guard-rails), assignments, temporary record grants (≤ 90 days), "who can access" with reasons | [apps/api/src/admin](apps/api/src/admin), [0010_access_reasons.sql](packages/db/migrations/0010_access_reasons.sql) |

| Cognito identity linking rules (customer sign-up by verified email/phone, employee first sign-in) | [0012_identity_linking.sql](packages/db/migrations/0012_identity_linking.sql) |
| CloudFormation: network, data (Aurora + DB bootstrap), messaging (WhatsApp codes), auth (two user pools), compute (ECS on EC2, Graviton + GPU), model (vLLM + Gemma 4), backend (internal ALB + API), frontend (CloudFront + VPC origin, WAF), observability; private artifacts bootstrap; publish + Quick-Create scripts | [cloudformation](cloudformation) |
| Container images: API (non-root, verified TLS to Aurora) and model server (vLLM with S3 weights cache) | [apps/api/Dockerfile](apps/api/Dockerfile), [services/model-server](services/model-server) |
| Lambda functions: DB bootstrap, customer post-confirmation, employee post-authentication, WhatsApp sender, web assets | [cloudformation/functions](cloudformation/functions) |

| Chat: conversations API with streamed answers (SSE), scope resolution within access, server-side dates, intent rules + Gemma 4 tool calling over 14 read-only tools, citations, audit traces | [apps/api/src/chat](apps/api/src/chat) |
| Stripe sync: signed webhook → event store; worker applies events (matching, ordering, refunds, disputes, duplicates), nightly + on-demand reconciliation, unmatched-payment assignment, admin status | [apps/api/src/stripe](apps/api/src/stripe), [apps/worker](apps/worker) |

| Web app: customer portal (assistant, appointments, payments, services, locations, profile) and staff console (assistant with customer context and disambiguation, customers + who-can-access, payments: record / pending transfers / unmatched Stripe, admin: settings, Stripe sync, employees); Cognito sign-in or local dev picker | [apps/web](apps/web) |

| Freshdesk tickets: contacts matched by verified email/phone (phone format variants), ownership filter, private notes for staff only, rate-limit retries + circuit breaker, chat tools; portal and staff ticket pages; org admin area | [apps/api/src/freshdesk](apps/api/src/freshdesk), [TicketPages.tsx](apps/web/src/routes/portal/TicketPages.tsx) |

| Profile self-service and invites: edit profile, add/change email or phone with one-time codes (email or WhatsApp), Cognito login kept in step; staff invites by email/WhatsApp (opt-in), org admins add/remove members; single-use hashed invite links; accepting with a different account goes to review | [apps/api/src/profile](apps/api/src/profile), [ProfilePages.tsx](apps/web/src/routes/portal/ProfilePages.tsx) |

Not yet: duplicate merge and link-review screens, access-admin screens for assignments and grants, evaluation set (see roadmap in plan.md §11).

Messages locally: with `AUTH_MODE=dev`, email/WhatsApp messages are not sent — codes and invite links are printed in the API log.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every pull request: typecheck, all tests
against a Postgres service, CloudFormation lint + nested-parameter check, Lambda build and an API image
build. [release.yml](.github/workflows/release.yml) publishes a release when a `v*.*.*` tag is pushed
(see [cloudformation/README.md](cloudformation/README.md)).

## Local development

Requires Node 22+, pnpm (`npm install -g pnpm`) and Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:up           # Postgres 16 on localhost:5433
pnpm db:reset        # migrate + role logins + settings + sample data
pnpm test            # access, DB access-control and API tests
pnpm dev:api         # http://localhost:3000/api
pnpm dev:worker      # Stripe event processing + reconciliation
pnpm dev:web         # http://localhost:5173 (proxies /api to the API)
```

Freshdesk locally: `node tools/fake-freshdesk.mjs`, set `FRESHDESK_BASE_URL=http://localhost:4010` and
`FRESHDESK_API_KEY=local` in `.env`, and any Freshdesk domain in Admin → Settings.

Stripe locally: set `STRIPE_WEBHOOK_SECRET` from `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
and enable Stripe in Admin → Settings. Chat uses evidence-only answers unless `MODEL_ENDPOINT` points at
an OpenAI-compatible model (e.g. Ollama: `http://localhost:11434/v1` with `MODEL_NAME` set to the local Gemma tag).

Local auth uses the `x-dev-principal` header (`AUTH_MODE=dev`, refused when `NODE_ENV=production`):

```bash
# Sam (staff, NYC) searching customers — only sees customers in his scope
curl -H 'x-dev-principal: employee:20000000-0000-4000-8000-000000000002' 'localhost:3000/api/customers?q=maria'
```

Sample principals (IDs in [packages/db/src/seed.ts](packages/db/src/seed.ts)):

| Who | Role | Notes |
|---|---|---|
| Ada `employee:2…01` | admin | Everything, incl. restricted records |
| Sam `employee:2…02` | staff, NYC | NYC customers + read grant on Pat |
| Lia `employee:2…03` | staff, LA | LA customers + assigned to restricted VIP org |
| Maria `customer:4…01` | customer | Self only |
| John `customer:4…02` | org_admin (Acme) | Members + their appointments; own payments only |

## Database roles

| Role | Used by | RLS |
|---|---|---|
| `joybot_migrator` | migrations (owner) | bypasses (owner) |
| `joybot_app` | API back-office | enforced |
| `joybot_reader` | chat retrieval (read-only) | enforced |
| `joybot_worker` | worker, Stripe sync, Cognito triggers | system access |

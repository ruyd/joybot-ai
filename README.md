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
| Access administration API: employees + work locations, staff permission matrix (with guard-rails), assignments, temporary record grants (≤ 90 days), "who can access" with reasons | [apps/api/src/admin](apps/api/src/admin), [0010_access_reasons.sql](packages/db/migrations/0010_access_reasons.sql) |

| Cognito identity linking rules (customer sign-up by verified email/phone, employee first sign-in) | [0012_identity_linking.sql](packages/db/migrations/0012_identity_linking.sql) |
| CloudFormation (Phase 1): network, data (Aurora + DB bootstrap), messaging (WhatsApp codes), auth (two user pools); private artifacts bootstrap; publish + Quick-Create scripts | [cloudformation](cloudformation) |
| Lambda functions: DB bootstrap, customer post-confirmation, employee post-authentication, WhatsApp sender | [cloudformation/functions](cloudformation/functions) |

Not yet: chat/LLM, Stripe webhooks, Freshdesk, frontend, compute/model/backend/frontend stacks (see roadmap in plan.md §11).

## Local development

Requires Node 22+, pnpm (`npm install -g pnpm`) and Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:up           # Postgres 16 on localhost:5433
pnpm db:reset        # migrate + role logins + settings + sample data
pnpm test            # access, DB access-control and API tests
pnpm dev:api         # http://localhost:3000/api
```

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

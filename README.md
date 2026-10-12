# JoyBot AI

A chatbot for customers and employees, backed by JoyBot's own PostgreSQL database as the source of truth and a self-hosted Gemma 4 model. It deploys to AWS (us-east-1) with private CloudFormation Quick-Create links.

- [plan.md](plan.md) is the full design, with the roadmap and next steps in §11.
- [CLAUDE.md](CLAUDE.md) covers conventions and gotchas for working on the code.

## What's implemented

Phases 1–3 are done; see [plan.md §11](plan.md#11-phased-roadmap) for the remaining work.

| Area | What | Where |
|---|---|---|
| Database | Settings, locations, employees, organizations, customers, services, appointments and payments (Stripe and manual). Forward-only SQL migrations | [packages/db/migrations](packages/db/migrations) |
| Access control | Roles: admin, staff, org_admin, customer. Also scopes, assignments, restricted records, expiring record grants (90 days at most) and "who can access" with reasons. Enforced by **Postgres RLS**, with CASL rules shared with the API and web app | [0003](packages/db/migrations/0003_access_control.sql), [0004](packages/db/migrations/0004_rls_policies.sql), [0010](packages/db/migrations/0010_access_reasons.sql), [packages/access](packages/access) |
| Audit | Every change is logged with who made it and through which channel | [0005_audit.sql](packages/db/migrations/0005_audit.sql) |
| API | NestJS. Auth through Cognito JWTs or a local dev header, plus `@Can` guards. Endpoints for settings, locations, services, organizations, customers and appointments (local times, double-booking check) | [apps/api](apps/api) |
| Manual payments | POS, bank transfer and cash. Covers validation, duplicate detection across manual and Stripe, a same-day edit rule, admin-only void and refund, and pending transfers | [apps/api/src/payments](apps/api/src/payments) |
| Access admin | Employees with work locations, the staff permission matrix, assignments, temporary access (grants), restricted flags and "who can access", in the API and on the staff Access page and customer pages. Employee changes stay in sync with the Cognito employees pool | [apps/api/src/admin](apps/api/src/admin) |
| Identity linking | Customers sign up with a verified email or phone and are linked to existing records. Employees are linked on first sign-in | [0012_identity_linking.sql](packages/db/migrations/0012_identity_linking.sql) |
| Chat | Answers stream over SSE. Covers scope resolution within access, server-side dates, intent rules, Gemma 4 tool calling over 16 read-only tools, citations and retrieval traces. When no model is configured, answers use the evidence only | [apps/api/src/chat](apps/api/src/chat) |
| Stripe | Signed webhooks go to an event store. The worker applies them (matching, ordering, refunds, disputes, duplicates) and reconciles nightly or on demand. Includes the unmatched-payment queue | [apps/api/src/stripe](apps/api/src/stripe), [apps/worker](apps/worker) |
| Freshdesk | Contacts are matched by verified email or phone (with phone format variants). Includes the ownership filter, private notes for staff only, retries, a circuit breaker and chat tools | [apps/api/src/freshdesk](apps/api/src/freshdesk) |
| Profiles & invites | Profile editing and email/phone changes confirmed with one-time codes (email or WhatsApp). Staff invite customers and org admins add or remove members, using single-use hashed links. Accepting an invite from a different account goes to review | [apps/api/src/profile](apps/api/src/profile) |
| Link review & merge | Sign-ups that conflict with existing records and invites accepted by another account wait in a review queue: link the login, merge, or reject. Likely duplicates can be merged or dismissed. A merge moves appointments, payments, the login and chats, and leaves a hidden tombstone. Admin only | [merge.controller.ts](apps/api/src/customers/merge.controller.ts), [0016](packages/db/migrations/0016_link_review_merge.sql), [ReviewPages.tsx](apps/web/src/routes/staff/ReviewPages.tsx) |
| Website | The business's public site at `/`: pages built from modules (hero, cards with icons, columns, FAQ, call to action, HTML, image, YouTube/Vimeo video), each with an optional anchor (`/#services`), background, label, heading and intro; pages shown in the header and/or footer. **Site setup** sets the accent colors, heading and body fonts (bundled, nothing loaded from third parties), logo, tagline, extra header links, a header button and whether the customer login shows. Edited under **Marketing › Website**, or through Claude (MCP). Standard pages (home, about us, contact us, privacy policy, terms) come preloaded. HTML is sanitized on save and on display; images are uploaded into Postgres and served by the API | [0029_website.sql](packages/db/migrations/0029_website.sql), [0030_website_theme.sql](packages/db/migrations/0030_website_theme.sql), [apps/api/src/website](apps/api/src/website), [WebsitePages.tsx](apps/web/src/routes/staff/WebsitePages.tsx) |
| Web app | Customer portal: assistant, appointments, payments, tickets, organization, profile. Staff console: assistant, customers, payments worklists, admin. Sign-in through Cognito, or a dev picker locally | [apps/web](apps/web) |
| Evaluation | 110 chat cases on the sample data: customers, org admins, staff, time zones, partial profiles, access and prompt injection. An independent access oracle checks every answer and the evidence behind it, and any leak fails CI. A real-model mode compares Gemma runs | [apps/api/eval](apps/api/eval) |
| Infrastructure | CloudFormation: network, data, messaging, auth, compute (ECS on EC2: Graviton and GPU), model (vLLM serving Gemma 4 E2B), backend, frontend (CloudFront, VPC origin, WAF) and observability. Also a private artifacts bootstrap, Lambdas, and publish and Quick-Create scripts | [cloudformation](cloudformation) |
| CI | Every PR runs typecheck, tests against Postgres, cfn-lint, the nested-parameter check, a Lambda build and image builds. Pushing a `v*.*.*` tag publishes a private release | [.github/workflows](.github/workflows) |

**Not yet:**
- An eval run against Gemma 4 served by vLLM in AWS (local Gemma 4 E2B on Ollama passes 117/118).
- Phase 6: an MCP server so a business's admins can use Claude on their own data. Then Phase 7 pre-launch: hardening, Playwright, load tests.
- A first real AWS deployment.

## Local development

Requirements: Node 22+, pnpm (`npm install -g pnpm`) and Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:up           # Postgres 16 on localhost:5433
pnpm db:reset        # migrate + role logins + settings + sample data
pnpm test            # all packages (each API test file resets the DB), incl. the eval in evidence-only mode
pnpm --filter @joybot/api eval        # eval only; report in apps/api/eval/reports/
pnpm typecheck
pnpm lint:cfn        # needs cfn-lint (pip install cfn-lint)
pnpm dev             # everything at once (Ctrl-C stops all): Postgres, API, worker, web, Freshdesk stub, Ollama
pnpm dev:api         # or one at a time: http://localhost:3000/api
pnpm dev:worker      # Stripe event processing + reconciliation
pnpm dev:web         # http://localhost:5173 (proxies /api to the API; waits up to 60 s for it to answer)
pnpm dev:freshdesk   # Freshdesk stub on http://localhost:4010
pnpm dev:model       # Ollama in the foreground (quits the Ollama app first)
```

- **Messages:** with `AUTH_MODE=dev`, emails and WhatsApp messages aren't sent. Codes and invite links are printed in the API log.
- **Freshdesk:** the stub runs with `pnpm dev` (or `pnpm dev:freshdesk`). Set `FRESHDESK_BASE_URL=http://localhost:4010` and `FRESHDESK_API_KEY=local` in `.env`. Set any Freshdesk domain in Admin → Settings.
- **Stripe:** take `STRIPE_WEBHOOK_SECRET` from `stripe listen --forward-to localhost:3000/api/webhooks/stripe`, then enable Stripe in Admin → Settings.
- **Eval with a model:** `MODEL_ENDPOINT=http://localhost:11434/v1 MODEL_NAME=<gemma tag> pnpm --filter @joybot/api eval:model`. Set `EVAL_FILTER=<id or category prefix>` to run a subset.
- **Model:** install Ollama natively (`brew install ollama`; Docker on macOS has no GPU), run `ollama pull gemma4:e2b` (7.5 GB), and set `MODEL_ENDPOINT=http://localhost:11434/v1` and `MODEL_NAME=gemma4:e2b` in `.env`. `pnpm dev` runs Ollama in its console at its normal log level (`OLLAMA_DEBUG=1` or `2` for more); it quits the Ollama menu-bar app first, since both use port 11434. Set `MODEL_DEBUG=true` to have the API console log each model call in full: the system prompt with the records, history, question and tools, then the tool calls, reasoning and answer (only with `AUTH_MODE=dev`, since prompts contain customer data). Gemma thinks only when picking tools, which happens only when the intent rules miss (`MODEL_THINKING=all` also thinks before answers, several times slower; `off` never); the model stays loaded between questions (`OLLAMA_KEEP_ALIVE=-1`) and the API loads it at startup. Without `MODEL_ENDPOINT`, chat lists the records it found instead of writing an answer.

Local auth uses the `x-dev-principal` header (`AUTH_MODE=dev`, refused when `NODE_ENV=production`):

```bash
# Sam (staff, NYC) searching customers — only sees customers in their scope
curl -H 'x-dev-principal: employee:20000000-0000-4000-8000-000000000002' 'localhost:3000/api/customers?q=maria'
```

Sample principals (IDs are in [packages/db/src/seed.ts](packages/db/src/seed.ts)):

| Who | Role | Notes |
|---|---|---|
| Ada `employee:2…01` | admin | Everything, including restricted records |
| Sam `employee:2…02` | staff, NYC | NYC customers, plus a read grant on Pat |
| Lia `employee:2…03` | staff, LA | LA customers, plus an assignment to the restricted VIP org |
| Maria `customer:4…01` | customer | Self only |
| John `customer:4…02` | org_admin (Acme) | Members and their appointments and tickets; own payments only |
| Jane `customer:4…03` | customer (Acme member) | Self only |
| Victor `customer:4…04` | customer (VIP member) | VIP is a restricted org |
| Rita `customer:4…05` | customer | Restricted record |
| Pat `customer:4…06` | customer, LA | Phone only (no email) |

## Claude access (MCP)

Admins can let Claude read, and optionally change, their business's data through a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/api/mcp` (Streamable HTTP, stateless).

1. **Admin › Claude access** → create a token (7 days to 1 year, **read only** or **read and write**). It is shown once; only its hash is stored.
2. Connect Claude, using the commands the page shows:
   - **Claude Code:** `claude mcp add --transport http joybot https://<your app>/api/mcp --header "Authorization: Bearer jbt_…"`
   - **Claude Desktop:** an `mcp-remote` entry in `claude_desktop_config.json`.
3. Ask, for example, "who has overdue invoices?" or "what's on Sam's calendar this week?".

Read tools (every token): `whoami`, `find_customers`, `get_customer`, `list_appointments`, `get_calendar`, `list_payments`, `list_pending_bank_transfers`, `list_invoices`, `list_todos`, `get_staff_schedule`, `search_knowledge`, `get_business_info`, `list_site_pages`, `get_site_page`, `get_site_setup`.

Write tools (read-and-write tokens): `book_appointment`, `reschedule_appointment`, `create_todo`, `set_todo_done`, `add_time_off`, `create_invoice_draft`; for the website `create_site_page`, `update_site_page`, `set_site_module`, `remove_site_module`, `update_site_setup`, `upload_site_image` (base64, up to 5 MB); and, after a confirmation, `cancel_appointment`, `send_invoice`, `void_invoice`, `record_payment`, `delete_site_page`. Those five first return a preview and a confirmation id (single use, ten minutes, tied to the token and the exact arguments); only a second call with it acts, so Claude shows you the preview first. Writes go through the same services as the app (double-booking and working-hours checks, invoice rules, duplicate-payment checks) and appear under **Changes through Claude** on the Claude access page and in **Admin › Audit log** (`GET /api/admin/audit?via=mcp`).

Every tool runs as the admin who made the token, under the same row-level security as the app. A token stops working when it expires, is revoked (any admin can revoke any token) or its owner is no longer an active admin. Requests are limited per token (`MCP_RATE_LIMIT_PER_MINUTE`, 120 by default). OAuth sign-in (for claude.ai connectors) is the next step of Phase 6.

## Database roles

| Role | Used by | RLS |
|---|---|---|
| `joybot_migrator` | migrations (owner) | bypasses (owner) |
| `joybot_app` | API back-office | enforced |
| `joybot_reader` | chat retrieval (read-only) | enforced |
| `joybot_worker` | worker, Stripe sync, Cognito triggers | system access |

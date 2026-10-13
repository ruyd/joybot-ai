# CLAUDE.md

JoyBot AI is a chatbot for customers and employees. Its own Postgres database is the source of truth, and it uses Gemma 4 for chat. The design is in [plan.md](plan.md), with the roadmap and next steps in §11. Setup is in [README.md](README.md).

## Commands

```bash
pnpm db:up && pnpm db:reset   # Postgres 16 on :5433 (docker compose), migrate + seed
pnpm test                     # all packages, one after another, each on its own test databases (never the dev database in .env)
pnpm typecheck                # builds packages/* first, then tsc everywhere
pnpm lint:cfn                 # cfn-lint + cloudformation/scripts/check_nested.py
pnpm dev                      # db:up + package build + every dev:* script in parallel (api, worker, web, ollama)
pnpm dev:api | dev:worker | dev:web | dev:model
pnpm --filter @joybot/api exec vitest run test/profile.test.ts   # one file
pnpm --filter @joybot/api eval        # chat eval (evidence-only); eval:model uses MODEL_ENDPOINT
```

- Preview servers are in `.claude/launch.json`: api on 3000 and web on 5173.
- The local `.env` is git-ignored. Copy it from `.env.example`.
- The tool versions are pnpm 12, Node 22+, TypeScript 5.9, Vitest 3, NestJS 11, React 19, Vite 7 and Tailwind 4.

## Layout

| Path | What |
|---|---|
| `packages/db` | SQL migrations `migrations/NNNN_*.sql` (forward-only, run by `src/migrate.ts`), `src/scope.ts` (`withPrincipal`/`withSystem`), `src/seed.ts` (`SAMPLE` ids) |
| `packages/access` | CASL `buildAccess` / `packRules`, shared by the API and web app |
| `apps/api` | NestJS: one folder per feature (`chat/`, `payments/`, `stripe/`, `tickets/`, `profile/`, `admin/`, …), plus `auth/` guards and `config/config.ts` (Zod) |
| `apps/worker` | Poll loop: Stripe events (`app.stripe_events`), reconciliation, `app.worker_jobs` |
| `apps/web` | Portal (`routes/portal`), staff console (`routes/staff`), `lib/` (auth, api, sse, chat-state, ability) |
| `cloudformation` | `main.yaml`, plus nested `stacks/`, Lambda `functions/` (its own pnpm package), `scripts/` and `bootstrap/artifacts.yaml` |
| `services/model-server` | vLLM image for `google/gemma-4-E2B-it` |

## Conventions

### Database and access
- **Every query runs as a principal.** In the API, use `DbService.as(principal, fn)` (or `read` for chat). It sets `app.principal_type`/`app.principal_id`/`app.via` in a transaction, and RLS does the rest. Use `withSystem` only for worker or trigger paths.
- **Access rules live in SQL.** They are the `authz.*` SECURITY DEFINER functions plus RLS policies. The API adds coarse checks with `@Can(action, resource)`, `@EmployeesOnly` and `@CustomersOnly`. The role always comes from the database (`authz.principal_role()`) and never from the token. When adding a resource, add the RLS policies, the `role_permissions` rows and the CASL mapping together.
- **Appointment types** (`core.appointment_types`, edited from the calendar's Appointment types dialog by whoever may edit services): every appointment has one (default `service`) and the calendar draws its color. System types (`sales_call`) are read-only (trigger) and only the app creates their appointments; every other type needs a customer, service and location (trigger `core.appointment_type_rules`). Appointment queries must `LEFT JOIN` services and locations.
- **Merged customers** become tombstones (`status = 'merged'`, `merged_into`), hidden by the customers SELECT policies. New code that looks customers up by number or Stripe id outside RLS should follow `merged_into`, as `core.match_stripe_customer` does.
- **Migrations are forward-only.** Add the next numbered file and never edit an applied one. RLS is enabled but not forced, so the owner (`joybot_migrator`) bypasses it.
- **Postgres roles:**
  - `joybot_app` is the API, with RLS enforced.
  - `joybot_reader` is chat, SELECT only.
  - `joybot_worker` has system access through the `worker_all` policies.

### API and web
- **No ORM.** Use `pg` with hand-written SQL.
- **Validation:** request bodies use Zod through `ZodPipe` with `.strict()` schemas.
- **Errors:** Postgres errors map to HTTP in `AppExceptionFilter`. For example, 42501 becomes 403, 23505 becomes 409 and 23514 becomes 400.
- **Dates:** `DATE` columns come back as `YYYY-MM-DD` strings (a type parser in `db.module.ts`). The web app parses them as local dates. Times are `timestamptz` and are shown in the location, person or settings time zone.
- **Config:** empty environment strings mean unset, because CloudFormation passes `''` for optional values.
- **Chat:**
  - The model never supplies IDs. Tools take the IDs that were already resolved and are allowed.
  - Record text goes into the prompt as delimited data.
  - Every lookup is written to `app.retrieval_traces`.
  - Saved answers and article passages (`knowledge/`) are searched for every question and cited like records. Buttons (book, read an article) come only from them, never from the model.
- **Secrets and contact codes:** store only hashes (sha256) of tokens and codes, mask contacts in responses, and never log codes.
- **Third-party keys the app must use** (the Resend API key) are encrypted with `SecretBox` (AES-256-GCM, `SETTINGS_ENCRYPTION_KEY`; AWS generates it) in a table without grants or audit (`core.email_secret`), reached only through SECURITY DEFINER functions, and never returned to the browser (show the last four characters).
- **Video calls (`apps/api/src/video/`):** Sales calls › Setup meeting links connects a Google account by OAuth with only the non-sensitive scope `calendar.app.created` (no Google verification; JoyBot makes its own "<site> sales calls" calendar there, `google_calendar_id`, remade if deleted, and can't see other calendars; client ID in `core.video_settings`; client secret and refresh token encrypted in `core.video_secret`; single-use state in `app.oauth_states`; callback `GET /api/website/video/google/callback` is public and uses `API_PUBLIC_URL` or the request origin as the redirect URI). While an account is connected (no separate switch; disconnecting stops it), `SalesCallsService` creates, moves and deletes an event with a Meet link in that calendar per sales call (`appointments.meeting_url`, `calendar_event_id`), best effort; that is the only meeting link emails use (the booking page's fixed link was dropped). `GOOGLE_HTTP` is injectable for tests.
- **Email (`apps/api/src/email/`):** Admin › Email (`settings` update) stores Resend's key and the sender in `core.email_settings`; `MessagingService.send` routes app email (`RESEND_TEMPLATES`: invite, invoice, ticket, sales_call) through Resend once a key and a from address are saved (no on/off switch; `EmailService.delivery()`, cached 30 s), else through `MESSAGE_SENDER`; sign-in and verification codes (`contact_code`) belong to the auth provider and never go through Resend.
- **Supabase Auth (`AUTH_MODE=supabase`, `apps/api/src/auth/supabase.ts`; free-tier deploy, [docs/deploy-free.md](docs/deploy-free.md)):** one user pool for staff and customers; the web app sends `x-joybot-audience: employee` from the staff console. A login seen for the first time is linked with the Cognito triggers' SQL (`authz.link_employee_login` / `link_customer_signup`), run as `joybot_worker` through `SupabaseLoginLinker`: the API's role must never get those functions. Other free-tier options: `CORS_ORIGINS`, `MESSAGING_MODE=resend` (all email through Resend), `DB_SSL_CA[_FILE]`; `deploy/render` runs the API and worker in one container.
- **External services:**
  - Clients are injectable tokens (`JWT_VERIFIERS`, `SUPABASE_TOKENS`, `SUPABASE_HTTP`, `EMPLOYEE_LOGINS`, `CUSTOMER_LOGINS`, `LLM_PROVIDER`, `MESSAGE_SENDER`, `RESEND_HTTP`), so tests can override them.
  - In dev, messages are logged rather than sent.
- **MCP (`apps/api/src/mcp/`):** `POST /api/mcp`, authenticated by an admin's personal access token (`app.api_tokens`, sha256 only), not the app's sign-in. Tools run as that admin through the existing services or SQL under RLS; never add a raw-SQL tool. Queries made while handling it are marked `via = 'mcp'` (`requestVia` in `db.module.ts`). Read tools are in `mcp.tools.ts`; write tools (`mcp.write-tools.ts`, `read_write` tokens only) validate with the API's own Zod schemas and call the shared services (`TasksService`, `InvoicesService`, `SchedulesService`, `AppointmentsService`, `PaymentsService`, `WebsiteService`). JSON bodies are 100 kB except `/api/website` (2 MB) and `/api/mcp` (8 MB), set in `src/setup.ts`. Anything hard to undo uses `gate()`: a preview plus a single-use confirmation in `app.mcp_confirmations`, and `destructiveHint` when it destroys or cancels.

- **Website (`apps/api/src/website/`, `apps/web/src/routes/site/`):** the public site at `/` (`/:slug` for other pages) reads `GET /api/site…` with no sign-in; RLS shows anonymous requests only published pages. Pages hold their modules as jsonb validated by `website.schemas.ts` (`hero`, `cards`, `columns`, `compare`, `faq`, `cta`, `html`, `image`, `video`, all with the shared section options); add a module type there, in `lib/site.ts`, `components/site/Modules.tsx` and the editor (`routes/staff/WebsiteEditors.tsx`). Site setup (site name, colors, fonts, logo, header) is `core.site_settings`; the public site shows `site_name` (a DBA) or else the business name; card icons and fonts are fixed lists by name in `website.schemas.ts` that `lib/site-icons.tsx` and `lib/site-fonts.ts` must match (a web test checks). Logic lives in `WebsiteService`, shared with the MCP website tools. HTML is sanitized with `sanitize-html` on save and DOMPurify on display; never render editor HTML without both. Images are bytes in `core.site_asset_data` (not audited), uploaded as the raw body with an image Content-Type checked against the file's signature; no SVG. Slugs used by the app (`portal`, `staff`, `auth`, `api`, …) are reserved in SQL and Zod. `/book-a-call` books a sales call: an appointment of the system type `sales_call` with no customer, service or location, holding the visitor's name, email and time zone (`contact_*`; rules in SQL `authz.sales_call_slots`/`book_sales_call`/`reschedule_sales_call`/`assign_sales_call`/`log_sales_call_outcome`, writes serialized by an advisory lock, open times within `core.sales_call_hours`). With hosts (`core.sales_call_hosts`) a time is open while a host is free (`core.sales_host_free`) and the call goes to the free host with the fewest upcoming calls; without hosts, calls are unassigned and one at a time. Under Marketing › Sales calls (`SalesCallsService`) staff with website read see the calls, and with website update reschedule (cancel is inside it), reassign, set the status (completed or no-show takes a call off Upcoming; `authz.set_sales_call_status`), log outcomes (follow up, conversion, potential, do not call), edit the confirmation and thank-you email templates (`core.email_templates`, `{{placeholders}}` from `SALES_CALL_FIELDS` in `apps/api/src/email/templates.ts`, unknown ones refused) and send thank-yous by hand (recorded as `thank_you_sent_at`). A booking notifies every active admin in JoyBot (`app.notify_sales_call_booked`; an admin who hosts gets the host notice instead) and, unless turned off in the Hosts section (`email_admins`), by email with Google/Outlook links and an `.ics` attachment (`email/calendar.ts`; only Resend sends attachments) and edit the setup (`core.sales_call_settings`). How calls are handled (`call_method`, Booking page tab): video meetings (generated Meet links; in effect only while a Google account is connected) or a callback number; `core.sales_call_method()` is the method in effect, falling back to callbacks, when the booking page requires the visitor's phone (`appointments.contact_phone`, checked in `authz.book_sales_call`). There is no fixed meeting link.

### Product constraints from the owner
- us-east-1 only, with one AWS Organization.
- No public buckets, images or data; artifacts are shared through `aws:PrincipalOrgID`.
- WhatsApp instead of SMS. The number and templates live in `core.settings`, not in stack parameters.
- Support tickets are JoyBot's own (`apps/api/src/tickets/`, `core.tickets` + `core.ticket_messages`; no external help desk). Customers open and reply in the portal, staff in the console; internal notes need `notes_internal`, and a staff reply emails the customer.
- Employee roles are admin and staff. Customers can be org admins. There's no org billing and no compliance scope for now.
- The model is Gemma 4 E2B, the cheapest variant.

## Tests

- **Setup:** Vitest. The API uses a TypeScript-transpile plugin for decorator metadata, because SWC's native binary fails macOS code-signing.
- **API tests:**
  - `test/app.ts` provides `createApp({ env, overrides })` and `api(app, employee(id) | customer(id))`.
  - `test/global-setup.ts` builds `<db>_test_template` (migrated, seeded) once per run; `test/reset-db.ts` copies it into the worker's own `<db>_test_<n>` before each file (`CREATE DATABASE … TEMPLATE`) and points the `*_DATABASE_URL`s there, so files run in parallel. The `db` and `worker` packages use one seeded database each (`<db>_test_db`, `<db>_test_worker`, see their `test/database.ts`). Helpers are in `packages/db/src/testing.ts`. The development database is never touched. Cluster-level state (roles) is shared: tests must not change it.
  - Tests must pass with `--sequence.shuffle.files`. If a test changes shared settings, restore them in `afterAll`.
- **Chat changes:** add or adjust cases in `apps/api/eval/cases.ts`. Every case also runs through the access oracle in `eval/score.ts`, which lists who may see which sample customers. Update it when the seed changes. Never loosen it to make a case pass.
- **Access tests:** test the access matrix (allowed and denied) for any new data path, using the sample principals in `SAMPLE`.

## Gotchas

- Postgres rejects **unused** `$n` parameters, so check them when building dynamic SQL.
- STABLE security-definer lookups can't see rows inserted by the same statement. `INSERT … RETURNING` relies on the `sel_own_created` policies for that reason.
- Zod's `discriminatedUnion` doesn't accept refined members. Use `superRefine` on the union instead.
- `Intl.DateTimeFormat` throws when `dateStyle`/`timeStyle` are combined with `timeZoneName`.
- **CloudFormation:**
  - No YAML anchors.
  - ASCII only in security group descriptions.
  - Every nested-stack parameter has to be passed, which `check_nested.py` checks.
- **Dockerfiles:**
  - They copy every workspace `package.json`, because `--frozen-lockfile` needs them all.
  - The RDS CA bundle lives in `/opt/rds`, not `/etc/ssl`.
- Not verified against real services yet: Cognito hosted sign-in, Stripe test mode, Gemma through vLLM or Ollama, and an actual AWS deploy. The checklist is in `cloudformation/README.md`.

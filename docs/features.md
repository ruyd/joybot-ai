# Feature notes

Details for specific areas, moved out of [CLAUDE.md](../CLAUDE.md) so they load only when needed. Read the section for an area before changing it.

## Appointments and customers

- **Appointment types** (`core.appointment_types`, edited from the calendar's Appointment types dialog by whoever may edit services): every appointment has one (default `service`), and the calendar draws its color. System types (`sales_call`) are read-only (trigger) and only the app creates their appointments. Every other type needs a customer, service and location (trigger `core.appointment_type_rules`). Appointment queries must `LEFT JOIN` services and locations.
- **Merged customers** become tombstones (`status = 'merged'`, `merged_into`), hidden by the customers SELECT policies. New code that looks customers up by number or Stripe id outside RLS should follow `merged_into`, as `core.match_stripe_customer` does.
- **Support tickets** are JoyBot's own (`apps/api/src/tickets/`, `core.tickets` + `core.ticket_messages`; no external help desk). Customers open and reply in the portal, staff in the console. Internal notes need `notes_internal`, and a staff reply emails the customer.

## Email (`apps/api/src/email/`)

- Admin › Email (`settings` update) stores Resend's key and the sender in `core.email_settings`.
- `MessagingService.send` routes app email (`RESEND_TEMPLATES`: invite, invoice, ticket, sales_call) through Resend once a key and a from address are saved, else through `MESSAGE_SENDER`. There's no on/off switch (`EmailService.delivery()`, cached 30 s).
- Sign-in and verification codes (`contact_code`) belong to the auth provider and never go through Resend.
- The Resend key is a third-party secret: see "Third-party keys" in CLAUDE.md.

## AI settings (`apps/api/src/ai/`, Admin › AI)

- **Assistant on/off:** `core.settings.assistant_customers` / `assistant_employees`. `GET /me` returns `assistant` for the caller's audience; the web app then hides the Assistant page, nav item and dock (the portal opens on Appointments). `ChatService.assertAssistantOn` refuses new conversations and questions with 403 `assistant_off`.
- **Chat model:** `core.ai_settings` holds the provider (`openrouter`, `custom`, or NULL for the server default `MODEL_ENDPOINT` / `MODEL_NAME`, else evidence-only answers), the model, the base URL (custom only) and `private_only`. The API key is encrypted in `core.ai_secret` (`authz.set_ai_key` / `authz.ai_delivery`).
- `LLM_PROVIDER` is a `ConfiguredLlmProvider`. For every question it asks `AiService.provider()` (cached 30 s, cleared on save) and falls back to the server default. Tests that override `LLM_PROVIDER` bypass it.
- **OpenRouter:** base `https://openrouter.ai/api/v1`. `private_only` sends `provider.data_collection = 'deny'`, and thinking is turned off with `reasoning.enabled = false`. Gemma 4 E2B isn't listed there; `google/gemma-4-26b-a4b-it` is the cheapest Gemma 4. Free (`:free`) models log prompts.
- `POST /admin/ai/test` sends one short prompt. Provider errors come back as 502 with the provider's own message.

## Video calls (`apps/api/src/video/`)

- Sales calls › Setup meeting links connects a Google account by OAuth with only the non-sensitive scope `calendar.app.created`, so no Google verification is needed. JoyBot makes its own "<site> sales calls" calendar there (`google_calendar_id`, remade if deleted) and can't see other calendars.
- Storage: client ID in `core.video_settings`; client secret and refresh token encrypted in `core.video_secret`; single-use state in `app.oauth_states`.
- The callback `GET /api/website/video/google/callback` is public and uses `API_PUBLIC_URL` or the request origin as the redirect URI.
- While an account is connected (no separate switch; disconnecting stops it), `SalesCallsService` creates, moves and deletes an event with a Meet link per sales call (`appointments.meeting_url`, `calendar_event_id`), best effort. That is the only meeting link emails use; there is no fixed link.
- `GOOGLE_HTTP` is injectable for tests.

## Website (`apps/api/src/website/`, `apps/web/src/routes/site/`)

- The public site at `/` (`/:slug` for other pages) reads `GET /api/site…` with no sign-in. RLS shows anonymous requests only published pages. Logic lives in `WebsiteService`, shared with the MCP website tools.
- **Modules:** pages hold their modules as jsonb validated by `website.schemas.ts` (`hero`, `cards`, `columns`, `compare`, `faq`, `cta`, `html`, `image`, `video`, all with the shared section options). To add a module type, change `website.schemas.ts`, `lib/site.ts`, `components/site/Modules.tsx` and the editor (`routes/staff/WebsiteEditors.tsx`).
- **Site setup** (site name, colors, fonts, logo, header) is `core.site_settings`. The public site shows `site_name` (a DBA) or else the business name. Card icons and fonts are fixed lists by name in `website.schemas.ts` that `lib/site-icons.tsx` and `lib/site-fonts.ts` must match (a web test checks).
- **HTML** is sanitized with `sanitize-html` on save and DOMPurify on display. Never render editor HTML without both.
- **Images** are bytes in `core.site_asset_data` (not audited), uploaded as the raw body with an image Content-Type checked against the file's signature. No SVG.
- **Reserved slugs:** those used by the app (`portal`, `staff`, `auth`, `api`, …) are reserved in SQL and Zod.

### Sales calls (`/book-a-call`, Marketing › Sales calls)

- A booking is an appointment of the system type `sales_call` with no customer, service or location, holding the visitor's name, email and time zone (`contact_*`).
- Rules are in SQL: `authz.sales_call_slots` / `book_sales_call` / `reschedule_sales_call` / `assign_sales_call` / `log_sales_call_outcome`. Writes are serialized by an advisory lock, and open times fall within `core.sales_call_hours`.
- **Hosts** (`core.sales_call_hosts`): a time is open while a host is free (`core.sales_host_free`), and the call goes to the free host with the fewest upcoming calls. Without hosts, calls are unassigned and one at a time.
- **Staff** (`SalesCallsService`): website read sees the calls. Website update can:
  - reschedule (cancel is part of it) and reassign
  - set the status (`authz.set_sales_call_status`); completed or no-show takes a call off Upcoming
  - log outcomes (follow up, conversion, potential, do not call)
  - edit the confirmation and thank-you templates (`core.email_templates`; `{{placeholders}}` come from `SALES_CALL_FIELDS` in `apps/api/src/email/templates.ts`, and unknown ones are refused)
  - send thank-yous by hand (recorded as `thank_you_sent_at`)
  - edit the setup (`core.sales_call_settings`)
- **Notifications:** a booking notifies every active admin in JoyBot (`app.notify_sales_call_booked`; an admin who hosts gets the host notice instead). Unless turned off in the Hosts section (`email_admins`), it also emails them with Google/Outlook links and an `.ics` attachment (`email/calendar.ts`; only Resend sends attachments).
- **How calls are handled** (`call_method`, Booking page tab): video meetings (generated Meet links, in effect only while a Google account is connected) or a callback number. `core.sales_call_method()` is the method in effect, falling back to callbacks. The callback method requires the visitor's phone (`appointments.contact_phone`, checked in `authz.book_sales_call`).

## MCP (`apps/api/src/mcp/`)

- `POST /api/mcp` is authenticated by an admin's personal access token (`app.api_tokens`, sha256 only), not the app's sign-in.
- Tools run as that admin through the existing services or SQL under RLS. Never add a raw-SQL tool. Queries are marked `via = 'mcp'` (`requestVia` in `db.module.ts`).
- Read tools are in `mcp.tools.ts`. Write tools (`mcp.write-tools.ts`, `read_write` tokens only) validate with the API's own Zod schemas and call the shared services (`TasksService`, `InvoicesService`, `SchedulesService`, `AppointmentsService`, `PaymentsService`, `WebsiteService`).
- Anything hard to undo uses `gate()`: a preview plus a single-use confirmation in `app.mcp_confirmations`, with `destructiveHint` when it destroys or cancels.

## Supabase Auth and the free-tier deploy

The plan and account setup are in [deploy-free.md](deploy-free.md).

- `AUTH_MODE=supabase` (`apps/api/src/auth/supabase.ts`): Google sign-in, one user pool for staff and customers. The web app sends `x-joybot-audience: employee` from the staff console.
- A login seen for the first time is linked with the Cognito triggers' SQL (`authz.link_employee_login` / `link_customer_signup`), run as `joybot_worker` through `SupabaseLoginLinker`. **The API's role must never get those functions**; a db test checks this.
- Other free-tier options: `CORS_ORIGINS`, `MESSAGING_MODE=resend` (all email through Resend), and `DB_SSL_CA[_FILE]` (`packages/db/src/ssl.ts`).
- `deploy/render` runs the API and worker in one container. `render.yaml` defines the service, and `.github/workflows/deploy-free.yml` migrates Supabase and then calls the deploy hook (only when the variable `FREE_DEPLOY` is `true`).
- Supabase's pooler caches credentials, so migrations there use `ROLE_PASSWORDS_ONCE=true`.
- Cloudflare Pages builds the web app and writes `config.json` with `apps/web/scripts/write-config.mjs`.

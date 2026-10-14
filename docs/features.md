# Feature notes

Details for specific areas, moved out of [CLAUDE.md](../CLAUDE.md) so they load only when needed. Read the section for an area before changing it.

## Appointments and customers

- **Appointment types** (`core.appointment_types`, edited from the calendar's Appointment types dialog by whoever may edit services): every appointment has one (default `service`), and the calendar draws its color. System types (`sales_call`) are read-only (trigger) and only the app creates their appointments. Every other type needs a customer, service and location (trigger `core.appointment_type_rules`). Appointment queries must `LEFT JOIN` services and locations.
- **Merged customers** become tombstones (`status = 'merged'`, `merged_into`), hidden by the customers SELECT policies. New code that looks customers up by number or Stripe id outside RLS should follow `merged_into`, as `core.match_stripe_customer` does.
- **Support tickets** are JoyBot's own (`apps/api/src/tickets/`, `core.tickets` + `core.ticket_messages`; no external help desk). Customers open and reply in the portal, staff in the console. Internal notes need `notes_internal`, and a staff reply emails the customer.

## Email (`apps/api/src/email/`)

- Settings › Email (`settings` update) stores Resend's key and the sender in `core.email_settings`.
- `MessagingService.send` routes app email (`RESEND_TEMPLATES`: invite, invoice, ticket, sales_call) through Resend once a key and a from address are saved, else through `MESSAGE_SENDER`. There's no on/off switch (`EmailService.delivery()`, cached 30 s).
- Sign-in and verification codes (`contact_code`) belong to the auth provider and never go through Resend.
- The Resend key is a third-party secret: see "Third-party keys" in CLAUDE.md.

## AI settings (`apps/api/src/ai/`, Settings › AI)

- **Assistant on/off:** `core.settings.assistant_customers` / `assistant_employees`. `GET /me` returns `assistant` for the caller's audience; the web app then hides the Assistant page, nav item and dock (the portal opens on Appointments). `ChatService.assertAssistantOn` refuses new conversations and questions with 403 `assistant_off`.
- **Chat model:** `core.ai_settings` holds the provider (`openrouter`, `custom`, or NULL for the server default `MODEL_ENDPOINT` / `MODEL_NAME`, else evidence-only answers), the model, the base URL (custom only) and `private_only`. The API key is encrypted in `core.ai_secret` (`authz.set_ai_key` / `authz.ai_delivery`).
- `LLM_PROVIDER` is a `ConfiguredLlmProvider`. For every question it asks `AiService.provider()` (cached 30 s, cleared on save) and falls back to the server default. Tests that override `LLM_PROVIDER` bypass it.
- **OpenRouter:** base `https://openrouter.ai/api/v1`. `private_only` sends `provider.data_collection = 'deny'`, and thinking is turned off with `reasoning.enabled = false`. Gemma 4 E2B isn't listed there; `google/gemma-4-26b-a4b-it` is the cheapest Gemma 4. Free (`:free`) models log prompts.
- `POST /admin/ai/test` sends one short prompt. Provider errors come back as 502 with the provider's own message.

## Stripe settings (`apps/api/src/stripe/`, Settings › Stripe)

- **API key and webhook signing secret:** saved encrypted in `core.stripe_secret` (no grants; `authz.set_stripe_secret` and `authz.stripe_secret_info` for admins, `authz.stripe_key_cipher` for the API and the worker, `authz.stripe_webhook_cipher` for the webhook). Each saved one comes before its server setting (`STRIPE_WEBHOOK_SECRET` or the Stripe secret's `webhookSigningSecret`). A saved key comes before the environment / Secrets Manager (`STRIPE_CHECKOUT_KEY`, `STRIPE_RESTRICTED_KEY`, the Stripe secret). One key serves both uses, so a restricted key needs write access to Checkout Sessions and read access to PaymentIntents and Charges. `StripeSecrets` caches it for 60 s and forgets it on save.
- **Live and test** (migration 0052): a live and a test API key and webhook signing secret, and `core.settings.stripe_test_mode` (`PUT /admin/stripe/mode`). `authz.stripe_key_cipher()` returns the key of the mode in use (checkout and the worker). The webhook accepts either saved signing secret (`authz.stripe_webhook_secrets()`) but acknowledges and ignores events of the other mode; the server's `STRIPE_WEBHOOK_SECRET` is only used while neither is saved, and its events are always applied.
- The worker decrypts with the shared `openSecret` (`packages/db/src/secret-box.ts`), so it needs `SETTINGS_ENCRYPTION_KEY` too (in the AWS worker task; Render shares the API's environment).
- The page shows the webhook address to paste into Stripe (`apiUrl('/webhooks/stripe')`) and the events the worker applies (`WEBHOOK_EVENTS` in `StripePage.tsx`, mirroring `apps/worker/src/stripe/apply.ts`), plus the sync switch (`core.settings.stripe_enabled`), status and Reconcile now.
- **Reconcile schedule:** `core.settings.stripe_reconcile_interval_hours` (default 24) and `stripe_reconcile_days` (3), read by the worker through `authz.stripe_reconcile_settings()` (they replace the worker's `STRIPE_RECONCILE_*` variables). Reconcile now without `days` uses the setting.

## Video calls (`apps/api/src/video/`)

- Sales calls › Setup meeting links connects a Google account by OAuth with only the non-sensitive scope `calendar.app.created`, so no Google verification is needed. JoyBot makes its own "<site> sales calls" calendar there (`google_calendar_id`, remade if deleted) and can't see other calendars.
- Storage: client ID in `core.video_settings`; client secret and refresh token encrypted in `core.video_secret`; single-use state in `app.oauth_states`.
- The callback `GET /api/website/video/google/callback` is public and uses `API_PUBLIC_URL` or the request origin as the redirect URI.
- While an account is connected (no separate switch; disconnecting stops it), `SalesCallsService` creates, moves and deletes an event with a Meet link per sales call (`appointments.meeting_url`, `calendar_event_id`), best effort. That is the only meeting link emails use; there is no fixed link.
- `GOOGLE_HTTP` is injectable for tests.

## Website (`apps/api/src/website/`, `apps/web/src/routes/site/`)

- The public site at `/` (`/:slug` for other pages) reads `GET /api/site…` with no sign-in. RLS shows anonymous requests only published pages. Logic lives in `WebsiteService`, shared with the MCP website tools.
- **Modules:** pages hold their modules as jsonb validated by `website.schemas.ts` (`hero`, `cards`, `columns`, `compare`, `faq`, `cta`, `html`, `image`, `video`, all with the shared section options). To add a module type, change `website.schemas.ts`, `lib/site.ts`, `components/site/Modules.tsx` and the editor (`routes/staff/WebsiteEditors.tsx`).
- **Site setup** (site name, colors, fonts, logo, browser tab icon, header) is `core.site_settings`. The public site's favicon is `favicon_asset_id`, else the logo, else the app's own (`useSiteFavicon` swaps the `<link rel="icon">` only while on the site; crawlers that don't run scripts still see the app's icon). The public site shows `site_name` (a DBA) or else the business name. Card icons and fonts are fixed lists by name in `website.schemas.ts` that `lib/site-icons.tsx` and `lib/site-fonts.ts` must match (a web test checks).
- **Loading** (`components/site/SiteLoader.tsx`): while `/api/site` loads, the site shows a loader with the site's name, logo and accent from the last visit (`localStorage`), and after a few seconds explains that it is waking up (the free-tier API sleeps). Site queries retry 5xx and network errors for about 90 s (`retryWhileWaking`), then show **Try again**. `index.html` has a plain spinner until the app starts.
- **HTML** is sanitized with `sanitize-html` on save and DOMPurify on display. Never render editor HTML without both.
- **Images** are uploaded as the raw body with an image Content-Type checked against the file's signature. No SVG.
  - Where they're stored is `core.site_assets.storage`. By default (`db`) the bytes are in `core.site_asset_data` (not audited) and `GET /api/site/assets/:id` serves them.
  - With `SITE_ASSET_STORE=s3` (`SITE_ASSET_STORE` token, `website/asset-store.ts`), they go to the bucket as `site/<id>`: put first, then the row, and the object is removed if the insert fails. The API answers with a 301 to the CDN, and the web app links to `assetBase/site/<id>` directly (`assetUrl`).
  - Deleting removes the object and, with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`, purges the CDN.
  - Images uploaded before the switch are moved with `POST /api/website/assets/move` (`authz.site_asset_moved`), offered in the editor's image library.
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

- **Analytics** (`website/analytics.service.ts`, staff page `/staff/analytics`, dashboard boxes for today and this week): the public site posts each page view to `POST /api/site/view` (`reportView` in `lib/site.ts`; first party, so ad blockers don't hide it, and no cookies). The API drops bots and non-site paths, limits each visitor to 60 views a minute, buffers in memory and writes once a minute through `authz.record_site_visits` (a restart loses at most a minute). Only daily totals are stored (`core.site_visit_days/pages/sources/devices/countries`, read with `website` read). Visitors are told apart for one day by `sha256(daily salt || ip|user agent)`; the hashes and salts are deleted after a day and have no grants. Country comes from Cloudflare's `CF-IPCountry`, days are in the business time zone, and "this week" starts on Monday.

## Store (`apps/api/src/store/`, `/shop`, Website › Products, Orders, Settings › Store)

- **Products** (`core.products`, migration 0051) are services or digital products (no shipping), edited by anyone with `website` rights; anyone sees active ones while the store is open (`core.store_settings.enabled`). What a buyer gets (`core.product_delivery`, Markdown) is never public: it's copied onto the order's lines when the order is paid.
- **Cart** lives in the browser (`lib/store.ts`, localStorage `joybot.cart`, ids and quantities only). Checkout is in the portal (`/portal/checkout`), so customers sign in first.
- **Orders** (`core.orders`, `core.order_lines`) are only written through SECURITY DEFINER functions: `authz.create_order` (customer, prices from the products, cancels their older unpaid orders), `authz.attach_order_checkout`, and `authz.set_order_status` (staff with payments create scope: paid ↔ fulfilled, pending → cancelled). Reads follow `payments` scope like invoices.
- **Paying:** `StripeStoreCheckout` (`STORE_CHECKOUT`, overridden in tests) sends each line's price (no Stripe catalog) and the store options (Stripe Tax, promotion codes, terms). The PaymentIntent carries `order_number` and `customer_number`; the worker links the payment (`payments.order_id`), and `core.order_refresh` sets the status from payments: paid (all-digital orders go straight to fulfilled), refunded, or back to pending. Newly paid orders notify admins (`notify_admins`).
- `/me` returns `store` (open or not) for the portal's Orders link. `shop` is a reserved page address.
- Not yet: order emails to customers, a products module for site pages, MCP tools for products and orders.

## MCP (`apps/api/src/mcp/`)

- `POST /api/mcp` is authenticated by an admin's personal access token (`app.api_tokens`, sha256 only), not the app's sign-in. Revoking a token deletes it (`DELETE /api/admin/api-tokens/:id`, admins only). The audit trigger logs the deleted row (name, prefix, scope, last use) and who deleted it, and the audit log shows that on one line.
- Tools run as that admin through the existing services or SQL under RLS. Never add a raw-SQL tool. Queries are marked `via = 'mcp'` (`requestVia` in `db.module.ts`).
- Read tools are in `mcp.tools.ts`. Write tools (`mcp.write-tools.ts`, `read_write` tokens only) validate with the API's own Zod schemas and call the shared services (`TasksService`, `InvoicesService`, `SchedulesService`, `AppointmentsService`, `PaymentsService`, `WebsiteService`).
- Anything hard to undo uses `gate()`: a preview plus a single-use confirmation in `app.mcp_confirmations`, with `destructiveHint` when it destroys or cancels.

## Supabase Auth and the free-tier deploy

The plan and account setup are in [deploy-free.md](deploy-free.md).

- `AUTH_MODE=supabase` (`apps/api/src/auth/supabase.ts`): Google sign-in, one user pool for staff and customers. The web app sends `x-joybot-audience: employee` from the staff console.
- Sessions last until sign-out: access tokens expire hourly, but Supabase's refresh token doesn't (unless a session time-box or inactivity timeout is set in the dashboard, which is a Pro feature). The web app takes each call's token from `auth.getSession()`, which renews an expired one, and on a 401 it refreshes and retries once before signing out (`lib/api.ts`).
- A login seen for the first time is linked with the Cognito triggers' SQL (`authz.link_employee_login` / `link_customer_signup`), run as `joybot_worker` through `SupabaseLoginLinker`. **The API's role must never get those functions**; a db test checks this.
- Other free-tier options: `CORS_ORIGINS`, `MESSAGING_MODE=resend` (all email through Resend), and `DB_SSL_CA[_FILE]` (`packages/db/src/ssl.ts`).
- `deploy/render` runs the API and worker in one container. `render.yaml` defines the service, and `.github/workflows/deploy-free.yml` migrates Supabase and then calls the deploy hook (only when the variable `FREE_DEPLOY` is `true`).
- Supabase's pooler caches credentials, so migrations there use `ROLE_PASSWORDS_ONCE=true`.
- Cloudflare Pages builds the web app and writes `config.json` with `apps/web/scripts/write-config.mjs`.

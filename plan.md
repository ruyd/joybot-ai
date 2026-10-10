# JoyBot AI — Project Plan

A chatbot for **customers and employees**, powered by a self-hosted **Gemma 4** model. JoyBot owns its **own PostgreSQL database as the source of truth**. It holds general `settings`, `locations`, employees (`users`), `organizations`, `customers`, a generic `services` price list, `appointments` and `payments`. Every question is answered from that database plus **Freshdesk** support tickets, with citations.

- **Customers** sign in with **email or phone (codes delivered over WhatsApp)**. They chat about their own appointments, payments, services and Freshdesk tickets.
- **Organization admins** (customers with the org-admin role) also see their organization's members, appointments and tickets.
- **Employees** are either **admin** or **staff**. They see the customers, organizations and records the **access-control rules** allow.

**Payments come from two sources into one `payments` table**:
- **Stripe**, synced automatically by webhooks and nightly reconciliation.
- **Manual entries** by staff: POS terminal, bank transfer, cash.

The stack is a **NestJS** backend and a **React + Vite** frontend. It runs on **AWS (us-east-1)** as **CloudFormation stacks** launched with a one-click **Quick-Create link**. Artifacts are **private** and shared only within your **AWS Organization**.

---

## 1. Goals & Scope

### Goals
- **Two audiences, one app**:
  - **Customer portal**: a customer signs in and asks things like "When is my next appointment?", "Did my card payment go through?", "Was my bank transfer received?", "What's the status of my ticket?". They see **only their own data**, or their organization's if they are an **org admin**.
  - **Staff console**: an employee asks things like "Show me Maria Lopez's unpaid appointments", "Acme Corp's open tickets", "What's on my schedule tomorrow?". JoyBot **finds the customer or organization**, checks **access rules**, then answers.
- **JoyBot Postgres is the source of truth** for `settings`, `locations`, `users`, `organizations`, `customers`, `services`, `appointments`, `payments`, and the access-control tables.
- **Access control for records and organizations**:
  - Two employee roles: **admin** (everything) and **staff** (scoped by location and assignments).
  - **Assignments** of staff to organizations and customers.
  - A **restricted** flag on sensitive records, and temporary **record grants**.
  - Enforced in the API **and** in Postgres Row-Level Security.
- **Customer records are filled in over time**, by employees (minimal record first) or by self sign-up, meeting on the same `customers` row.
- **Multiple locations and time zones**: a time zone per location, and defaults in the **general settings** table.
- **Payments**:
  - **Stripe** payments are mirrored automatically.
  - **Manual payments** (POS terminal, bank transfer, cash) are recorded by staff with validation, duplicate checks and an audit trail.
  - One combined view, balance and history per customer. No card data stored.
- **Freshdesk tickets**:
  - Looked up by the customer's **verified email and phone**.
  - Customers see their own tickets, org admins see their organization members' tickets, and employees see tickets per access rules.
  - Private notes are never shown to customers.
- **WhatsApp** (not SMS) for phone verification and sign-in codes and portal invites. The WhatsApp sender number and templates are **configured in the settings table** (Admin UI), not in the stack.
- Streaming chat with citations that link to the record (appointment, payment, service, ticket).
- Self-hosted **Gemma 4 E2B** (cheapest variant) behind an internal, OpenAI-compatible API with tool calling and JSON output.
- One-click deployment from a **private** CloudFormation template in **us-east-1**.

### Non-goals (v1)
- Subscriptions / packages; organization billing.
- Taking payments *inside* JoyBot. Customers pay through Stripe flows you already use, or at the POS / by bank transfer. Stripe Checkout "pay now" links from JoyBot are a later option (Phase 6).
- Write actions through chat (booking, cancelling, creating tickets).
- SMS; other support systems than Freshdesk; Jira.
- Regulatory compliance programs; data migration / bulk import; LLM-generated SQL; fine-tuning; voice / multimodal.

---

## 2. High-Level Architecture

```
  Customers ──┐       ┌──────────────────────────┐
  Org admins ─┼──────▶│ CloudFront + S3 (React)  │  /portal  (customer)   /staff (employee)
  Employees ──┘       └──────────────────────────┘
                        │ /api/*  (SSE streaming)
                        ▼
┌──────────────┐    ┌──────────────────────────────────────────────────┐
│ Internal ALB │───▶│ NestJS API (ECS on EC2)                          │
│ (VPC origin) │    │  1. identify principal + load permissions        │
└──────────────┘    │  2. customer: scope = self (or org if org admin) │
                    │     employee: extract IDs → resolve → authorize  │
                    │  3. plan tools → run (RLS-scoped) → evidence     │
                    │  4. build context → stream answer                │
                    │  + back-office, manual payments, access, settings│
                    └──┬───────────────────────┬───────────────────┬───┘
                       │                       │                   │
                       ▼                       ▼                   ▼
┌──────────────────────────────────┐  ┌──────────────────┐  ┌───────────────────────────┐
│ Aurora PostgreSQL — JoyBot DB    │  │ Model service    │  │ External services         │
│  core: settings, locations,      │  │ vLLM + Gemma 4   │  │ (via NAT)                 │
│        users, organizations,     │  │ E2B on g6.xlarge │  │  Freshdesk API v2         │
│        customers, services,      │  │ ECS on EC2 GPU   │  │  Stripe API (reconcile)   │
│        appointments, payments,   │  └──────────────────┘  └───────────────────────────┘
│        roles, permissions,       │
│        assignments, grants       │   Stripe ──webhooks──▶ /api/webhooks/stripe
│  app:  conversations, messages,  │
│        traces, stripe_events     │   Cognito (customers) ── Custom SMS sender Lambda
│  RLS on core tables              │     ──▶ AWS End User Messaging Social ──▶ WhatsApp
└──────────────────────────────────┘     (number + templates read from settings via SSM)
          ▲
┌─────────┴─────────────────┐
│ Worker (ECS on EC2)       │  Stripe reconciliation, webhook processing, Freshdesk
│                           │  contact-ID refresh, invites, grant expiry, health checks
└───────────────────────────┘
```

### Key decisions

| Concern | Choice | Rationale |
|---|---|---|
| Source of truth | **JoyBot's own Aurora PostgreSQL**, `core` schema | One authoritative store we control |
| Access control | **Two employee roles (admin, staff)** + customer roles (customer, org_admin). Permissions stored as data (resource × action × scope), plus **assignments**, **restricted** records and **record grants**. Enforced by NestJS (CASL) **and** Postgres RLS from the same tables | Simple roles, record- and org-level control, DB backstop |
| Identity | **Two Cognito user pools**. *Customers*: email or phone as username; phone codes over **WhatsApp** via the Cognito **Custom SMS sender** trigger. *Employees*: admin-created or SSO, MFA required | WhatsApp instead of SMS while keeping Cognito |
| WhatsApp | **AWS End User Messaging Social**. Sender number ID and template names stored in **`core.settings`**, edited in Admin, and published to an SSM parameter for the Cognito Lambda | Configure and change without redeploying the stack |
| Payments | **Stripe + manual** into one `payments` table (`source = stripe \| manual`). Stripe: signed webhooks + nightly reconciliation (restricted read-only key). Manual: validated staff entry for POS / bank transfer / cash, with duplicate detection | Matches how money arrives today; one balance per customer |
| Support tickets | **Freshdesk API v2**. Contacts found by the customer's **verified email and phone**, then their tickets. Read-only API key. Ownership is checked **after fetch** | Simple mapping; no manual linking needed |
| Time | `timestamptz` (UTC); display time zone: location → person → `settings.default_time_zone` | Correct local times |
| LLM | **Gemma 4 E2B**; E4B fallback on the same GPU at the same cost | Lowest cost |
| Inference | **vLLM** (OpenAI-compatible, tool calling, guided JSON); Ollama for local dev | |
| Backend | NestJS + `pg` with hand-written SQL repositories and raw SQL migrations; **CASL** abilities | RLS-centric design: every query runs in a transaction carrying the principal (`withPrincipal`) |
| Compute | **ECS on EC2**: CPU (Graviton) for `api` + `worker`, GPU for vLLM | Lowest cost at steady load |
| Frontend | React 19 + Vite 7 + TS + TanStack Query + Tailwind 4; `/portal` and `/staff` | |
| IaC | **Plain CloudFormation YAML**, nested stacks; **us-east-1 only** (template `Rules` assertion) | |
| Distribution | **Private** S3 artifacts bucket + **private ECR**, shared via `aws:PrincipalOrgID` with **one AWS Organization**. No public buckets, images or data | |
| CI/CD | GitHub Actions (OIDC) → test → publish versioned artifacts → `aws cloudformation deploy` | |

---

## 3. Repository Layout (monorepo)

```
joybot-ai/
├── apps/
│   ├── api/                 # NestJS: auth, back-office, payments, access admin, chat, Stripe webhooks, Freshdesk, profile/invites, org area
│   ├── web/                 # React + Vite frontend (/portal + /staff)
│   └── worker/              # Stripe event processing + reconciliation, on-demand jobs (app.worker_jobs)
├── packages/
│   ├── db/                  # SQL migrations (schema, RLS policies, authz functions), migrate runner, seed + sample data
│   └── access/              # CASL ability builder shared by api and web
├── services/
│   └── model-server/        # vLLM image (Gemma 4 E2B, S3 weights cache)
├── cloudformation/
│   ├── main.yaml
│   ├── stacks/              # network, data, messaging, auth, compute, model, backend, frontend, observability
│   ├── bootstrap/           # artifacts.yaml: private artifacts bucket + ECR, optional GitHub OIDC release role
│   ├── functions/           # DB bootstrap, customer post-confirmation, employee post-authentication, WhatsApp sender, web assets
│   ├── parameters/          # dev.json (staging/prod to add in Phase 6)
│   └── scripts/             # publish.sh, quickcreate-link.mjs, check_nested.py
├── tools/fake-freshdesk.mjs # local Freshdesk stub
├── .github/workflows/       # ci.yml, release.yml
├── docker-compose.yml       # postgres 16 (localhost:5433)
├── CLAUDE.md                # conventions for working on the code
└── plan.md
```

---

## 4. Data Model — JoyBot Postgres (source of truth)

### 4.1 `core` schema — business data

```sql
-- General settings (single row; Admin → General settings)
core.settings (
  id                         smallint pk default 1 check (id = 1),
  business_name              text,
  default_time_zone          text not null,      -- IANA, e.g. 'America/New_York'
  default_currency           char(3) not null,   -- ISO 4217
  default_locale             text default 'en-US',
  chat_retention_days        int default 365,
  -- WhatsApp (End User Messaging Social); phone sign-up/invites disabled until set
  whatsapp_enabled           boolean default false,
  whatsapp_phone_number_id   text null,          -- e.g. 'phone-number-id-0123…' (AWS End User Messaging Social)
  whatsapp_display_number    text null,          -- E.164, shown in the UI
  whatsapp_otp_template      text null,          -- Meta-approved authentication template name
  whatsapp_invite_template   text null,          -- Meta-approved utility template name
  whatsapp_template_language text default 'en_US',
  -- Freshdesk (credentials live in Secrets Manager, not here)
  freshdesk_domain           text null,          -- e.g. 'yourco.freshdesk.com'
  freshdesk_portal_url       text null,          -- customer portal base for deep links
  -- Payments
  stripe_enabled             boolean default false,
  manual_payment_methods     text[] default '{card_pos,bank_transfer,cash}',
  bank_transfer_due_days     int default 5,      -- pending transfers become "overdue" after this
  updated_by                 uuid null references core.users(id),
  updated_at                 timestamptz
)

core.locations (
  id uuid pk, code text unique, name text, address jsonb, phone text,
  time_zone text not null, active boolean default true, created_at, updated_at timestamptz
)

-- Employees
core.users (
  id uuid pk, cognito_sub text unique, employee_number text unique,
  first_name, last_name text, email citext unique, phone text,
  role text not null check (role in ('admin','staff')),
  home_location_id uuid null references core.locations(id),
  time_zone text null, active boolean default true, created_at, updated_at timestamptz
)
core.user_locations (user_id uuid, location_id uuid, primary key (user_id, location_id))

core.organizations (
  id uuid pk, org_number text unique, name text not null, legal_name text null, tax_id text null,
  email citext null, phone text null, address jsonb null,
  restricted boolean default false,
  status text check (status in ('active','inactive')) default 'active',
  notes_internal text, created_at, updated_at timestamptz
)

-- Customers (one person per record; populated incrementally)
core.customers (
  id                 uuid pk,
  customer_number    text unique,
  cognito_sub        text unique null,
  organization_id    uuid null references core.organizations(id),
  org_role           text null check (org_role in ('member','org_admin')),
  first_name, last_name text null,
  email              citext null,   email_verified boolean default false,
  phone              text null,     phone_verified boolean default false,   -- E.164; verified by WhatsApp code
  whatsapp_opt_in_at timestamptz null,
  time_zone          text null,
  preferred_location_id uuid null references core.locations(id),
  date_of_birth      date null, address jsonb null,
  stripe_customer_id text unique null,
  restricted         boolean default false,
  status             text check (status in ('active','inactive','blocked')) default 'active',
  source             text check (source in ('employee','self_signup')),
  profile_completed_at timestamptz null,
  preferred_employee_id uuid null references core.users(id),
  notes_internal     text,
  created_by         uuid null references core.users(id),
  created_at, updated_at timestamptz,
  check (email is not null or phone is not null),
  check ((organization_id is null) = (org_role is null))
)

core.services (
  id uuid pk, code text unique, name text, description text, category text,
  duration_minutes int null, price numeric(12,2) not null, currency char(3) not null,
  active boolean default true, created_at, updated_at timestamptz
)

core.appointments (
  id uuid pk, appointment_number text unique,
  customer_id uuid references core.customers(id),
  service_id uuid references core.services(id),
  employee_id uuid null references core.users(id),
  location_id uuid references core.locations(id),
  scheduled_start timestamptz, scheduled_end timestamptz,
  status text check (status in ('scheduled','confirmed','completed','cancelled','no_show')),
  price_quoted numeric(12,2), currency char(3),
  notes_customer text, notes_internal text,
  created_by uuid null references core.users(id), created_at, updated_at timestamptz
)

-- Payments: Stripe-synced and manual, one table
core.payments (
  id                 uuid pk,
  payment_number     text unique,              -- e.g. P-2026-000456
  source             text not null check (source in ('stripe','manual')),
  customer_id        uuid null references core.customers(id),   -- null only while a Stripe payment is unmatched
  appointment_id     uuid null references core.appointments(id),
  location_id        uuid null references core.locations(id),
  amount             numeric(12,2) not null check (amount > 0),
  amount_refunded    numeric(12,2) default 0 check (amount_refunded >= 0 and amount_refunded <= amount),
  currency           char(3) not null,
  method             text not null check (method in ('card_online','card_pos','bank_transfer','cash','wallet','other')),
  status             text not null check (status in ('pending','processing','succeeded','failed','canceled','voided','refunded','partially_refunded','disputed')),
  -- Stripe
  stripe_payment_intent_id text unique null,
  stripe_charge_id   text unique null,
  stripe_invoice_id  text null,
  failure_reason     text null,
  receipt_url        text null,
  -- Manual: POS terminal
  pos_terminal_id    text null,
  pos_reference      text null,                -- transaction/authorization ID on the POS receipt
  -- Manual: bank transfer
  bank_reference     text null,
  expected_at        date null,                -- pending transfers
  -- Common
  card_brand         text null, card_last4 char(4) null,
  paid_at            timestamptz null,
  recorded_by        uuid null references core.users(id),   -- required for manual
  void_reason        text null, voided_by uuid null, voided_at timestamptz null,
  possible_duplicate_of uuid null references core.payments(id),
  notes_internal     text,
  created_at, updated_at timestamptz,
  check (source <> 'manual' or (recorded_by is not null and customer_id is not null)),
  check (source <> 'manual' or method in ('card_pos','bank_transfer','cash','other')),
  check (method <> 'card_pos' or source <> 'manual' or pos_reference is not null),
  check (method <> 'bank_transfer' or source <> 'manual' or status = 'pending' or bank_reference is not null)
)
-- unique (pos_terminal_id, pos_reference) where pos_reference is not null
-- unique (bank_reference, customer_id)    where bank_reference is not null

-- Cached links to external systems (Freshdesk contact IDs found by email/phone)
core.external_links (
  entity_type text check (entity_type in ('customer','organization')),
  entity_id   uuid,
  source      text,                            -- 'freshdesk_contact' | 'freshdesk_company'
  external_id text,
  matched_by  text,                            -- 'email' | 'phone'
  refreshed_at timestamptz,
  primary key (entity_type, entity_id, source, external_id)
)

core.change_log (id, table_name, row_id, action, changed_by, changed_via, changed_at, diff jsonb)
```

**Indexes**:
- `customers`: unique partial on `lower(email)` and `phone`; trigram on name; `(organization_id, org_role)`.
- `organizations`: trigram on `name` and `legal_name`.
- `appointments`: `(customer_id, scheduled_start desc)`, `(employee_id, scheduled_start)`, `(location_id, scheduled_start)`.
- `payments`:
  - `(customer_id, paid_at desc)`, `(appointment_id)`
  - `(status) where status = 'pending'`
  - `(source, created_at)`
  - The unique partial indexes on POS and bank references above.

**Views**:
- `v_customer_balance`: completed appointments minus succeeded payments, net of refunds, **Stripe and manual combined**.
- `v_pending_bank_transfers`: overdue after `settings.bank_transfer_due_days`.
- `v_unmatched_stripe_payments`.
- `v_upcoming_appointments`.

### 4.2 Access control — records and organizations

**Roles**:

| Role | Audience | Description |
|---|---|---|
| **`admin`** | employee | Full access to all records **including restricted**; manages settings, locations, employees, permissions, assignments, grants; voids/refunds payments |
| **`staff`** | employee | Works with customers and organizations **at their locations** or **assigned** to them, plus records with an explicit **grant**. Restricted records only via assignment or grant |
| **`org_admin`** | customer | Own organization: members, members' appointments and tickets; invite/remove members. **Not** members' payments |
| **`customer`** | customer | Self only |

**Tables** (permissions are data, so the admin can tune what staff may do without code changes):

```sql
core.role_permissions (
  role     text check (role in ('admin','staff','org_admin','customer')),
  resource text,   -- customers | organizations | appointments | payments | services | locations
                   -- | tickets | users | settings | audit | notes_internal | access
  action   text,   -- read | create | update | delete | void | refund
  scope    text,   -- all_including_restricted | all | location | assigned | own | org | self
  primary key (role, resource, action, scope)
)
core.assignments (
  id uuid pk, user_id uuid references core.users(id),
  organization_id uuid null references core.organizations(id),
  customer_id uuid null references core.customers(id),
  starts_at timestamptz default now(), ends_at timestamptz null,
  check ((organization_id is null) <> (customer_id is null))
)
core.record_grants (
  id uuid pk, user_id uuid references core.users(id),
  resource text check (resource in ('customer','organization')), record_id uuid,
  actions text[], reason text, granted_by uuid, expires_at timestamptz null, created_at timestamptz
)
```

**Default permissions (seeded)**:

| Resource | admin | staff | org_admin | customer |
|---|---|---|---|---|
| customers / organizations | CRUD `all_including_restricted` | read/create/update `location` + `assigned` | read `org` (members); update membership | read/update `self` |
| appointments | CRUD all | CRUD `location` + `assigned` + `own` | read `org` | read `self` |
| payments | CRUD, **void, refund** all | **create** manual + read `location` + `assigned`; update own manual entries **same day** | — (self only) | read `self` |
| tickets (Freshdesk) | read all | read `location` + `assigned` | read `org` | read `self` |
| services / locations | CRUD | read | read | read |
| notes_internal | read/update | read/update in scope | — | — |
| settings, users, access, audit | manage | — | — | — |

**Scope rules**:
- `location`: customers with an appointment at, or preferred location in, one of the staff member's `user_locations`. Restricted records are excluded.
- `assigned`: active assignments. An organization assignment covers all its members, including restricted ones.
- `own`: appointments where `employee_id = me`.
- `org`: the org admin's organization and its members.

**Enforcement**:
1. **API**: a CASL ability is built per request from `role_permissions`, assignments, locations and grants (cached 60 s, invalidated on change); controllers and tools use `@Can()`.
2. **Database**:
   - Each transaction runs `SET LOCAL app.principal_type / app.principal_id / app.role`.
   - RLS policies call `STABLE` functions such as `app_can_access_customer(id, action)` and `app_can_access_org(id, action)`, which read the same tables.
   - The chat path's `joybot_reader` role is SELECT-only, with RLS forced.
3. **Freshdesk data**: after fetching, each ticket's requester must belong to the in-scope customer(s) (§4.5). Anything else is dropped.
4. **Audit**:
   - Permission, assignment, grant, restricted-flag and org-admin changes go to `change_log`.
   - Chat retrievals go to `retrieval_traces`.
   - Each customer/organization page has a **"who can access"** panel.

### 4.3 Incremental customer population & WhatsApp

| Path | What happens |
|---|---|
| **Employee creates customer** | Minimum: first name + email **or** phone. Optional: organization + org role, location, notes, **WhatsApp opt-in**. Can send a portal invite by email, or by WhatsApp if opted in and WhatsApp is configured |
| **Self sign-up** | Email (code by email) or phone (**code by WhatsApp**). The post-confirmation trigger links to an unlinked customer with the same **verified** contact or invite token, otherwise it creates a new row |
| **Sign-in** | Email + password / email code, or phone + WhatsApp code (Cognito passwordless OTP, Essentials tier). Without WhatsApp → email |
| **Profile completion** | Name, the other contact method (verified), time zone, preferred location |
| **Org membership** | Set by staff/admin, or by an org admin inviting members |
| **Conflicts / duplicates** | Link-review queue (link the waiting login, merge, or reject); duplicate detection (same name, or same last name + birth date) and merge into a hidden tombstone. Admin-only (`customers:merge`), audited. A sign-up waiting for review gets a 403 `account_in_review` |

**WhatsApp configuration lives in `core.settings`**:
- **Admin → Settings → WhatsApp** holds the End User Messaging Social **phone number ID**, display number, OTP and invite **template names** and language, and the enable toggle. A **"Send test message"** button checks them.
- On save, the API validates the phone number ID with End User Messaging Social and writes the WhatsApp settings to the SSM parameter `/joybot/<env>/whatsapp`.
- The **Cognito Custom SMS sender Lambda** reads that parameter (cached 5 min), decrypts the code (KMS), and sends the authentication template with `SendWhatsAppMessage`.
- Its IAM policy allows sending from **any** WhatsApp number in this account (`phone-number-id/*`), so changing the number needs no redeploy.
- While `whatsapp_enabled = false`, the portal hides phone sign-up and WhatsApp invites; email still works.

**One-time setup** (no existing Meta account):
1. Create a **Meta Business** account and complete business verification.
2. In the **AWS End User Messaging Social** console (us-east-1), use the embedded sign-up to create the **WhatsApp Business Account** and register a phone number.
3. Submit the **authentication** (OTP, copy-code button) and **utility** (invite) templates and wait for Meta's approval.
4. Enter the number ID and template names in Admin → Settings → WhatsApp.

### 4.4 Payments — Stripe + manual

**Stripe (automatic)**:
- **Webhook** `POST /api/webhooks/stripe` (public via CloudFront, no JWT):
  - Verifies the `Stripe-Signature` header.
  - Stores the event in `app.stripe_events`, keyed by `event_id`, so repeated deliveries are ignored.
  - The worker processes events in order of Stripe's `created` time.
- **Events**:
  - `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.processing`, `payment_intent.canceled`
  - `charge.refunded`
  - `charge.dispute.created` / `closed`
  - `customer.created` / `updated`
- **Customer matching**:
  1. `metadata.customer_number` / `metadata.appointment_number`.
  2. `stripe_customer_id`.
  3. Verified **email**.
  4. Verified **phone**.
  - Anything still unmatched lands in the **unmatched Stripe payments** queue for staff to assign.
- **Reconciliation**: nightly and on demand, with a **restricted read-only key**. It lists the last N days of PaymentIntents/Charges and fixes any differences.
- Stripe rows are **read-only** in the UI except for assigning a customer or appointment. Refunds happen in Stripe and flow back via webhook.

**Manual (staff entry)**:

| Method | Required fields | Initial status | Rules |
|---|---|---|---|
| `card_pos` | amount, currency, `pos_reference`, paid_at; optional terminal ID, brand/last-4 | `succeeded` | Unique `(pos_terminal_id, pos_reference)` |
| `bank_transfer` | amount, currency; `expected_at` if not yet received; `bank_reference` + `paid_at` when received | `pending` → `succeeded` | Pending > `bank_transfer_due_days` = overdue; unique `(bank_reference, customer)` |
| `cash` | amount, currency, paid_at; optional receipt number | `succeeded` | — |
| `other` | amount, currency, description in notes | `succeeded` | Admin only |

**Manual payment logic**:
- **Validation**: amount > 0, currency = appointment/service currency (warning if different), `paid_at` not in the future, the customer is in the staff member's scope, and an optional appointment belonging to that customer.
- **Duplicate detection**:
  - Before saving, the API looks for payments for the same customer with the same amount within ±2 days. It checks both manual entries and **Stripe** payments, so a payment recorded by hand that also came through Stripe is caught.
  - Matches are shown as a warning. Saving anyway sets `possible_duplicate_of`, and the payment appears in an admin review list.
- **Edits**:
  - Staff can edit **their own** manual entries on the **same day** (location time zone).
  - After that, only admins can edit.
  - Every change goes to `change_log`.
- **Void / refund**: admin only, with a required reason. A void keeps the record with `status = voided`, and a refund updates `amount_refunded`. Records are never deleted.
- **Allocation**: a payment can be linked to an appointment, and partial payments are allowed. Balances come from `v_customer_balance`, which combines Stripe and manual.
- **Customer visibility**: method, amount, status, date and the Stripe receipt link. For bank transfers, "pending / received". Internal notes, terminal IDs and references are hidden.

### 4.5 Freshdesk integration

- **Auth**: Freshdesk **API key** (Basic auth) in Secrets Manager (`joybot/<env>/freshdesk`). Use a dedicated agent with the least privilege that can still read tickets and contacts. The domain and portal URL are in `core.settings`.
- **Finding a customer's tickets** (by email and phone):
  1. Take the customer's **verified** email and phone. Unverified contacts are never used.
  2. Look up Freshdesk contacts by email (`GET /api/v2/contacts?email=`), then by phone and mobile (`?phone=`, `?mobile=`).
     - Phones are tried in E.164 and the national format, since Freshdesk stores them as free text.
     - Matching contact IDs are cached in `core.external_links` (refreshed every 24 h, or when a contact changes).
  3. Fetch tickets per contact (`GET /api/v2/tickets?requester_id=…&include=description`, with `updated_since` for filters), merge them and remove duplicates.
  4. For ticket detail, fetch the ticket and its conversations, and **drop private notes** (`private: true`) for customer principals.
- **Org admin**: runs the same lookup for each member's verified contacts (bounded, cached).
- **Employees**: run the lookup for any customer in their scope. Organization views combine members' tickets.
- **Ownership filter**: every returned ticket's `requester_id` must be one of the cached contact IDs for the in-scope customer(s). Anything else is dropped and logged.
- **Caching & limits**: ticket lists are cached for 60–120 s per scope. The client respects Freshdesk's per-minute rate limits (backoff on `429` with `Retry-After`) and has a circuit breaker, so chat answers "tickets unavailable right now" instead of failing.
- **Deep links**: customers get `{freshdesk_portal_url}/support/tickets/{id}`; staff get the agent URL.
- **Status mapping**: Freshdesk status codes (Open, Pending, Resolved, Closed, plus custom statuses fetched from the ticket-fields API) are mapped to readable labels.

### 4.6 `app` schema
```
app.conversations(id, principal_type, principal_id, title, active_customer_id, active_organization_id, created_at, updated_at)
app.messages(id, conversation_id, role, content, citations jsonb, tokens_in, tokens_out, latency_ms, created_at)
app.retrieval_traces(id, message_id, principal_type, principal_id, customer_id, organization_id, tool, params jsonb, status, latency_ms, record_ids text[], created_at)
app.stripe_events(event_id pk, type, livemode, created, payload jsonb, received_at, processed_at, status, error)
app.invites(id, token_hash, customer_id null, organization_id null, org_role null, channel, sent_to_hash, expires_at, accepted_at, created_by)
app.link_review_queue(id, cognito_sub, contact_hash, candidate_customer_id, reason, status, resolved_by, resolved_at)
app.message_deliveries(id, channel, template, to_hash, status, provider_message_id, error, created_at)
app.response_cache(key, tool, principal_scope_hash, payload jsonb, expires_at)
```

---

## 5. Backend — NestJS

### 5.1 Modules
| Module | Responsibility |
|---|---|
| `AuthModule` | JWTs from both pools → `Principal` (customer + `org_role`, or employee `admin`/`staff` + locations + time zone) |
| `AccessModule` | CASL abilities from `role_permissions`, assignments, locations, grants; `@Can()` guards; RLS session; "who can access"; admin CRUD for permissions, assignments, grants |
| `SettingsModule` | `core.settings` (incl. **WhatsApp**, Freshdesk domain, payment options) + locations; publishes WhatsApp settings to SSM; time zone resolution |
| `ChatModule` / `ConversationsModule` | SSE chat, conversations, pinned scope |
| `EntityExtractionModule` | *(employees)* Regex (email, phone, customer/org/appointment/payment numbers, **Freshdesk ticket IDs**, Stripe IDs, POS/bank references) + Gemma 4 JSON extraction for names and relative dates |
| `CustomerResolutionModule` | *(employees)* Exact → fuzzy match on customers and organizations, **filtered by ability** |
| `ScopeModule` / `CoreToolsModule` | RLS-scoped transactions; typed read tools (5.3) |
| `FreshdeskModule` | Contact lookup by verified email/phone, ticket list/detail, private-note filtering, ownership filter, cache, rate-limit handling |
| `PaymentsModule` | **Manual payment entry** (validation, duplicate detection, same-day edit rule, void/refund by admin), pending transfers, combined history and balance |
| `StripeModule` | Webhook endpoint, event store, processors, customer matching, unmatched queue, reconciliation job (worker) |
| `RetrievalPlannerModule` / `ContextBuilderModule` / `LlmModule` | Tool catalog per ability, Gemma 4 tool calling + deterministic intents, evidence/citations, vLLM/Ollama providers |
| `BackOfficeModule` | Organizations, customers, services, appointments; invites; merges; link-review queue |
| `ProfileModule` / `OrgAdminModule` | Customer profile & contacts; org admin members and invites |
| `MessagingModule` | Email (SES) and WhatsApp (End User Messaging Social) templates with opt-in checks; delivery log |
| `AuditModule` / `AdminModule` / `HealthModule` | Traces, change log, admin screens, `/health` & `/ready` (DB, model, Freshdesk, Stripe, WhatsApp config) |

### 5.2 Retrieval pipeline (per message)

1. **Principal + ability + time zone**.
2. **Scope**:
   - **Customer**: self, or own organization for an org admin (payments stay self-only).
   - **Employee**: extract, then resolve within the ability. Disambiguate if several match. If the record exists but isn't permitted, say "no access" and log it.
3. **Tool catalog** limited to permitted resources and actions.
4. **Plan** with Gemma 4: local date/time, server-side date parsing, schema-validated arguments, **no model-supplied IDs**.
5. **Execute** in parallel:
   - Core tools are RLS-scoped.
   - Freshdesk calls go through the ownership filter.
   - Timeouts 4 s per tool, 8 s overall; partial results allowed.
6. **Optional second round** (max 2).
7. **Normalize**:
   - Hide `notes_internal`, private Freshdesk notes and manual payment references from customers.
   - Show times in the location's time zone.
8. **Generate** with `[n]` citations and stream; **persist** the message and traces.

### 5.3 Tool catalog

| Tool | Customer | Org admin | Admin / Staff | Notes |
|---|:-:|:-:|:-:|---|
| `get_customer_profile()` | self | self / member | per ability | |
| `list_appointments(...)` / `get_appointment(number)` | self | org | per ability | |
| `list_payments(from?, to?, status?, method?, source?)` / `get_payment(number)` | self | self only | per ability | Stripe + manual combined |
| `get_balance()` | self | self | per ability | |
| `list_pending_bank_transfers(location?, overdue_only?)` | — | — | per ability | |
| `list_unmatched_stripe_payments()` | — | — | per ability | |
| `list_tickets(status?, updated_since?)` / `get_ticket(id)` | self | org | per ability | Freshdesk, by verified email/phone |
| `get_organization()` / `list_organization_members()` | — | own org | per ability | |
| `list_services(...)` / `get_service(code)` | ✓ | ✓ | ✓ | |
| `list_locations()` / `get_location(code)` | ✓ | ✓ | ✓ | |
| `get_my_schedule(from?, to?, location?)` | — | — | ✓ | |
| `search_customers(query)` / `search_organizations(query)` | — | — | per ability | |

### 5.4 API surface (v1)
```
# Chat
GET/POST /api/conversations · GET /api/conversations/:id/messages
POST     /api/conversations/:id/messages        (SSE) · PUT /api/conversations/:id/scope · DELETE /api/conversations/:id

# Customer self-service
GET/PUT  /api/me · POST /api/me/contacts
GET      /api/me/appointments | /api/me/payments | /api/me/tickets | /api/me/tickets/:id
GET      /api/services | /api/locations

# Org admin
GET      /api/org · /api/org/members · /api/org/appointments · /api/org/tickets
POST     /api/org/invites · DELETE /api/org/members/:customerId

# Back-office (admin, staff — @Can + RLS)
GET/POST/PUT /api/organizations[/:id] · /api/customers[/:id]
POST     /api/customers/:id/invite · GET /api/customers/:id/merge-preview?into= · POST /api/customers/:id/merge
GET      /api/duplicates · POST /api/duplicates/dismiss · GET /api/link-reviews?status= · POST /api/link-reviews/:id/resolve
GET/POST/PUT /api/services · /api/appointments
GET      /api/payments?customerId=&source=&status=
POST     /api/payments                          (manual: card_pos | bank_transfer | cash | other)
POST     /api/payments/check-duplicates         (pre-save warning)
PUT      /api/payments/:id                      (manual; same-day rule for staff)
POST     /api/payments/:id/mark-received        (bank transfer → succeeded)
POST     /api/payments/:id/void | /refund       (admin; manual only)
POST     /api/payments/:id/assign               (unmatched Stripe → customer/appointment)
GET      /api/payments/pending-transfers · /api/payments/unmatched-stripe · /api/payments/possible-duplicates
GET      /api/customers/:id/tickets · /api/organizations/:id/tickets
GET      /api/customers/:id/access · /api/organizations/:id/access
GET      /api/review/links · POST /api/review/links/:id/resolve

# Admin
GET/PUT  /api/admin/settings · POST /api/admin/settings/whatsapp/test · POST /api/admin/settings/freshdesk/test
GET/POST/PUT/DELETE /api/admin/locations | users | permissions | assignments | record-grants
POST     /api/admin/stripe/reconcile · GET /api/admin/traces · /api/admin/audit

# Integrations
POST     /api/webhooks/stripe                   (public, Stripe-signed)

GET      /api/health | /api/ready
```

---

## 6. Model Service — Gemma 4

- **Gemma 4 E2B** on one **g6.xlarge** (L4 24 GB), BF16. **E4B fallback** at the same cost if E2B misses the evaluation gates. Optional `g4dn.xlarge` (T4, FP16) benchmark.
- **Container**: vLLM image in **private ECR**; weights from Hugging Face cached in a **private** S3 bucket.
- **Capabilities**: streaming, tool calling, JSON-schema decoding. Deterministic extraction, date parsing and intent rules carry most of the load for E2B.
- **Scaling**: min 1 in prod (2 for availability if budget allows), 0 in dev after hours. Private subnets, Cloud Map. Ollama for local dev. Apache 2.0 license.

---

## 7. Frontend — React + Vite

### Customer portal (`/portal`)
- Sign up / sign in with email, or with phone (**WhatsApp code**, shown only when WhatsApp is enabled in settings). Invite links; profile completion; WhatsApp opt-in toggle.
- **Chat**: appointments, payments (card/online via Stripe, POS, bank transfer pending/received), balance, services, locations, **Freshdesk tickets**.
- **Pages**: My appointments, My payments (with Stripe receipts), **My tickets** (status, public replies, link to the Freshdesk portal), Services & prices, Locations, Profile.
- **Org admin area**: members (invite/remove), members' appointments, organization tickets.

### Staff console (`/staff`)
- Sign in (MFA, optional SSO). UI adapts to **admin** vs **staff** (`@casl/react`).
- Search customers and organizations (access-filtered). Overview pages show appointments, **payments (Stripe + manual)**, balance, tickets, and "who can access".
- **Chat** with scope bar, disambiguation and source cards.
- **Payments**:
  - **Record payment** form with per-method fields (POS reference, bank reference / expected date, cash) and a duplicate warning.
  - Worklists: pending transfers ("mark received"), **unmatched Stripe payments** (assign), possible duplicates (admin).
  - Void/refund (admin).
- **Back-office**: organizations, customers, services, appointments, invites, merges, link review.
- **Admin**:
  - **General settings**: time zone, currency, retention, **WhatsApp number & templates + test**, **Freshdesk domain/portal + test**, Stripe on/off, manual payment methods, transfer due days.
  - Locations, employees (admin/staff), staff permissions, assignments, record grants, restricted flags, audit.

### Stack
**Built:** React 19 + TS, Vite 7, React Router 7, TanStack Query 5, Tailwind 4, `oidc-client-ts` (Cognito code flow + PKCE per audience), CASL rules from `/api/me`, `Intl` for time zones, and Vitest for the SSE parser and chat reducer.

**Planned:** Playwright E2E for customer, org admin, staff and admin.

---

## 8. Infrastructure — CloudFormation Stacks with Quick-Create Links

All infrastructure is written as **plain CloudFormation YAML**. The root template `main.yaml` creates the nested stacks below, and a `Rules` assertion limits deployment to **us-east-1**. Accounts in your **AWS Organization** deploy JoyBot by clicking a **Quick-Create link**. The link opens the CloudFormation console with the template and parameters already filled in. The user reviews them, ticks the IAM capability boxes, and clicks **Create stack**.

### 8.1 Quick-Create links (private, us-east-1, one AWS Organization)

```
https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/quickcreate
  ?templateURL=https://joybot-artifacts-us-east-1.s3.us-east-1.amazonaws.com/v1.2.0/main.yaml
  &stackName=joybot
  &param_EnvironmentName=prod
  &param_ModelVariant=gemma-4-e2b
```

- **Private artifacts bucket** (block all public access; `s3:GetObject` only when `aws:PrincipalOrgID` = your Organization) and **private ECR** with an Organization-scoped pull policy.
- Templates are fetched with the deploying user's credentials, so the link works only inside your Organization.
- Immutable `/vX.Y.Z/` versions + `/latest/`.
- Profiles: **Dev** (sample data, Stripe test mode, GPU scaled to zero after hours, single NAT) and **Prod** (multi-AZ, GPU ≥ 1, WAF, Stripe live).
- Capabilities: `CAPABILITY_IAM`, `CAPABILITY_NAMED_IAM`, `CAPABILITY_AUTO_EXPAND`.

### 8.2 Root template parameters

| Group | Parameter | Default / notes |
|---|---|---|
| General | `EnvironmentName` | `dev` \| `staging` \| `prod` |
| General | `AdminEmail` | Required; first **admin** employee |
| General | `BusinessName` / `DefaultTimeZone` / `DefaultCurrency` | Initial `core.settings` values; editable in Admin |
| Data | `SeedSampleData` | `true` in dev |
| Data | `DbMinAcu` / `DbMaxAcu` | `0.5` / `8` |
| Identity | `CustomerSelfSignUp` | `true` |
| Identity | `EmployeeIdpType` / `EmployeeIdpMetadataUrl` | `none` \| `saml` \| `oidc` |
| Email | `SesFromAddress` | Verified SES identity |
| Freshdesk | `FreshdeskApiKeySecretArn` | Optional existing secret; else a placeholder is created. Domain/portal URL are set in Admin → Settings |
| Stripe | `StripeMode` | `test` (dev) \| `live` (prod) |
| Stripe | `StripeSecretArn` | Optional existing secret `{ restrictedKey, webhookSigningSecret }`; else a placeholder |
| Model | `ModelVariant` | **`gemma-4-e2b`** |
| Model | `GpuInstanceType` | `g6.xlarge` |
| Model | `HuggingFaceToken` | `NoEcho` |
| Model | `GpuMinCapacity` / `GpuScheduleScaleDown` | `0`/`true` dev, `1`/`false` prod |
| Compute | `CpuInstanceTypes` / `CpuMinCapacity` / `CpuMaxCapacity` / `CpuUseSpot` | Dev: `t4g.medium`, 1/2, Spot. Prod: `m7g.large`, 2/6, on-demand |
| Network | `VpcCidr` / `ExistingVpcId` / `ExistingPrivateSubnetIds` | |
| Frontend | `DomainName` / `HostedZoneId` / `CertificateArn` | Optional |
| Security | `EnableWaf` | `false` dev, `true` prod |
| Release | `ArtifactsVersion` / `ArtifactsAccountId` | |

WhatsApp has **no stack parameters**: the number and templates are set in `core.settings`.

### 8.3 Nested stacks

| Template | Resources |
|---|---|
| `network.yaml` | VPC (us-east-1, 2–3 AZs), NAT with Elastic IPs, VPC endpoints (S3, ECR, Secrets Manager, KMS, SSM, Logs, SQS, SES) |
| `data.yaml` | Aurora PostgreSQL Serverless v2 (KMS, PITR, deletion protection in prod), role secrets (`joybot_app`, `joybot_reader`, `joybot_migrator`), **Freshdesk** and **Stripe** secrets (placeholders). Stripe events are queued in Postgres (`app.stripe_events`), not SQS |
| `messaging.yaml` | KMS key for the Cognito Custom SMS sender; **WhatsApp sender Lambda** (reads SSM `/joybot/<env>/whatsapp`; `social-messaging:SendWhatsAppMessage` on `phone-number-id/*` in this account); SSM parameter (initially disabled); SNS topic for delivery events → `app.message_deliveries`; SES configuration set |
| `auth.yaml` | Customers pool (email/phone username, `CustomSMSSender` → WhatsApp Lambda, SES email, passwordless OTP, advanced security in prod); employees pool (MFA, groups `admin`/`staff`, optional SAML/OIDC); post-confirmation Lambda; initial admin |
| `compute.yaml` | ECS cluster, Cloud Map, CPU (Graviton) and GPU capacity providers, SSM-resolved AMIs, IMDSv2, Session Manager |
| `model.yaml` | vLLM (Gemma 4 E2B) on GPU, private weights bucket, scheduled scaling |
| `backend.yaml` | `api` + `worker` services, internal ALB, auto-scaling. Task roles: role secrets, Freshdesk/Stripe secrets, **`ssm:PutParameter` on the WhatsApp parameter** (API only), End User Messaging Social send (invites), SES send. EventBridge schedule for Stripe reconciliation and Freshdesk contact refresh. DB bootstrap custom resource |
| `frontend.yaml` | Private site bucket, CloudFront (OAC + VPC origin), WAF (rate limits on chat, sign-up/sign-in, code resend, invites; `/api/webhooks/stripe` excluded from bot rules, size-limited), asset-deploy custom resource |
| `observability.yaml` | Dashboard: chat latency, tool errors, access denials, WhatsApp sends/failures, **Freshdesk latency/429s**, **Stripe webhook lag / unmatched payments**, pending/overdue transfers, possible duplicates, GPU, DB. Alarms → SNS |

**Root outputs:** `AppUrl`, `CustomerPortalUrl`, `StaffConsoleUrl`, `ApiUrl`, **`StripeWebhookUrl`**, user pool IDs, `DashboardUrl`, `EgressIps` (for a Freshdesk IP allowlist if enabled).

### 8.4 Post-deploy setup (admin checklist)

| Step | Where |
|---|---|
| Stripe: put restricted key + webhook signing secret in the Stripe secret; register `StripeWebhookUrl` in the Stripe Dashboard with the handled events; Admin → Settings → enable Stripe → "Reconcile now" | Secrets Manager, Stripe Dashboard, Admin |
| Freshdesk: put the API key in the Freshdesk secret; Admin → Settings → Freshdesk domain + portal URL → "Test connection" | Secrets Manager, Admin |
| WhatsApp: create a Meta Business account → WhatsApp Business Account + number in **AWS End User Messaging Social** → get templates approved → Admin → Settings → WhatsApp (number ID, templates, language) → "Send test message" → enable | Meta, AWS console, Admin |
| Locations, staff users, staff locations/assignments, services price list | Admin / back-office |

Other deploy concerns: private artifact access (a `preflight` script is planned); asset-deploy and DB-bootstrap custom resources (schema, RLS, seeded permissions, settings row, first location, admin); CloudFront + VPC origin with SSE settings; Aurora snapshot on delete; user pools retained in prod; CI blocks replacement of stateful resources.

### 8.5 Template quality gates
- **Done:** `cfn-lint` plus `check_nested.py`, which checks that every nested-stack parameter is passed.
- **Done (Phase 4):** `cfn-guard` rules in `cloudformation/guard/joybot.guard`, with unit tests for each rule (`tests/joybot_tests.yaml`), run in CI and in `pnpm lint:cfn`. They check: region rule; private, encrypted, TLS-only S3; organization-only sharing; scanned ECR; no wildcard IAM actions or admin policies; encrypted, protected RDS; KMS rotation; SNS encryption; log retention; internal ALB; no open ingress; HTTPS plus WAF on CloudFront; IMDSv2; no privileged containers; no public Lambda.
- **Original list:** `cfn-guard` (encryption, no public S3/ECR, public-access block, no `*` IAM, region rule, prod deletion protection).
- **Planned (Phase 6):** `taskcat` in us-east-1 from a member account. Smoke tests:
  - Customer email sign-up → appointment question.
  - Org admin → org tickets (stubbed Freshdesk).
  - Staff allowed vs denied lookups.
  - Manual bank transfer → mark received → "transfer received".
  - Stripe test webhook → payment visible and matched.

### 8.6 Security baseline
- **Access control**: CASL + RLS from the same tables; admin/staff split; restricted records; expiring grants; "who can access"; audit; matrix tests in CI.
- **Customer isolation**: self-only; org admin limited to members, members' appointments and tickets (no payments). Freshdesk results pass the ownership filter, and private notes are removed.
- **Freshdesk lookup only by verified contacts**. An unverified email or phone could otherwise expose someone else's tickets.
- **Payments**:
  - No card data stored.
  - Stripe webhooks are signature-verified and stored idempotently; the read-only restricted key is used for reconciliation.
  - Manual entries need references and pass validation.
  - Records are never deleted; voids and refunds are admin-only, with a reason.
  - Full `change_log`.
- **WhatsApp**: opt-in required for invites; codes never logged; phone numbers hashed in logs; send throttles and cost alarms.
- **Public users**: WAF rate limits, Cognito advanced security (planned), per-person chat limits (done: questions per rolling 24 hours, set in Admin → Settings).
- **Prompt injection**: chat input, notes and ticket text are untrusted. Tools are read-only with validated arguments; RLS and the ownership filter enforce scope.
- **Compliance**: none for now. Baseline: retention setting, PII out of logs, KMS, TLS, isolated DB, only CloudFront public.

---

## 9. CI/CD & Release

**Status:**
- **Done:** `ci.yml` runs on every PR (typecheck, all tests against a Postgres service, cfn-lint plus the nested-parameter check, Lambda build, image builds). `release.yml` publishes on a `v*.*.*` tag (OIDC role, then `publish.sh`).
- **Not yet:** the automatic deploy to dev, Playwright and `taskcat`. (`cfn-guard` was added in Phase 4.)

1. **PR**:
   - Lint, typecheck, unit tests.
   - DB tests: migrations, **access matrix** (admin/staff/org_admin/customer × scopes, restricted, assignments, grants), RLS isolation, time zones, linking.
   - **CASL ↔ RLS consistency**.
   - **Manual payment rules**: validation, duplicate detection across manual and Stripe, same-day edit, void/refund permissions.
   - **Stripe webhook fixtures**: signature, idempotency, ordering, matching, refunds, disputes.
   - **Freshdesk contract tests**: email/phone lookup, phone formats, private-note filtering, ownership filter, 429 handling.
   - WhatsApp Lambda tests.
   - `cfn-lint` + `cfn-guard`; image builds.
2. **main → dev**: private ECR, artifacts, `aws cloudformation deploy`, Playwright E2E per role, Stripe test-mode webhook smoke test.
3. **Release**: private release ECR and bucket (`/vX.Y.Z/`, `/latest/`), `taskcat` from a member account, then staging → prod with manual approval.

---

## 10. Quality & Evaluation

**Status (v1):** 110 cases in [apps/api/eval/cases.ts](apps/api/eval/cases.ts), run through the real chat API against the seeded data and a Freshdesk stub.
- **Access oracle:** written independently of the RLS rules (`score.ts`). It checks every case's evidence, citations and answer for other customers' data, internal notes, POS or bank references, private Freshdesk notes, members' payments for org admins, and staff-only tools.
- **Evidence-only mode** runs in `pnpm test` and CI. The 97 deterministic cases must all pass; the 13 model-only cases are n/a there.
- **Real-model mode** is `pnpm --filter @joybot/api eval:model` with `MODEL_ENDPOINT`. Only gate failures fail the run. Reports are written to `apps/api/eval/reports/`.
- **Metrics:** tool-selection precision and recall, citation recall, resolution accuracy, and latency.
- **Not yet:** the 200–300 case target, answer faithfulness and number checks scored on real-model output, and a k6 load test.

- **Eval set** (200–300 cases) on seeded data:
  - **Customer questions**:
    - Appointments and balance.
    - **Card (Stripe) vs POS vs bank transfer** payment questions, "was my transfer received?"
    - Ticket status (Freshdesk stub).
    - Attempts to see others' data.
  - **Org admin questions**:
    - Members' appointments and tickets.
    - Members' payments (must be refused).
  - **Staff vs admin questions**:
    - Allowed and denied lookups (other location, unassigned, restricted, expired grant).
    - Pending/overdue transfers, unmatched Stripe payments.
  - **Time zones & DST**; **partial profiles** (phone-only, email-only; ticket lookup by phone).
- **Metrics**: extraction/resolution accuracy, tool selection, faithfulness, numeric/time correctness, citations, **access accuracy 100%**, latency.
- **Release gates**:
  - Zero cross-customer/org leaks.
  - Zero access bypasses.
  - No internal notes, private Freshdesk notes or manual payment references shown to customers.
  - Injection payloads in notes and ticket text have no effect.
- **E2B gate** → E4B fallback; k6 load test on one g6.xlarge.

---

## 11. Phased Roadmap

Status as of 2026-10-09 (`main` after PR #5): ✅ done · 🟡 in progress · ⬜ not started.

| Phase | Status | Deliverables |
|---|---|---|
| **0 — Spike & setup** | ⬜ | E2B vs E4B benchmark. **Create the Meta Business account and start verification** and template approval, which can take days or weeks. A Freshdesk API key and a sandbox or test set of contacts. A Stripe test account and a webhook endpoint in dev |
| **1 — Foundations, data & access** | ✅ | Monorepo; `packages/db` (core tables, admin/staff permissions, assignments, grants, RLS functions, matrix tests); CASL; settings and locations admin; back-office CRUD; **manual payments** (validation, duplicates, same-day edit, void/refund, pending transfers); employee logins kept in sync with Cognito. All nine stacks, private artifacts bootstrap and CI |
| **2 — Chat MVP + Stripe** | ✅ | Streaming chat for customers, org admins and employees: access-filtered resolution, 16 read-only tools, local times, citations, retrieval traces. **Stripe webhooks, the worker, reconciliation and the unmatched queue**, with combined balances. Web portal and staff console |
| **3 — Accounts, WhatsApp, Freshdesk** | ✅ | ✅ Identity linking at sign-up. ✅ Profile completion and contact changes with codes over email or WhatsApp. ✅ Invites. ✅ Org admin area. ✅ **Freshdesk** (lookup, ticket pages, filters, chat tools). ✅ "Who can access" (API and UI). ✅ Duplicate detection, customer merge (tombstones) and link-review queue (API and UI). ✅ Access admin UI: assignments, temporary access (grants), restricted flags, staff permission matrix. ✅ Eval set v1 (110 cases, access gate in CI) |
| **4 — Hardening & staff workspace** | ✅ | ✅ Row-level security on the remaining `app` tables (invites accepted through a single-use function; Stripe events stored append-only). ✅ Per-person chat limits. ✅ `cfn-guard` rules with tests, in CI. ✅ Local Gemma 4 through Ollama in `pnpm dev`, with full model-call logging (`MODEL_DEBUG`, dev only). ✅ Staff home page: today's appointments, customer lookup, payment capture and booking (time entered at the location's zone, double-booking confirmation). ✅ Assistant dock: a prompt bar on every page that opens the conversation in a panel without leaving the page. Open items moved to Phase 5 |
| **5 — Feature refinements** | 🟡 | ✅ Reopened conversations restore the customer or organization the chat is about (scope card), in full view and the dock. ✅ Staff to-dos: a To-dos page (assignee, due date, optional customer, notes) and a pending list with quick add on the home page; new `tasks` permission (staff: own, admin: all). ✅ Customer search matches short name prefixes (each typed word starts a word of the name; fuzzy matching still catches typos). ⬜ Today's appointments across locations in several time zones read in order (show the viewer's time too, or group by location). ⬜ Answer wording and model-only eval cases reviewed against Gemma 4 E2B. ✅ Knowledge for the assistant: saved answers (example questions, approved text, Book/Read buttons) and help articles written in JoyBot (Help pages, searched by passage), with a Knowledge editor and "test a question"; new `knowledge` permission. ✅ Customer self-booking (Book page, requests confirmed or declined on the staff Review page). ⬜ Products and "Buy" buttons. ⬜ Semantic (embedding) search if keyword and fuzzy matching miss too many paraphrases |
| **6 — Pre-launch** | ⬜ | ⬜ Full eval run against Gemma 4 E2B (a 5-case sample passed 4/5). ⬜ First real AWS dev deploy. ⬜ WAF tuning, Cognito advanced security. ⬜ WhatsApp throttles and cost alarms. ⬜ Red-team and injection suite beyond eval v1. ⬜ Observability review. ⬜ Load tests. ⬜ Staging and prod parameters. ⬜ `taskcat`. ⬜ Playwright. ⬜ First private Quick-Create release. ⬜ Prod launch. Later options: Stripe Checkout "pay now" links from JoyBot; guarded write tools in chat (book/reschedule, create Freshdesk ticket); WhatsApp reminders; chat over WhatsApp; CSV import; knowledge base |

### Next steps

1. **Phase 5 feature refinements:** the items in the Phase 5 row, plus refinements found while using the staff home page and the assistant dock.
2. **Run the full eval against Gemma 4 E2B.** Ollama is set up for local runs (`pnpm dev`; `MODEL_DEBUG=true` logs each prompt and answer). Run `pnpm --filter @joybot/api eval:model` (a 5-case sample passed 4/5 so far):
   - Fix any gate failures.
   - Review the model-only cases and answer wording.
   - Grow the set toward 200–300 cases, adding cases from real questions once in use.
3. **Check the real integrations locally:**
   - Stripe test mode with `stripe listen`.
   - A Freshdesk trial account.
   - Cognito hosted sign-in (needs the first deploy, step 5).
4. **Phase 0 items with long lead times.** Start these now:
   - Meta Business verification and WhatsApp template approval (OTP, invite).
   - The SES domain and leaving the SES sandbox.
   - The Freshdesk API key.
5. **First AWS deploy (dev):**
   - Run `bootstrap/artifacts.yaml`, `publish.sh` and the Quick-Create link in a member account.
   - Work through "Things to verify on the first real deployment" in `cloudformation/README.md`: Cognito `SMS_OTP` with a custom sender only, the KMS key policy, DB bootstrap reaching Secrets Manager, the Aurora version, the GPU AMI parameter, and `Authorization` forwarding through the VPC origin.
   - Also check that SSE streams through CloudFront without buffering.
6. **Phase 6 pre-launch hardening:**
   - Playwright E2E per role (customer, org admin, staff, admin).
   - Prompt-injection and red-team suite beyond the eval's 7 injection cases.
   - WAF rule tuning and Cognito advanced security.
   - WhatsApp send throttles and cost alarms.
   - Observability review: dashboards and alarms against real traffic.
   - k6 load test on one g6.xlarge.
   - Staging and prod parameter files, `taskcat` from a member account, and the first private Quick-Create release.

---

## 12. Cost Considerations (rough, validate in Phase 0)

### 12.1 Gemma 4 price list — dedicated hardware

Modeled on the layout of the [Zilliz Cloud dedicated price list](https://zilliz.com/pricing/pricing-guide#vector-database-dedicated): a unit price per hour, a monthly equivalent, two optimization profiles, and separate add-on and data-transfer lines.

> **Provider:** Amazon Web Services · **Region:** us-east-1 · **Unit:** one dedicated GPU instance (single tenant) running vLLM
> **Monthly = hourly × 720** (30 days × 24 h, same convention as Zilliz). Billed per second while running.
> List prices for estimating only. Prices marked * are **estimates**: the 1-yr/3-yr discount measured on g6.xlarge (−35% / −54%) applied to the other sizes.

**Selected: Gemma 4 E2B on g6.xlarge**:
- **Prod**: ~$377/month per instance on a 1-yr commitment, or ~$579 on-demand. ×2 for high availability.
- **Dev**: ~$177/month with after-hours scale-down.

#### Hardware unit prices

| Hardware | GPU (memory) | On-demand | 1-yr commit (no upfront) | 3-yr commit (no upfront) |
|---|---|---|---|---|
| **g6.xlarge** | 1× L4 (24 GB) | $0.805 / h · **$579 / mo** | $0.524 / h · **$377 / mo** | $0.369 / h · **$266 / mo** |
| **g6e.xlarge** | 1× L40S (48 GB) | $1.861 / h · **$1,340 / mo** | $1.21 / h* · **$872 / mo*** | $0.85 / h* · **$615 / mo*** |
| **g6.12xlarge** | 4× L4 (96 GB) | $4.602 / h · **$3,313 / mo** | $3.00 / h* · **$2,157 / mo*** | $2.11 / h* · **$1,521 / mo*** |
| **g6e.12xlarge** | 4× L40S (192 GB) | $10.493 / h · **$7,555 / mo** | $6.83 / h* · **$4,918 / mo*** | $4.82 / h* · **$3,468 / mo*** |

#### Gemma 4 variants — monthly price per dedicated instance

| Variant | Architecture | Profile | Precision | Hardware | Concurrency headroom | On-demand / mo | 1-yr / mo | 3-yr / mo |
|---|---|---|---|---|---|---|---|---|
| **E2B** ✅ selected | Edge, ~2B effective | Cost | BF16 | g6.xlarge | High | $579 | $377 | $266 |
| | | Performance | BF16 | g6.xlarge | High | $579 | $377 | $266 |
| **E4B** (fallback) | Edge, ~4B effective | Cost | FP8 | g6.xlarge | High | $579 | $377 | $266 |
| | | Performance | BF16 | g6.xlarge | Medium | $579 | $377 | $266 |
| **12B** | Unified multimodal | Cost | FP8 | g6.xlarge | Medium | $579 | $377 | $266 |
| | | Performance | BF16 | g6e.xlarge | High | $1,340 | $872* | $615* |
| **26B A4B** | MoE, ~25B total / ~4B active | Cost | 4-bit (AWQ) | g6.xlarge | Medium | $579 | $377 | $266 |
| | | Performance | FP8 | g6e.xlarge | High | $1,340 | $872* | $615* |
| **31B** | Dense | Cost | FP8 | g6e.xlarge | Low | $1,340 | $872* | $615* |
| | | Performance | BF16 (4-GPU tensor parallel) | g6.12xlarge | Medium | $3,313 | $2,157* | $1,521* |

#### Add-ons & data transfer
- **Add-ons per instance**: EBS gp3 for E2B is ~$8/mo; the S3 weights cache is under $1/mo; CloudWatch is ~$10–20/mo.
- **Data transfer**:
  - API ↔ model traffic is $0 in the same AZ, and $0.01/GB across AZs (under $1/mo).
  - The one-time weights download costs cents in NAT processing.
  - Private ECR and artifacts within us-east-1 are $0.

#### Other providers (for comparison)
- **24 GB class**: Hetzner GEX44 ~$240/mo · GCP g2-standard-4 1-yr ~$476/mo · Scaleway L4 ~$590–660/mo.
- **48 GB class**: Vultr L40S 36-mo prepaid ~$619/mo · Hetzner GEX130 ~$1,110/mo.
- These would move PII outside AWS.

### 12.2 Other cost notes
- **GPU**: ~$377–579/month per instance in prod.
- **WhatsApp**: per message (Meta fee by country and category + AWS End User Messaging Social fee). Roughly **$0.01–0.03 per OTP/invite in the US**; confirm on the AWS and Meta pricing pages. No SMS costs.
- **Stripe**: Stripe's processing fees on Stripe payments; webhooks and API reads are free. Manual payments have no JoyBot cost.
- **Freshdesk**: API included in the plan; mind the per-minute rate limits for your plan tier.
- **SES**: ~$0.10 per 1,000 emails.
- **Cognito**: per MAU; passwordless OTP needs the Essentials tier.
- **CPU tier**: Graviton, Spot in dev. **Aurora**: 0.5 ACU min in dev, 1+ in prod. Single NAT in dev; VPC endpoints.

---

## 13. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Access-control bug** | CASL + RLS from the same tables; matrix + consistency tests; "who can access"; audit; 100% access-accuracy release gate |
| **Freshdesk shows someone else's tickets** (shared or wrong email/phone) | Only **verified** contacts used; ownership filter on `requester_id`; read-only key; private notes removed; mismatch logging; staff can exclude a contact ID from a customer's links |
| **Freshdesk phone matching misses** (free-text phones) | Try E.164 + national formats + mobile field; cached contact IDs; email lookup as primary |
| **Freshdesk rate limits / outages** | Cache, backoff on 429, circuit breaker, "tickets unavailable" message |
| **Double-counted payments** (manual entry + Stripe for the same payment) | Pre-save duplicate check across sources; `possible_duplicate_of` review list; admin void |
| **Manual entry errors** (wrong amount/customer, missed transfer) | Required references, validation, same-day edit window, admin-only void/refund, pending-transfer worklist, `change_log` |
| **Missed / out-of-order Stripe webhooks** | Idempotent store, ordering by `created`, nightly reconciliation, lag alarms, unmatched queue |
| **WhatsApp onboarding delays** (no Meta account yet) | Start in Phase 0; email works meanwhile; WhatsApp turns on from settings without redeploy |
| **Wrong WhatsApp settings** (bad number ID or template) | Validation + "send test message" before enabling; delivery-failure alarms; falls back to "use email" |
| **WhatsApp cost abuse** | Throttles per phone/IP, WAF, Cognito advanced security, cost alarms |
| **E2B too weak** | Deterministic paths; eval gate; E4B fallback at the same cost |
| **Account linking hijack / duplicates** | Verified contacts or invite tokens; review queue; merge with audit |
| **Wrong times** | UTC storage, IANA zones, server-side parsing, zone labels, DST tests |
| Data loss, private distribution misconfiguration, EC2/GPU operations, stateful resource replacement | PITR + snapshots + restore drills; `preflight` + `taskcat` from a member account; SSM AMIs + instance refresh; CI change-set checks |

---

## 14. Decisions

| Topic | Decision |
|---|---|
| Payments | **Stripe (synced automatically) + manual payments** (POS terminal, bank transfer, cash) in one table, with validation, cross-source duplicate detection, same-day edit window, admin-only void/refund |
| Organizations | One person per customer record; `organizations` group customers; **org admin** role; no organization billing |
| Sign-up | **Email or phone** login; records filled in over time by employees or self sign-up |
| Phone messaging | **WhatsApp** via AWS End User Messaging Social; **number and templates configured in `core.settings`** (no Meta account yet; setup in Phase 0) |
| Locations & time zones | Multiple locations, a time zone per location; defaults in `core.settings` |
| Services | Generic price list; no subscriptions |
| Employee roles | **Admin and staff only**, with record- and organization-level access control (location scope, assignments, restricted records, grants) |
| Support tickets | **Freshdesk only**, looked up by the customer's **verified email and phone**; customers see their own tickets, org admins see their organization's |
| Model | **Gemma 4 E2B**, E4B fallback |
| Existing data / compliance | None to migrate; no compliance regime for now |
| Region & distribution | **us-east-1**, one **AWS Organization**, private S3 + ECR, no public buckets or data |

No open questions remain. Phase 0 will validate the E2B benchmark, Meta/WhatsApp approval timelines, and the Freshdesk phone formats in your account.

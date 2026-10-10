# CLAUDE.md

JoyBot AI is a chatbot for customers and employees. Its own Postgres database is the source of truth, and it uses Gemma 4 for chat. The design is in [plan.md](plan.md), with the roadmap and next steps in §11. Setup is in [README.md](README.md).

## Commands

```bash
pnpm db:up && pnpm db:reset   # Postgres 16 on :5433 (docker compose), migrate + seed
pnpm test                     # all packages, sequential; API test files reset the DB themselves
pnpm typecheck                # builds packages/* first, then tsc everywhere
pnpm lint:cfn                 # cfn-lint + cloudformation/scripts/check_nested.py
pnpm dev                      # db:up + package build + every dev:* script in parallel (api, worker, web, freshdesk stub, ollama)
pnpm dev:api | dev:worker | dev:web | dev:freshdesk | dev:model
pnpm --filter @joybot/api exec vitest run test/profile.test.ts   # one file
pnpm --filter @joybot/api eval        # chat eval (evidence-only); eval:model uses MODEL_ENDPOINT
```

- Preview servers are in `.claude/launch.json`: api on 3000, web on 5173, and fake-freshdesk on 4010.
- The local `.env` is git-ignored. Copy it from `.env.example`.
- The tool versions are pnpm 12, Node 22+, TypeScript 5.9, Vitest 3, NestJS 11, React 19, Vite 7 and Tailwind 4.

## Layout

| Path | What |
|---|---|
| `packages/db` | SQL migrations `migrations/NNNN_*.sql` (forward-only, run by `src/migrate.ts`), `src/scope.ts` (`withPrincipal`/`withSystem`), `src/seed.ts` (`SAMPLE` ids) |
| `packages/access` | CASL `buildAccess` / `packRules`, shared by the API and web app |
| `apps/api` | NestJS: one folder per feature (`chat/`, `payments/`, `stripe/`, `freshdesk/`, `profile/`, `admin/`, …), plus `auth/` guards and `config/config.ts` (Zod) |
| `apps/worker` | Poll loop: Stripe events (`app.stripe_events`), reconciliation, `app.worker_jobs` |
| `apps/web` | Portal (`routes/portal`), staff console (`routes/staff`), `lib/` (auth, api, sse, chat-state, ability) |
| `cloudformation` | `main.yaml`, plus nested `stacks/`, Lambda `functions/` (its own pnpm package), `scripts/` and `bootstrap/artifacts.yaml` |
| `services/model-server` | vLLM image for `google/gemma-4-E2B-it` |
| `tools/fake-freshdesk.mjs` | Local Freshdesk stub |

## Conventions

### Database and access
- **Every query runs as a principal.** In the API, use `DbService.as(principal, fn)` (or `read` for chat). It sets `app.principal_type`/`app.principal_id`/`app.via` in a transaction, and RLS does the rest. Use `withSystem` only for worker or trigger paths.
- **Access rules live in SQL.** They are the `authz.*` SECURITY DEFINER functions plus RLS policies. The API adds coarse checks with `@Can(action, resource)`, `@EmployeesOnly` and `@CustomersOnly`. The role always comes from the database (`authz.principal_role()`) and never from the token. When adding a resource, add the RLS policies, the `role_permissions` rows and the CASL mapping together.
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
- **External services:**
  - Clients are injectable tokens (`JWT_VERIFIERS`, `EMPLOYEE_LOGINS`, `CUSTOMER_LOGINS`, `LLM_PROVIDER`, `MESSAGE_SENDER`), so tests can override them.
  - In dev, messages are logged rather than sent.

### Product constraints from the owner
- us-east-1 only, with one AWS Organization.
- No public buckets, images or data; artifacts are shared through `aws:PrincipalOrgID`.
- WhatsApp instead of SMS. The number and templates live in `core.settings`, not in stack parameters.
- Freshdesk is the only ticket source. It's queried by **verified** email or phone only.
- Employee roles are admin and staff. Customers can be org admins. There's no org billing and no compliance scope for now.
- The model is Gemma 4 E2B, the cheapest variant.

## Tests

- **Setup:** Vitest. The API uses a TypeScript-transpile plugin for decorator metadata, because SWC's native binary fails macOS code-signing.
- **API tests:**
  - `test/app.ts` provides `createApp({ env, overrides })` and `api(app, employee(id) | customer(id))`.
  - `test/reset-db.ts` resets the database before each file.
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
- Not verified against real services yet: Cognito hosted sign-in, Stripe test mode, a real Freshdesk account, Gemma through vLLM or Ollama, and an actual AWS deploy. The checklist is in `cloudformation/README.md`.

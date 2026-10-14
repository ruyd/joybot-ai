# CLAUDE.md

JoyBot AI is a chatbot for customers and employees. Its own Postgres database is the source of truth, and chat uses Gemma 4 E2B. Design and roadmap: [plan.md](plan.md) (§11). Setup: [README.md](README.md). **Before changing email, video calls, the website, sales calls, MCP, appointment types, merged customers, tickets or Supabase Auth, read that area's section in [docs/features.md](docs/features.md).**

## Workflow

- Never commit to `main`. Use one feature branch per change, then a PR and merge. Commit only when asked.
- Never print secret values. `.env` and `.env.*.local` are git-ignored; check them by key name only.

## Commands

```bash
pnpm db:up && pnpm db:reset   # Postgres 16 on :5433 (docker), migrate + seed; db:migrate / db:seed separately
pnpm test                     # every package in turn, each on its own test databases (never the .env dev database)
pnpm typecheck                # builds packages/* first, then tsc everywhere
pnpm lint:cfn                 # cfn-lint + check_nested.py + cfn-guard
pnpm dev                      # db:up + package build + every dev:* script (api, worker, web, model)
pnpm --filter @joybot/api exec vitest run test/profile.test.ts   # one file
pnpm --filter @joybot/api eval        # chat eval (evidence-only); eval:model uses MODEL_ENDPOINT
```

- Preview servers (`.claude/launch.json`): api on 3000, web on 5173. Copy `.env` from `.env.example`.
- Versions: pnpm 12, Node 22+, TypeScript 5.9, Vitest 3, NestJS 11, React 19, Vite 7, Tailwind 4.

## Layout

| Path | What |
|---|---|
| `packages/db` | `migrations/NNNN_*.sql` (run by `src/migrate.ts`), `src/scope.ts` (`withPrincipal`/`withSystem`), `src/seed.ts` (`SAMPLE` ids), `src/testing.ts` |
| `packages/access` | CASL `buildAccess` / `packRules`, shared by the API and web |
| `apps/api` | NestJS, one folder per feature, plus `auth/` guards and `config/config.ts` (Zod) |
| `apps/worker` | Poll loop: Stripe events (`app.stripe_events`), reconciliation, `app.worker_jobs` |
| `apps/web` | `routes/portal`, `routes/staff`, `routes/site` (public website), `lib/` (auth, api, sse, chat-state, ability) |
| `cloudformation` | AWS: `main.yaml`, nested `stacks/`, Lambda `functions/` (own pnpm package), `scripts/`, `guard/`, `bootstrap/` |
| `deploy`, `render.yaml` | Free-tier deploy (Render + Supabase + Cloudflare Pages), [docs/deploy-free.md](docs/deploy-free.md) |
| `.github/workflows` | `ci.yml`, `release.yml` (AWS), `deploy-free.yml` |
| `services/model-server` | vLLM image for `google/gemma-4-E2B-it` |

## Conventions

### Database and access
- **Every query runs as a principal.** In the API, use `DbService.as(principal, fn)` (`read` for chat). It sets `app.principal_type` / `app.principal_id` / `app.via` in a transaction, and RLS does the rest. `withSystem` is only for worker or trigger paths.
- **Access rules live in SQL**: `authz.*` SECURITY DEFINER functions plus RLS policies. The API adds coarse checks with `@Can(action, resource)`, `@EmployeesOnly` and `@CustomersOnly`. The role always comes from the database (`authz.principal_role()`), never from the token. A new resource needs RLS policies, `role_permissions` rows and the CASL mapping together.
- **Migrations are forward-only.** Add the next numbered file; never edit an applied one. RLS is enabled but not forced, so the owner (`joybot_migrator`) bypasses it.
- **Roles:** `joybot_app` is the API (RLS enforced), `joybot_reader` is chat (SELECT only), and `joybot_worker` has system access through the `worker_all` policies.

### API and web
- **No ORM.** Use `pg` with hand-written SQL. Request bodies use Zod `.strict()` schemas through `ZodPipe`.
- **Errors:** `AppExceptionFilter` maps Postgres errors to HTTP (42501 → 403, 23505 → 409, 23514 → 400).
- **Dates:** `DATE` columns come back as `YYYY-MM-DD` strings, and the web app parses them as local dates. `timestamptz` values are shown in the location, person or settings time zone.
- **Config:** an empty env string means unset (CloudFormation passes `''`). Wrap optional settings with `optional()`.
- **Body limits** (`src/setup.ts`): 100 kB, except `/api/website` (2 MB) and `/api/mcp` (8 MB).
- **Chat:** the model never supplies IDs; tools take IDs that were already resolved and allowed. Record text goes into the prompt as delimited data. Every lookup is written to `app.retrieval_traces`. Saved answers and article passages (`knowledge/`) are searched for every question and cited like records. Buttons come only from them, never from the model.
- **Secrets and contact codes:** store only sha256 hashes of tokens and codes, mask contacts in responses, and never log codes.
- **Third-party keys** the app uses (Resend, Google) are encrypted with `SecretBox` (AES-256-GCM, `SETTINGS_ENCRYPTION_KEY`) in tables without grants or audit, reached only through SECURITY DEFINER functions, and never returned to the browser (show the last four characters).
- **External clients are injectable tokens** (`JWT_VERIFIERS`, `SUPABASE_TOKENS`, `SUPABASE_HTTP`, `EMPLOYEE_LOGINS`, `CUSTOMER_LOGINS`, `LLM_PROVIDER`, `MESSAGE_SENDER`, `RESEND_HTTP`, `GOOGLE_HTTP`), so tests can override them. In dev, messages are logged rather than sent.

### Product constraints from the owner
- AWS: us-east-1 only, one AWS Organization. No public buckets, images or data there; artifacts are shared through `aws:PrincipalOrgID`.
- WhatsApp instead of SMS. The number and templates live in `core.settings`, not stack parameters.
- Employee roles are admin and staff. Customers can be org admins. No org billing and no compliance scope for now.

## Tests

- Vitest. The API uses a TypeScript-transpile plugin for decorator metadata, because SWC's native binary fails macOS code-signing.
- API: `test/app.ts` provides `createApp({ env, overrides })` and `api(app, employee(id) | customer(id))`. `test/global-setup.ts` builds a migrated, seeded `<db>_test_template` once. Each file gets its own copy (`test/reset-db.ts`), so files run in parallel. `db` and `worker` use one seeded database each.
- Roles are cluster-wide: tests must not change them. Tests must pass with `--sequence.shuffle.files`, so restore any shared setting in `afterAll`.
- **Chat changes:** add or adjust cases in `apps/api/eval/cases.ts`. Every case runs through the access oracle in `eval/score.ts`. Update the oracle when the seed changes; never loosen it to make a case pass.
- **New data paths:** test the access matrix, allowed and denied, with the `SAMPLE` principals.

## Gotchas

- Postgres rejects **unused** `$n` parameters in dynamic SQL.
- STABLE security-definer lookups can't see rows inserted by the same statement, so `INSERT … RETURNING` relies on the `sel_own_created` policies.
- Zod's `discriminatedUnion` doesn't accept refined members; use `superRefine` on the union.
- `Intl.DateTimeFormat` throws when `dateStyle`/`timeStyle` are combined with `timeZoneName`.
- CloudFormation: no YAML anchors; ASCII only in security group descriptions; every nested-stack parameter must be passed (`check_nested.py`).
- Dockerfiles copy every workspace `package.json` (`--frozen-lockfile` needs them all). The RDS CA bundle lives in `/opt/rds`.
- Not yet verified against real services: Cognito hosted sign-in, Stripe test mode, Gemma through vLLM or Ollama, and an AWS deploy (`cloudformation/README.md`). Supabase Google sign-in is verified.

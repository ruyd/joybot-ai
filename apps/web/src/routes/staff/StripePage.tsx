import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Page } from '../../components/Layout';
import { Button, Card, ErrorBanner, Field, Input, PageHeader, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { apiUrl } from '../../lib/config';
import { dateTime } from '../../lib/format';

interface SavedSecret {
  last4: string | null;
  set_at: string | null;
  set_by_name: string | null;
  /** Where the one in use comes from: saved here, the server's environment / Secrets Manager, or none. */
  source: 'settings' | 'server' | null;
}

interface StripeStatus {
  events: { status: string; count: number }[];
  unmatchedPayments: number;
  lastReconcile: { status: string; finished_at: string | null; result: Record<string, unknown> | null } | null;
  encryption_available: boolean;
  api_key: SavedSecret;
  webhook_secret: SavedSecret;
}

/** The events the worker applies (apps/worker/src/stripe/apply.ts): what to select on the webhook endpoint. */
const WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.processing',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.succeeded',
  'charge.updated',
  'charge.refunded',
  'charge.failed',
  'charge.dispute.created',
  'charge.dispute.closed',
];

const linkButton =
  'press inline-flex w-fit items-center gap-1.5 rounded-full border border-slate-300 px-3.5 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50 dark:border-slate-700 dark:text-brand-600 dark:hover:bg-slate-800';

/** Settings › Stripe: the API key, the webhook (address and signing secret), and the sync with its health. */
export function StripePage() {
  const api = useApi();
  const q = useQuery({ queryKey: ['stripe-status'], queryFn: () => api.get<StripeStatus>('/admin/stripe/status'), refetchInterval: 15_000 });
  return (
    <Page>
      <PageHeader title="Stripe" description="Card payments for invoices, and Stripe payments matched to customers." />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBanner error={q.error} />
      ) : q.data ? (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <div className="grid min-w-0 gap-4">
            <Card title="API key">
              <div className="grid gap-3 text-sm">
                <p className="text-slate-600 dark:text-slate-300">
                  Used to take card payments for invoices and to reconcile Stripe payments. Best a restricted key with write access to Checkout Sessions and read access
                  to PaymentIntents and Charges. It is stored encrypted and never shown again.
                </p>
                <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noreferrer" className={linkButton}>
                  Open API keys in Stripe <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
                <SecretField status={q.data} kind="api_key" label="Stripe API key" placeholder="rk_live_…" />
              </div>
            </Card>
            <WebhookCard status={q.data} />
          </div>
          <SyncCard status={q.data} />
        </div>
      ) : null}
    </Page>
  );
}

function WebhookCard({ status }: { status: StripeStatus }) {
  const endpoint = apiUrl('/webhooks/stripe');
  const [copied, setCopied] = useState(false);
  return (
    <Card title="Webhook">
      <div className="grid gap-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          Stripe tells JoyBot about payments, refunds and disputes as they happen. In Stripe, add an endpoint with this address and these events, then paste its signing
          secret here.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-slate-100 px-2 py-1.5 text-xs dark:bg-slate-800">{endpoint}</code>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() =>
              void navigator.clipboard.writeText(endpoint).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <details className="text-slate-600 dark:text-slate-300">
          <summary className="cursor-pointer font-medium">Events to send ({WEBHOOK_EVENTS.length})</summary>
          <ul className="mt-2 grid gap-1 font-mono text-xs sm:grid-cols-2">
            {WEBHOOK_EVENTS.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </details>
        <a href="https://dashboard.stripe.com/webhooks" target="_blank" rel="noreferrer" className={linkButton}>
          Open webhooks in Stripe <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
        <SecretField status={status} kind="webhook_secret" label="Signing secret" placeholder="whsec_…" />
      </div>
    </Card>
  );
}

/** A secret saved encrypted (shown as its last four characters), with Replace and Remove. */
function SecretField({ status, kind, label, placeholder }: { status: StripeStatus; kind: 'api_key' | 'webhook_secret'; label: string; placeholder: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const path = kind === 'api_key' ? '/admin/stripe/api-key' : '/admin/stripe/webhook-secret';
  const done = (data: StripeStatus) => queryClient.setQueryData(['stripe-status'], data);
  const save = useMutation({
    mutationFn: () => api.put<StripeStatus>(path, { [kind]: value.trim() }),
    onSuccess: (data) => {
      done(data);
      setValue('');
      setReplacing(false);
    },
  });
  const remove = useMutation({ mutationFn: () => api.del(path).then(() => api.get<StripeStatus>('/admin/stripe/status')), onSuccess: done });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const s = status[kind];

  return (
    <>
      {s.source === 'server' && !s.last4 && (
        <p role="status" className="rounded-lg bg-slate-50 p-3 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          The server has one configured. One saved here is used instead.
        </p>
      )}
      {!status.encryption_available && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          SETTINGS_ENCRYPTION_KEY is not set on the server, so secrets cannot be stored yet.
        </p>
      )}
      {s.last4 && !replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{label}</span>
          <code className="rounded-md bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">••••••••{s.last4}</code>
          <span className="text-xs text-slate-500">
            saved {s.set_at ? dateTime(s.set_at) : ''}
            {s.set_by_name ? ` by ${s.set_by_name}` : ''}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={remove.isPending} onClick={() => window.confirm(`Remove the ${label.toLowerCase()}?`) && remove.mutate()}>
            Remove
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-48">
            <Field label={label}>
              <Input type="password" autoComplete="off" spellCheck={false} placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" disabled={!value.trim() || save.isPending || !status.encryption_available}>
            Save
          </Button>
          {replacing && (
            <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
              Keep the current one
            </Button>
          )}
        </form>
      )}
      {(save.error || remove.error) && <ErrorBanner error={save.error ?? remove.error} />}
    </>
  );
}

/** The sync switch (moved here from Settings › General), its health, and Reconcile now. */
function SyncCard({ status }: { status: StripeStatus }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SyncSettings>('/settings') });
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.put('/admin/settings', { stripe_enabled: on }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
  const reconcile = useMutation({ mutationFn: () => api.post('/admin/stripe/reconcile', {}), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['stripe-status'] }) });
  const on = toggle.isPending ? toggle.variables : settings.data?.stripe_enabled;

  return (
    <Card
      title="Sync"
      actions={
        <Button size="sm" variant="secondary" disabled={reconcile.isPending || !on} onClick={() => reconcile.mutate()}>
          Reconcile now
        </Button>
      }
    >
      <div className="grid gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="switch" checked={Boolean(on)} disabled={!settings.data || toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} /> Stripe sync
          enabled
        </label>
        <p className="text-slate-600 dark:text-slate-300">
          Applies Stripe's payment events as they arrive, and reconciles on a schedule in case any were missed, matching payments to customers.
        </p>
        {settings.data && <ScheduleForm settings={settings.data} />}
        <dl className="grid grid-cols-2 gap-y-2">
          {status.events.map((e) => (
            <div key={e.status} className="contents">
              <dt className="text-slate-500">Events {e.status}</dt>
              <dd>{e.count}</dd>
            </div>
          ))}
          <dt className="text-slate-500">Unmatched payments</dt>
          <dd>{status.unmatchedPayments}</dd>
          <dt className="text-slate-500">Last reconcile</dt>
          <dd>
            {status.lastReconcile ? `${status.lastReconcile.status}${status.lastReconcile.finished_at ? ` · ${dateTime(status.lastReconcile.finished_at)}` : ''}` : 'never'}
          </dd>
        </dl>
        {(toggle.error || reconcile.error) && <ErrorBanner error={toggle.error ?? reconcile.error} />}
      </div>
    </Card>
  );
}

interface SyncSettings {
  stripe_enabled: boolean;
  stripe_reconcile_interval_hours: number;
  stripe_reconcile_days: number;
}

/** How often the worker reconciles on its own, and how many days back (also what Reconcile now checks). */
function ScheduleForm({ settings }: { settings: SyncSettings }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [hours, setHours] = useState(String(settings.stripe_reconcile_interval_hours));
  const [days, setDays] = useState(String(settings.stripe_reconcile_days));
  const save = useMutation({
    mutationFn: () => api.put('/admin/settings', { stripe_reconcile_interval_hours: Number(hours), stripe_reconcile_days: Number(days) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
  const changed = Number(hours) !== settings.stripe_reconcile_interval_hours || Number(days) !== settings.stripe_reconcile_days;
  return (
    <form
      className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Reconcile every (hours, 1–168)">
        <Input type="number" required min={1} max={168} value={hours} onChange={(e) => setHours(e.target.value)} />
      </Field>
      <Field label="Days to check back (1–90)">
        <Input type="number" required min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />
      </Field>
      <Button type="submit" variant="secondary" disabled={!changed || save.isPending}>
        Save
      </Button>
      {save.error && (
        <div className="sm:col-span-3">
          <ErrorBanner error={save.error} />
        </div>
      )}
    </form>
  );
}
